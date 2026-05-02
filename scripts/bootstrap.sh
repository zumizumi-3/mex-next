#!/usr/bin/env bash
# MeX Next bootstrap.sh — 1 コマンドで VPS を <account> 運用状態まで立ち上げる。
#
# 使い方 (VPS で root):
#   curl -fsSL https://raw.githubusercontent.com/zumizumi-3/mex-next/main/scripts/bootstrap.sh | bash
#
# unattended:
#   MEX_BOOTSTRAP_UNATTENDED=1 \
#   MEX_BOOTSTRAP_ACCOUNT_ID=tanaka-x \
#   MEX_BOOTSTRAP_GITHUB_REPO=tanaka-kun/tanaka-x-ops \
#   MEX_BOOTSTRAP_DOPPLER_TOKEN=dp.st.... \
#   MEX_BOOTSTRAP_DISCORD_TOKEN=... \
#   MEX_BOOTSTRAP_DISCORD_CHANNEL_ID=... \
#   MEX_BOOTSTRAP_OPERATOR_USER_IDS=... \
#   bash scripts/bootstrap.sh
#
# 流れ (対話):
#   [1] install.sh 走らせる (冪等)
#   [2] account_id を聞く
#   [3] claude / gh / doppler の login (browser OAuth)
#   [4] account repo の準備 (clone or starter copy)
#   [5] Doppler project / config を作成
#   [6] Discord bot setup wizard
#   [7] Discord slash command 登録
#   [8] systemd unit + timer 生成
#   [9] timer 一括 enable + 完了 summary
#
# Python 版 (zumizumi-3/mex の bootstrap.sh) を Node.js 環境向けに移植。

set -euo pipefail

MEX_NEXT_REPO_URL="${MEX_NEXT_REPO_URL:-https://github.com/zumizumi-3/mex-next.git}"
MEX_NEXT_DIR="${MEX_NEXT_DIR:-/opt/mex-next}"
MEX_ACCOUNTS_ROOT="${MEX_ACCOUNTS_ROOT:-/srv/mex-next}"
MEX_VAR_LIB="/var/lib/mex-next"
MEX_ETC="/etc/mex"
DEPLOY_DIR="${MEX_NEXT_DIR}/deploy"

log()    { echo ""; echo "[$(date -Iseconds)] ▶ $*"; }
ok()     { echo "  [OK] $*"; }
warn()   { echo "  [WARN] $*"; }
fail()   { echo "  [FAIL] $*" >&2; exit 1; }
prompt() { read -rp "  > $1 " "$2"; }
prompt_secret() { read -rsp "  > $1 " "$2"; echo; }

is_unattended() {
    [[ "${MEX_BOOTSTRAP_UNATTENDED:-0}" =~ ^(1|true|TRUE|yes|YES)$ ]]
}

pause() {
    if is_unattended; then
        ok "unattended: $1 (skip pause)"
        return 0
    fi
    read -rp "  -> $1 (終わったら Enter) "
}

prompt_from_env() {
    local env_name="$1"
    local label="$2"
    local dest="$3"
    local required="${4:-required}"
    local value="${!env_name:-}"
    if [ -n "${value}" ]; then
        printf -v "${dest}" '%s' "${value}"
        return 0
    fi
    if is_unattended; then
        if [ "${required}" = "required" ]; then
            fail "${env_name} is required in unattended mode"
        fi
        printf -v "${dest}" ''
        return 0
    fi
    prompt "${label}" "${dest}"
}

prompt_secret_from_env() {
    local env_name="$1"
    local label="$2"
    local dest="$3"
    local required="${4:-required}"
    local value="${!env_name:-}"
    if [ -n "${value}" ]; then
        printf -v "${dest}" '%s' "${value}"
        return 0
    fi
    if is_unattended; then
        if [ "${required}" = "required" ]; then
            fail "${env_name} is required in unattended mode"
        fi
        printf -v "${dest}" ''
        return 0
    fi
    prompt_secret "${label}" "${dest}"
}

append_env_if_set() {
    local file="$1"
    local key="$2"
    local value="$3"
    if [ -n "${value}" ]; then
        printf '%s=%s\n' "${key}" "${value}" >> "${file}"
    fi
}

fetch_discord_application_id() {
    local token="$1"
    if [ -z "${token}" ]; then
        return 1
    fi
    DISCORD_BOT_TOKEN="${token}" node -e '
const token = process.env.DISCORD_BOT_TOKEN;
fetch("https://discord.com/api/v10/oauth2/applications/@me", {
  headers: { Authorization: `Bot ${token}` },
}).then(async (res) => {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const data = await res.json();
  if (!data.id) throw new Error("application id missing in Discord response");
  console.log(data.id);
}).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
'
}

if [ "$EUID" -ne 0 ]; then
    fail "root で実行してください"
fi

ACCOUNT_ID=""
ACCOUNT_REPO=""
DOPPLER_TOKEN=""
ACCOUNT_GITHUB_REPO=""
DISCORD_APPLICATION_ID_BOOTSTRAP=""
DISCORD_GUILD_ID_BOOTSTRAP=""

# ======================================================================
# [1] install.sh 走らせる
# ======================================================================
step_install() {
    log "[1/9] install.sh 走らせる (tools install + mex-next clone)"
    if [ -x "${MEX_NEXT_DIR}/scripts/install.sh" ]; then
        MEX_NEXT_REPO_URL="${MEX_NEXT_REPO_URL}" bash "${MEX_NEXT_DIR}/scripts/install.sh"
    else
        curl -fsSL "${MEX_NEXT_REPO_URL%.git}/raw/main/scripts/install.sh" \
            | MEX_NEXT_REPO_URL="${MEX_NEXT_REPO_URL}" bash
    fi
    ok "install.sh 完了"
}

# ======================================================================
# [2] account_id
# ======================================================================
step_account_id() {
    log "[2/9] account_id を決めてください (英小文字 + 数字 + ハイフン、例: zumi-x)"
    prompt_from_env "MEX_BOOTSTRAP_ACCOUNT_ID" "account_id:" ACCOUNT_ID
    if [[ ! "${ACCOUNT_ID}" =~ ^[a-z][a-z0-9-]*$ ]]; then
        fail "account_id は英小文字 + 数字 + ハイフン (先頭は英字) のみ"
    fi
    ACCOUNT_REPO="${MEX_BOOTSTRAP_ACCOUNT_REPO_PATH:-${MEX_ACCOUNTS_ROOT}/${ACCOUNT_ID}-x-ops}"
    ACCOUNT_GITHUB_REPO="${MEX_BOOTSTRAP_GITHUB_REPO:-}"
    ok "account_id: ${ACCOUNT_ID}"
    ok "account repo path: ${ACCOUNT_REPO}"
    if [ -n "${ACCOUNT_GITHUB_REPO}" ]; then
        ok "GitHub repo: ${ACCOUNT_GITHUB_REPO}"
    fi
}

# ======================================================================
# [3] login 3 つ
# ======================================================================
step_logins() {
    log "[3/9] login 3 つ (browser OAuth)"

    if ! claude --version >/dev/null 2>&1; then
        fail "claude CLI が見つかりません。install.sh を確認してください"
    fi
    if is_unattended; then
        ok "unattended: claude login prompt skip"
    else
    echo "  Claude Code login を開始 (既に login 済ならそのまま完了します)"
    claude login || warn "claude login 完了したか確認してください"
    fi
    ok "claude login 済 (or skip)"

    if gh auth status >/dev/null 2>&1; then
        ok "gh 既に login 済"
    elif is_unattended; then
        warn "unattended: gh 未 login。private repo clone が失敗する場合は事前に gh auth login してください"
    else
        echo "  gh auth login を開始..."
        gh auth login
        gh auth setup-git || true
    fi
    ok "gh login 済"

    if doppler me >/dev/null 2>&1; then
        ok "doppler 既に login 済"
    elif is_unattended; then
        if [ -n "${MEX_BOOTSTRAP_DOPPLER_TOKEN:-}" ]; then
            ok "unattended: Doppler user login skip (service token provided)"
        else
            warn "unattended: doppler 未 login。project 作成が必要な場合は事前に doppler login してください"
        fi
    else
        echo "  doppler login を開始..."
        doppler login
    fi
    ok "doppler login 済"
}

# ======================================================================
# [4] account repo
# ======================================================================
step_account_repo() {
    log "[4/9] account repo 準備"
    mkdir -p "${MEX_ACCOUNTS_ROOT}"

    if [ -d "${ACCOUNT_REPO}/.git" ]; then
        ok "account repo 既存: ${ACCOUNT_REPO}"
        (cd "${ACCOUNT_REPO}" && git pull --ff-only) || warn "git pull 失敗、手動確認"
        return 0
    fi

    if is_unattended; then
        if [ -z "${ACCOUNT_GITHUB_REPO}" ]; then
            fail "MEX_BOOTSTRAP_GITHUB_REPO is required in unattended mode when account repo is not already cloned"
        fi
        gh repo clone "${ACCOUNT_GITHUB_REPO}" "${ACCOUNT_REPO}"
        ok "account repo cloned: ${ACCOUNT_REPO}"
        return 0
    fi

    echo ""
    echo "  このアカウントの GitHub repo はどちらですか?"
    echo "  (1) 既存 repo を clone (顧客が collaborator 招待済)"
    echo "  (2) operator が新規 private repo を作成"
    prompt "選択 [1/2]:" CHOICE_REPO

    case "${CHOICE_REPO}" in
        1)
            prompt "repo URL or owner/name:" EXISTING_REPO
            gh repo clone "${EXISTING_REPO}" "${ACCOUNT_REPO}"
            ;;
        2)
            prompt "新 repo (owner/name 例: zumizumi-3/${ACCOUNT_ID}-x-ops):" NEW_REPO
            prompt "Create the account repo on GitHub now (Y/n)?" CREATE_REPO_NOW
            CREATE_REPO_NOW="${CREATE_REPO_NOW:-Y}"
            if [[ "${CREATE_REPO_NOW}" =~ ^[Yy]$|^[Yy][Ee][Ss]$ ]]; then
                local create_output_file
                local create_output
                create_output_file="$(mktemp)"
                "${MEX_NEXT_DIR}/scripts/create-account-repo.sh" "${NEW_REPO}" "${ACCOUNT_REPO}" | tee "${create_output_file}"
                create_output="$(cat "${create_output_file}")"
                rm -f "${create_output_file}"
                [ -n "${create_output}" ] || warn "create-account-repo output was empty"
                export ACCOUNT_REPO
            else
                prompt "repo URL or owner/name (already created):" EXISTING_REPO
                gh repo clone "${EXISTING_REPO}" "${ACCOUNT_REPO}"
            fi
            ;;
        *)
            fail "1 or 2 を選択してください"
            ;;
    esac
    ok "account repo: ${ACCOUNT_REPO}"
}

# ======================================================================
# [5] Doppler project
# ======================================================================
step_doppler() {
    log "[5/9] Doppler project / config を作成"
    if is_unattended && ! doppler me >/dev/null 2>&1; then
        warn "unattended: Doppler user login なし。project/config 作成は skip (既存 service token 前提)"
    else
        node "${MEX_NEXT_DIR}/dist/scripts/setup-doppler.js" \
            --account-id "${ACCOUNT_ID}" \
            || warn "setup-doppler 失敗、後で手動で確認"
    fi
    if doppler me >/dev/null 2>&1; then
        local project="xops-${ACCOUNT_ID}"
        local config="prd"
        if [ -n "${MEX_BOOTSTRAP_DISCORD_TOKEN:-}" ]; then
            doppler secrets set "DISCORD_BOT_TOKEN=${MEX_BOOTSTRAP_DISCORD_TOKEN}" \
                --project "${project}" --config "${config}" --no-interactive || warn "DISCORD_BOT_TOKEN set 失敗"
        fi
        if [ -n "${MEX_BOOTSTRAP_DISCORD_APPLICATION_ID:-}" ]; then
            doppler secrets set "DISCORD_APPLICATION_ID=${MEX_BOOTSTRAP_DISCORD_APPLICATION_ID}" \
                --project "${project}" --config "${config}" --no-interactive || warn "DISCORD_APPLICATION_ID set 失敗"
        fi
        if [ -n "${MEX_BOOTSTRAP_DISCORD_GUILD_ID:-}" ]; then
            doppler secrets set "DISCORD_GUILD_ID=${MEX_BOOTSTRAP_DISCORD_GUILD_ID}" \
                --project "${project}" --config "${config}" --no-interactive || warn "DISCORD_GUILD_ID set 失敗"
        fi
        if [ -n "${MEX_BOOTSTRAP_OPERATOR_USER_IDS:-}" ]; then
            doppler secrets set "OPERATOR_DISCORD_USER_IDS=${MEX_BOOTSTRAP_OPERATOR_USER_IDS}" \
                --project "${project}" --config "${config}" --no-interactive || warn "OPERATOR_DISCORD_USER_IDS set 失敗"
        fi
    fi
    ok "Doppler project 設定完了"
}

# ======================================================================
# [6] Discord bot setup wizard
# ======================================================================
step_discord() {
    log "[6/9] Discord bot setup"
    echo ""
    echo "  事前準備 (ブラウザで):"
    echo "  1. https://discord.com/developers/applications -> New Application"
    echo "  2. Bot tab -> Reset Token -> token をコピー"
    echo "  3. Privileged Gateway Intents: MESSAGE CONTENT を ON"
    echo "  4. OAuth2 -> URL Generator (scope: bot + applications.commands) -> install URL を運営 server に install"
    echo "  5. server / channel の ID をコピー (Developer Mode ON 必要)"
    echo ""
    pause "Discord bot 作成 + install 完了したら"

    DISCORD_APPLICATION_ID_BOOTSTRAP="${MEX_BOOTSTRAP_DISCORD_APPLICATION_ID:-}"
    DISCORD_GUILD_ID_BOOTSTRAP="${MEX_BOOTSTRAP_DISCORD_GUILD_ID:-}"
    if [ -z "${DISCORD_APPLICATION_ID_BOOTSTRAP}" ] && [ -n "${MEX_BOOTSTRAP_DISCORD_TOKEN:-}" ]; then
        DISCORD_APPLICATION_ID_BOOTSTRAP="$(fetch_discord_application_id "${MEX_BOOTSTRAP_DISCORD_TOKEN}")" \
            || fail "Discord application id を bot token から取得できませんでした。MEX_BOOTSTRAP_DISCORD_APPLICATION_ID を指定してください"
        ok "Discord application id を bot token から取得"
    fi

    if is_unattended; then
        [ -n "${DISCORD_APPLICATION_ID_BOOTSTRAP}" ] || fail "MEX_BOOTSTRAP_DISCORD_APPLICATION_ID is required in unattended mode when it cannot be derived from MEX_BOOTSTRAP_DISCORD_TOKEN"
        [ -n "${MEX_BOOTSTRAP_DISCORD_CHANNEL_ID:-}${MEX_BOOTSTRAP_DISCORD_CUSTOMER_MAIN_CHANNEL_ID:-}" ] || fail "MEX_BOOTSTRAP_DISCORD_CHANNEL_ID or MEX_BOOTSTRAP_DISCORD_CUSTOMER_MAIN_CHANNEL_ID is required in unattended mode"
    fi

    MEX_SETUP_DISCORD_APPLICATION_ID="${DISCORD_APPLICATION_ID_BOOTSTRAP}" \
    MEX_SETUP_DISCORD_GUILD_ID="${DISCORD_GUILD_ID_BOOTSTRAP}" \
    MEX_SETUP_UNATTENDED="${MEX_BOOTSTRAP_UNATTENDED:-}" \
    MEX_SETUP_DISCORD_CHANNEL_ID="${MEX_BOOTSTRAP_DISCORD_CHANNEL_ID:-}" \
    MEX_SETUP_DISCORD_CUSTOMER_MAIN_CHANNEL_ID="${MEX_BOOTSTRAP_DISCORD_CUSTOMER_MAIN_CHANNEL_ID:-${MEX_BOOTSTRAP_DISCORD_CHANNEL_ID:-}}" \
    MEX_SETUP_DISCORD_CUSTOMER_ATTENTION_CHANNEL_ID="${MEX_BOOTSTRAP_DISCORD_CUSTOMER_ATTENTION_CHANNEL_ID:-${MEX_BOOTSTRAP_DISCORD_CHANNEL_ID:-}}" \
    MEX_SETUP_DISCORD_CUSTOMER_PASSIVE_CHANNEL_ID="${MEX_BOOTSTRAP_DISCORD_CUSTOMER_PASSIVE_CHANNEL_ID:-${MEX_BOOTSTRAP_DISCORD_CHANNEL_ID:-}}" \
    MEX_SETUP_DISCORD_OPERATOR_ALERT_CHANNEL_ID="${MEX_BOOTSTRAP_DISCORD_OPERATOR_ALERT_CHANNEL_ID:-${MEX_BOOTSTRAP_DISCORD_CHANNEL_ID:-}}" \
    MEX_SETUP_OPERATOR_USER_IDS="${MEX_BOOTSTRAP_OPERATOR_USER_IDS:-}" \
        node "${MEX_NEXT_DIR}/dist/scripts/setup-discord.js" \
        --account-id "${ACCOUNT_ID}" \
        --account-repo "${ACCOUNT_REPO}" \
        || warn "setup-discord 失敗、後で手動で確認"
    ok "Discord setup 完了"
}

# ======================================================================
# [7] slash command 登録
# ======================================================================
step_slash() {
    log "[7/9] Discord slash command 登録"
    DISCORD_BOT_TOKEN="${MEX_BOOTSTRAP_DISCORD_TOKEN:-${DISCORD_BOT_TOKEN:-}}" \
    DISCORD_APPLICATION_ID="${DISCORD_APPLICATION_ID_BOOTSTRAP:-${MEX_BOOTSTRAP_DISCORD_APPLICATION_ID:-${DISCORD_APPLICATION_ID:-}}}" \
    DISCORD_GUILD_ID="${DISCORD_GUILD_ID_BOOTSTRAP:-${MEX_BOOTSTRAP_DISCORD_GUILD_ID:-${DISCORD_GUILD_ID:-}}}" \
        node "${MEX_NEXT_DIR}/dist/scripts/register-slash.js" \
        --account-id "${ACCOUNT_ID}" \
        || warn "register-slash 失敗、後で手動で実行"
    ok "slash command 登録完了"
}

# ======================================================================
# [8] systemd unit + timer 生成
# ======================================================================
render_template() {
    local src="$1"
    local dest="$2"
    if [ ! -f "${src}" ]; then
        warn "template が無い: ${src} (skip)"
        return 1
    fi
    sed "s|{ACCOUNT_ID}|${ACCOUNT_ID}|g; s|{ACCOUNT_REPO}|${ACCOUNT_REPO}|g" "${src}" > "${dest}"
}

step_systemd() {
    log "[8/9] systemd unit + timer 生成"
    mkdir -p "${MEX_ETC}" "${MEX_VAR_LIB}"

    local env_file="${MEX_ETC}/${ACCOUNT_ID}.env"
    if [ -f "${env_file}" ]; then
        ok "env file 既存: ${env_file}"
    else
        echo ""
        echo "  Doppler service token (Read Only / xops-${ACCOUNT_ID} / prd) を貼ってください"
        prompt_secret_from_env "MEX_BOOTSTRAP_DOPPLER_TOKEN" "DOPPLER_TOKEN:" DOPPLER_TOKEN
        if [ -z "${DOPPLER_TOKEN}" ]; then
            fail "DOPPLER_TOKEN は必須です"
        fi
        umask 077
        cat > "${env_file}" <<EOF
DOPPLER_TOKEN=${DOPPLER_TOKEN}
ACCOUNT_ID=${ACCOUNT_ID}
ACCOUNT_REPO=${ACCOUNT_REPO}
EOF
        append_env_if_set "${env_file}" "DISCORD_BOT_TOKEN" "${MEX_BOOTSTRAP_DISCORD_TOKEN:-}"
        append_env_if_set "${env_file}" "DISCORD_APPLICATION_ID" "${DISCORD_APPLICATION_ID_BOOTSTRAP:-${MEX_BOOTSTRAP_DISCORD_APPLICATION_ID:-}}"
        append_env_if_set "${env_file}" "DISCORD_GUILD_ID" "${DISCORD_GUILD_ID_BOOTSTRAP:-${MEX_BOOTSTRAP_DISCORD_GUILD_ID:-}}"
        append_env_if_set "${env_file}" "OPERATOR_DISCORD_USER_IDS" "${MEX_BOOTSTRAP_OPERATOR_USER_IDS:-}"
        append_env_if_set "${env_file}" "DISCORD_CHANNEL_CUSTOMER_MAIN" "${MEX_BOOTSTRAP_DISCORD_CUSTOMER_MAIN_CHANNEL_ID:-${MEX_BOOTSTRAP_DISCORD_CHANNEL_ID:-}}"
        append_env_if_set "${env_file}" "DISCORD_CHANNEL_CUSTOMER_ATTENTION" "${MEX_BOOTSTRAP_DISCORD_CUSTOMER_ATTENTION_CHANNEL_ID:-${MEX_BOOTSTRAP_DISCORD_CHANNEL_ID:-}}"
        append_env_if_set "${env_file}" "DISCORD_CHANNEL_CUSTOMER_PASSIVE" "${MEX_BOOTSTRAP_DISCORD_CUSTOMER_PASSIVE_CHANNEL_ID:-${MEX_BOOTSTRAP_DISCORD_CHANNEL_ID:-}}"
        append_env_if_set "${env_file}" "DISCORD_CHANNEL_OPERATOR_ALERT" "${MEX_BOOTSTRAP_DISCORD_OPERATOR_ALERT_CHANNEL_ID:-${MEX_BOOTSTRAP_DISCORD_CHANNEL_ID:-}}"
        chmod 600 "${env_file}"
        ok "env file 作成: ${env_file}"
    fi

    # bot service
    render_template "${DEPLOY_DIR}/mex-bot.service.template" \
        "/etc/systemd/system/mex-bot.service"
    ok "mex-bot.service 生成"

    # self-update (アカウント非依存)
    cp "${DEPLOY_DIR}/mex-self-update.service" /etc/systemd/system/mex-self-update.service
    cp "${DEPLOY_DIR}/mex-self-update.timer"   /etc/systemd/system/mex-self-update.timer
    ok "mex-self-update.{service,timer} 配置"

    # account 別 timer
    local timers=(
        "mex-daily"
        "mex-weekly-retro"
        "mex-reactions-poll"
        "mex-publish"
    )
    for base in "${timers[@]}"; do
        local svc_src="${DEPLOY_DIR}/timers/${base}.service.template"
        local tim_src="${DEPLOY_DIR}/timers/${base}.timer.template"
        local svc_dst="/etc/systemd/system/${base}-${ACCOUNT_ID}.service"
        local tim_dst="/etc/systemd/system/${base}-${ACCOUNT_ID}.timer"
        if [ -f "${svc_src}" ] && [ -f "${tim_src}" ]; then
            render_template "${svc_src}" "${svc_dst}"
            render_template "${tim_src}" "${tim_dst}"
            ok "${base}-${ACCOUNT_ID}.{service,timer} 生成"
        else
            warn "${base} template が無い (skip)"
        fi
    done

    systemctl daemon-reload
    ok "systemd daemon-reload"
}

# ======================================================================
# [9] enable timers + summary
# ======================================================================
step_enable() {
    log "[9/9] timer 一括 enable"
    systemctl enable --now mex-bot.service       || warn "mex-bot.service enable 失敗"
    systemctl enable --now mex-self-update.timer || warn "mex-self-update.timer enable 失敗"

    for base in mex-daily mex-weekly-retro mex-reactions-poll mex-publish; do
        local unit="${base}-${ACCOUNT_ID}.timer"
        if [ -f "/etc/systemd/system/${unit}" ]; then
            systemctl enable --now "${unit}" || warn "${unit} enable 失敗"
        fi
    done

    # accounts-registry に登録 (setup-discord で書かれてる想定だが、無ければ touch)
    if [ ! -f "${MEX_VAR_LIB}/accounts-registry.json" ]; then
        echo '{"accounts":{}}' > "${MEX_VAR_LIB}/accounts-registry.json"
        ok "accounts-registry.json を初期化"
    fi

    cat <<EOF

============================================================
MeX Next bootstrap 完了: ${ACCOUNT_ID}

- account repo: ${ACCOUNT_REPO}
- Doppler:      xops-${ACCOUNT_ID}/prd
- env file:     ${MEX_ETC}/${ACCOUNT_ID}.env
- bot service:  mex-bot.service (active)
- timers:       mex-daily-${ACCOUNT_ID}.timer / mex-weekly-retro-${ACCOUNT_ID}.timer
                mex-reactions-poll-${ACCOUNT_ID}.timer / mex-publish-${ACCOUNT_ID}.timer
- self-update:  mex-self-update.timer (30min)

確認:
  systemctl status mex-bot.service
  journalctl -u mex-bot.service -f
  systemctl list-timers 'mex-*'

顧客導線:
  Discord channel で /mex onboard を叩く、または bot に話しかける
============================================================
EOF
}

main() {
    step_install
    step_account_id
    step_logins
    step_account_repo
    step_doppler
    step_discord
    step_slash
    step_systemd
    step_enable
}

main "$@"
