#!/usr/bin/env bash
# Restore a customer account on a fresh VPS.
#
# Usage:
#   recover.sh <account-id> <github-owner>/<repo-name> [<local-path>]
#
# Examples:
#   recover.sh zumi-x zumizumi-3/zumi-x-ops
#   recover.sh tanaka-x tanaka-kun/tanaka-x-ops /srv/mex/tanaka-x-ops
#
# What it does (idempotent, re-runnable):
#   1. Clones or fast-forwards the account_repo from GitHub.
#   2. Fills in missing knowledge skeleton files from templates/account-starter.
#   3. Regenerates AGENTS.md / CLAUDE.md / etc. from account.json.
#   4. Provisions /etc/mex/<account>.env.
#   5. Upserts /var/lib/mex-next/accounts-registry.json.
#   6. Reinstalls systemd units and timers.
#   7. Starts mex-bot and timers.

set -euo pipefail

# ------------------------------------------------------------------ helpers
log()    { echo ""; echo "[$(date -Iseconds)] ▶ $*"; }
ok()     { echo "  ✅ $*"; }
warn()   { echo "  ⚠  $*"; }
fail()   { echo "  ❌ $*" >&2; exit 1; }
have()   { command -v "$1" >/dev/null 2>&1; }
prompt() { read -rp "  ❯ $1 " "$2" </dev/tty; }
prompt_secret() { read -rsp "  ❯ $1 " "$2" </dev/tty; echo; }
prompt_default() {
    local label="$1"
    local default="$2"
    local var_name="$3"
    local answer
    read -rp "  ❯ ${label} [${default}] " answer </dev/tty
    printf -v "$var_name" '%s' "${answer:-$default}"
}
confirm() {
    local label="$1"
    local default="${2:-n}"
    local answer suffix
    suffix="[y/N]"
    if [[ "$default" =~ ^[Yy]$|^[Yy][Ee][Ss]$ ]]; then
        suffix="[Y/n]"
    fi
    read -rp "  ❯ ${label} ${suffix} " answer </dev/tty
    answer="${answer:-$default}"
    [[ "$answer" =~ ^[Yy]$|^[Yy][Ee][Ss]$ ]]
}

usage() {
    cat <<'EOF'
Usage:
  recover.sh <account-id> <github-owner>/<repo-name> [<local-path>]

Examples:
  recover.sh zumi-x zumizumi-3/zumi-x-ops
  recover.sh tanaka-x tanaka-kun/tanaka-x-ops /srv/mex/tanaka-x-ops
EOF
}

upsert_env_var() {
    local key="$1"
    local value="$2"
    mkdir -p "$(dirname "$ENV_FILE")"
    [ -f "$ENV_FILE" ] || : > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    if grep -qE "^${key}=" "$ENV_FILE"; then
        sed -i "/^${key}=/d" "$ENV_FILE"
    fi
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
}

source_env_file() {
    [ -f "$ENV_FILE" ] || return 0
    # shellcheck disable=SC1090
    set -a; source "$ENV_FILE"; set +a
}

render_template() {
    local src="$1"
    local dst="$2"
    local tmp account_repo_escaped
    [ -f "$src" ] || fail "template がありません: $src"
    account_repo_escaped="${ACCOUNT_REPO//\\/\\\\}"
    account_repo_escaped="${account_repo_escaped//&/\\&}"
    tmp="$(mktemp)"
    sed \
        -e "s|{ACCOUNT_ID}|${ACCOUNT_ID}|g" \
        -e "s|{ACCOUNT_REPO}|${account_repo_escaped}|g" \
        "$src" > "$tmp"
    mv "$tmp" "$dst"
    ok "$(basename "$dst") 配置"
}

# ------------------------------------------------------------------ args
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
    usage
    exit 0
fi

[ "$#" -ge 2 ] && [ "$#" -le 3 ] || { usage >&2; exit 2; }

ACCOUNT_ID="$1"
REPO_FULL="$2"
LOCAL_PATH_ARG="${3:-}"

if [[ ! "$ACCOUNT_ID" =~ ^[a-z][a-z0-9-]*$ ]]; then
    fail "account-id は英小文字 + 数字 + ハイフンのみ (先頭は英字)"
fi
if [[ ! "$REPO_FULL" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    fail "GitHub repo は <owner>/<repo> 形式で指定してください: $REPO_FULL"
fi
if [ "$EUID" -ne 0 ]; then
    fail "root として実行してください (/srv /etc/systemd /var/lib を更新します)"
fi

MEX_NEXT_DIR="${MEX_NEXT_DIR:-/opt/mex-next}"
ACCOUNT_REPO="${MEX_ACCOUNT_REPO:-${LOCAL_PATH_ARG:-/srv/mex/${ACCOUNT_ID}-ops}}"
STARTER_DIR="${MEX_NEXT_DIR}/templates/account-starter"
RUNTIME_DIR="/var/lib/mex-next"
REGISTRY_PATH="${RUNTIME_DIR}/accounts-registry.json"
ENV_FILE="/etc/mex/${ACCOUNT_ID}.env"
DOPPLER_PROJECT="xops-${ACCOUNT_ID}"
DOPPLER_CONFIG="prd"

CH_ATTENTION=""
CH_PASSIVE=""
CH_OPERATOR=""

# ============================================================================
# [1/8] preflight
# ============================================================================
step_preflight() {
    log "[1/8] 事前確認"
    [ -d "$MEX_NEXT_DIR" ] || fail "$MEX_NEXT_DIR がありません。先に scripts/install.sh を実行してください"
    [ -d "$MEX_NEXT_DIR/.git" ] || warn "$MEX_NEXT_DIR は git repo ではありません (続行)"
    [ -d "$STARTER_DIR" ] || fail "starter template がありません: $STARTER_DIR"
    [ -f "$MEX_NEXT_DIR/dist/scripts/regenerate-knowledge.js" ] \
        || fail "dist/scripts/regenerate-knowledge.js がありません。/opt/mex-next で npm run build を実行してください"
    have git || fail "git CLI が必要です"
    have gh || fail "gh CLI が必要です (install.sh が install します)"
    have jq || fail "jq が必要です: apt update && apt install -y jq"
    have node || fail "node が必要です (install.sh が install します)"
    have systemctl || fail "systemctl が必要です"
    if ! gh auth status >/dev/null 2>&1; then
        fail "gh auth status に失敗しました。root で gh auth login && gh auth setup-git を実行してください"
    fi
    ok "account_id=${ACCOUNT_ID}"
    ok "repo=${REPO_FULL}"
    ok "account_repo=${ACCOUNT_REPO}"
}

# ============================================================================
# [2/8] clone / fast-forward account repo
# ============================================================================
step_clone_account_repo() {
    log "[2/8] account_repo を GitHub から復旧"
    mkdir -p "$(dirname "$ACCOUNT_REPO")"

    if [ -d "$ACCOUNT_REPO/.git" ]; then
        ok "既存 repo を fast-forward: $ACCOUNT_REPO"
        git -C "$ACCOUNT_REPO" pull --ff-only
    elif [ -e "$ACCOUNT_REPO" ] && [ -z "$(find "$ACCOUNT_REPO" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
        rmdir "$ACCOUNT_REPO"
        gh repo clone "$REPO_FULL" "$ACCOUNT_REPO"
        ok "clone 完了"
    elif [ -e "$ACCOUNT_REPO" ]; then
        fail "既存 path が git repo ではありません: $ACCOUNT_REPO"
    else
        gh repo clone "$REPO_FULL" "$ACCOUNT_REPO"
        ok "clone 完了"
    fi

    [ -f "$ACCOUNT_REPO/account.json" ] || fail "account.json がありません: $ACCOUNT_REPO/account.json"
    [ -f "$ACCOUNT_REPO/state.json" ] || warn "state.json がありません (bot 初回起動前に確認してください)"
}

# ============================================================================
# [3/8] knowledge skeleton + regenerate
# ============================================================================
step_knowledge() {
    log "[3/8] knowledge skeleton 補完 + regenerate"
    local file
    for file in AGENTS.md CLAUDE.md persona.md brand.md voice-guide.md targets.md .gitignore; do
        if [ -f "$ACCOUNT_REPO/$file" ]; then
            ok "$file 既存 (保持)"
        else
            cp -n "$STARTER_DIR/$file" "$ACCOUNT_REPO/$file"
            ok "$file 補完"
        fi
    done

    node "$MEX_NEXT_DIR/dist/scripts/regenerate-knowledge.js" --account-repo "$ACCOUNT_REPO"
    ok "AGENTS.md / CLAUDE.md / persona.md などを account.json から再生成"
}

# ============================================================================
# [4/8] env file
# ============================================================================
step_env_file() {
    log "[4/8] /etc/mex/${ACCOUNT_ID}.env を整備"
    mkdir -p /etc/mex

    if [ -f "$ENV_FILE" ]; then
        chmod 600 "$ENV_FILE"
        ok "$ENV_FILE 既存"
        if confirm "既存 env を再入力して上書きしますか?" "n"; then
            : > "$ENV_FILE"
            chmod 600 "$ENV_FILE"
            ok "$ENV_FILE を空にして再構成"
        else
            source_env_file
            ok "既存 env を保持し、不足分だけ補完"
        fi
    else
        : > "$ENV_FILE"
        chmod 600 "$ENV_FILE"
        ok "$ENV_FILE 新規作成"
    fi

    local token="${DOPPLER_TOKEN:-}"
    local ch_attention="${DISCORD_CHANNEL_CUSTOMER_ATTENTION:-}"
    local ch_passive="${DISCORD_CHANNEL_CUSTOMER_PASSIVE:-}"
    local ch_operator="${DISCORD_CHANNEL_OPERATOR:-${DISCORD_CHANNEL_OPERATOR_ALERT:-}}"
    local op_users="${OPERATOR_DISCORD_USER_IDS:-}"

    if [ -z "$token" ]; then
        prompt_secret "Doppler service token (read-only / ${DOPPLER_PROJECT}/${DOPPLER_CONFIG}):" token
    fi
    [ -n "$token" ] || fail "DOPPLER_TOKEN が必要です"

    if [ -z "$ch_attention" ]; then
        prompt "Customer attention channel ID (承認・反応系):" ch_attention
    fi
    [ -n "$ch_attention" ] || fail "DISCORD_CHANNEL_CUSTOMER_ATTENTION が必要です"

    if [ -z "$ch_passive" ]; then
        prompt_default "Customer passive channel ID (digest/振り返り)" "$ch_attention" ch_passive
    fi
    [ -n "$ch_passive" ] || fail "DISCORD_CHANNEL_CUSTOMER_PASSIVE が必要です"

    if [ -z "$ch_operator" ]; then
        prompt_default "Operator alert channel ID" "$ch_attention" ch_operator
    fi
    [ -n "$ch_operator" ] || fail "DISCORD_CHANNEL_OPERATOR が必要です"

    if [ -z "$op_users" ]; then
        prompt "Operator Discord user IDs (カンマ区切り):" op_users
    fi
    [ -n "$op_users" ] || fail "OPERATOR_DISCORD_USER_IDS が必要です"

    upsert_env_var "DOPPLER_TOKEN" "$token"
    upsert_env_var "ACCOUNT_ID" "$ACCOUNT_ID"
    upsert_env_var "ACCOUNT_REPO" "$ACCOUNT_REPO"
    upsert_env_var "DISCORD_CHANNEL_CUSTOMER_ATTENTION" "$ch_attention"
    upsert_env_var "DISCORD_CHANNEL_CUSTOMER_PASSIVE" "$ch_passive"
    upsert_env_var "DISCORD_CHANNEL_OPERATOR" "$ch_operator"
    upsert_env_var "OPERATOR_DISCORD_USER_IDS" "$op_users"

    CH_ATTENTION="$ch_attention"
    CH_PASSIVE="$ch_passive"
    CH_OPERATOR="$ch_operator"
    ok "$ENV_FILE 更新完了"
}

# ============================================================================
# [5/8] accounts-registry upsert
# ============================================================================
step_registry() {
    log "[5/8] accounts-registry.json に ${ACCOUNT_ID} を upsert"
    mkdir -p "$RUNTIME_DIR"
    chmod 755 "$RUNTIME_DIR"
    if [ ! -s "$REGISTRY_PATH" ]; then
        printf '{"accounts":[]}\n' > "$REGISTRY_PATH"
        chmod 600 "$REGISTRY_PATH"
        ok "registry 新規作成"
    fi

    local tmp
    tmp="$(mktemp)"
    jq \
        --arg id "$ACCOUNT_ID" \
        --arg repo "$ACCOUNT_REPO" \
        --arg attention "$CH_ATTENTION" \
        --arg passive "$CH_PASSIVE" \
        --arg operator "$CH_OPERATOR" \
        '
        def normalize:
          if type == "array" then
            { accounts: . }
          elif (.accounts | type) == "array" then
            .
          elif (.accounts | type) == "object" then
            .accounts = (.accounts | to_entries | map(.value))
          else
            . + { accounts: [] }
          end;

        normalize
        | .accounts = (
            (.accounts // [])
            | map(select(.account_id != $id))
            + [{
                account_id: $id,
                account_repo: $repo,
                customer_channels: {
                  attention: $attention,
                  passive: $passive,
                  operator: $operator
                }
              }]
          )
        ' "$REGISTRY_PATH" > "$tmp"
    mv "$tmp" "$REGISTRY_PATH"
    chmod 600 "$REGISTRY_PATH"
    ok "registry upsert 完了: $REGISTRY_PATH"
}

# ============================================================================
# [6/8] systemd reinstall
# ============================================================================
step_systemd() {
    log "[6/8] systemd unit / timer を再配置"
    render_template "$MEX_NEXT_DIR/deploy/mex-bot.service.template" \
        /etc/systemd/system/mex-bot.service

    cp "$MEX_NEXT_DIR/deploy/mex-self-update.service" /etc/systemd/system/mex-self-update.service
    cp "$MEX_NEXT_DIR/deploy/mex-self-update.timer" /etc/systemd/system/mex-self-update.timer
    ok "mex-self-update.{service,timer} 配置"

    local unit
    for unit in mex-daily mex-weekly-retro mex-reactions-poll mex-publish \
                mex-morning-digest mex-self-check \
                mex-phase-questionnaire-monthly mex-phase-questionnaire-weekly; do
        local svc_tmpl="$MEX_NEXT_DIR/deploy/timers/${unit}.service.template"
        local timer_tmpl="$MEX_NEXT_DIR/deploy/timers/${unit}.timer.template"
        [ -f "$svc_tmpl" ] || { warn "${unit}.service.template が無い、skip"; continue; }
        [ -f "$timer_tmpl" ] || { warn "${unit}.timer.template が無い、skip"; continue; }
        render_template "$svc_tmpl" "/etc/systemd/system/${unit}-${ACCOUNT_ID}.service"
        render_template "$timer_tmpl" "/etc/systemd/system/${unit}-${ACCOUNT_ID}.timer"
    done

    systemctl daemon-reload
    ok "systemctl daemon-reload 完了"
}

# ============================================================================
# [7/8] start bot + timers
# ============================================================================
step_start() {
    log "[7/8] mex-bot.service + timers を enable --now"
    systemctl enable --now mex-bot.service
    sleep 3
    if ! systemctl is-active --quiet mex-bot.service; then
        systemctl status mex-bot.service --no-pager -l || true
        journalctl -u mex-bot.service -n 50 --no-pager || true
        fail "mex-bot 起動失敗"
    fi
    systemctl status mex-bot.service --no-pager -l || true
    ok "mex-bot.service active"

    systemctl enable --now mex-self-update.timer || warn "mex-self-update.timer enable 失敗"
    local unit timer
    for unit in mex-daily mex-weekly-retro mex-reactions-poll mex-publish \
                mex-morning-digest mex-self-check \
                mex-phase-questionnaire-monthly mex-phase-questionnaire-weekly; do
        timer="${unit}-${ACCOUNT_ID}.timer"
        if [ -f "/etc/systemd/system/${timer}" ]; then
            systemctl enable --now "$timer" || warn "${timer} enable 失敗"
        fi
        systemctl disable --now "${unit}.timer" >/dev/null 2>&1 || true
        systemctl disable --now "${unit}.service" >/dev/null 2>&1 || true
        rm -f "/etc/systemd/system/${unit}.timer" "/etc/systemd/system/${unit}.service"
    done
    systemctl daemon-reload
    ok "timer enable 完了"
}

# ============================================================================
# [8/8] optional health check + summary
# ============================================================================
step_health_check() {
    log "[8/8] health check"
    if [ -f "$MEX_NEXT_DIR/dist/scripts/preflight-check.js" ]; then
        node "$MEX_NEXT_DIR/dist/scripts/preflight-check.js" --account-id "$ACCOUNT_ID" \
            || warn "preflight-check に失敗しました。journalctl / env / registry を確認してください"
    else
        warn "dist/scripts/preflight-check.js が無いため skip"
    fi

    cat <<EOF

復旧完了:
  account_id   : ${ACCOUNT_ID}
  github repo  : ${REPO_FULL}
  account_repo : ${ACCOUNT_REPO}
  env file     : ${ENV_FILE}
  registry     : ${REGISTRY_PATH}
  bot service  : mex-bot.service

確認:
  systemctl status mex-bot.service
  journalctl -u mex-bot.service -f
  systemctl list-timers 'mex-*'
EOF
}

main() {
    step_preflight
    step_clone_account_repo
    step_knowledge
    step_env_file
    step_registry
    step_systemd
    step_start
    step_health_check
}

main "$@"
