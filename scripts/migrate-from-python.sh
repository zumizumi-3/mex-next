#!/usr/bin/env bash
# Migrate an existing Python MeX VPS to mex-next, in place.
#
# Designed for accounts already running zumizumi-3/mex (Python) with:
#   - Discord bot connected, token in Doppler `xops-<account-id>/prd`
#   - account_repo at /srv/mex/<account-id>-x-ops
#   - systemd unit `mex-bot.service` (and per-account timers)
#
# What it does (idempotent, re-runnable):
#   1. Snapshot account.json / state.json
#   2. Stop Python bot + per-account timers
#   3. Run install.sh (Node 20 + tools + clone /opt/mex-next)
#   4. Run migrate-from-python (zod schema validation)
#   5. Prompt for missing Doppler secrets (channel IDs, ANTHROPIC_API_KEY)
#   6. Provision /var/lib/mex-next + accounts-registry
#   7. Replace systemd units (mex-bot, self-update, all timers)
#   8. Append target to deploy/mex-core-desired.json
#   9. Smoke test
#  10. Enable + start mex-bot + timers
#  11. Print rollback hint
#
# Usage (root):
#   bash /opt/mex-next/scripts/migrate-from-python.sh <account-id>
#
#   Or direct:
#   curl -fsSL https://raw.githubusercontent.com/zumizumi-3/mex-next/main/scripts/migrate-from-python.sh \
#     | bash -s -- zumi-x

set -euo pipefail

# ------------------------------------------------------------------ helpers
log()    { echo ""; echo "[$(date -Iseconds)] ▶ $*"; }
ok()     { echo "  ✅ $*"; }
warn()   { echo "  ⚠  $*"; }
fail()   { echo "  ❌ $*" >&2; exit 1; }
prompt() { read -rp "  ❯ $1 " "$2" </dev/tty; }
prompt_default() { read -rp "  ❯ $1 [$2] " "$3" </dev/tty; eval "$3=\"\${$3:-$2}\""; }
have()   { command -v "$1" >/dev/null 2>&1; }

# ------------------------------------------------------------------ args
ACCOUNT_ID="${1:-}"
if [ -z "$ACCOUNT_ID" ]; then
    fail "usage: $0 <account-id>  (例: $0 zumi-x)"
fi
if [[ ! "$ACCOUNT_ID" =~ ^[a-z][a-z0-9-]*$ ]]; then
    fail "account-id は英小文字 + 数字 + ハイフンのみ"
fi
if [ "$EUID" -ne 0 ]; then
    fail "root として実行してください"
fi

ACCOUNT_REPO="${MEX_ACCOUNT_REPO:-/srv/mex/${ACCOUNT_ID}-x-ops}"
MEX_NEXT_DIR="/opt/mex-next"
DOPPLER_PROJECT="xops-${ACCOUNT_ID}"
DOPPLER_CONFIG="prd"
RUNTIME_DIR="/var/lib/mex-next"
REGISTRY_PATH="${RUNTIME_DIR}/accounts-registry.json"
ENV_FILE="/etc/mex/${ACCOUNT_ID}.env"

# ============================================================================
# [1/11] 事前確認
# ============================================================================
step_preflight() {
    log "[1/11] 事前確認"
    [ -d "$ACCOUNT_REPO" ] || fail "account_repo が見つかりません: $ACCOUNT_REPO (MEX_ACCOUNT_REPO で上書き可)"
    [ -f "$ACCOUNT_REPO/account.json" ] || fail "account.json がありません: $ACCOUNT_REPO/account.json"
    [ -f "$ACCOUNT_REPO/state.json" ] || fail "state.json がありません: $ACCOUNT_REPO/state.json"
    have doppler || fail "doppler CLI が必要です (install.sh が install します)"
    have systemctl || fail "systemctl が必要です"
    ok "account_id=${ACCOUNT_ID}, account_repo=${ACCOUNT_REPO}"
    ok "Doppler project=${DOPPLER_PROJECT}/${DOPPLER_CONFIG}"
}

# ============================================================================
# [2/11] バックアップ
# ============================================================================
step_backup() {
    log "[2/11] account.json / state.json をバックアップ"
    local stamp
    stamp=$(date +%Y%m%d-%H%M%S)
    cp "$ACCOUNT_REPO/account.json" "$ACCOUNT_REPO/account.json.bak-${stamp}"
    cp "$ACCOUNT_REPO/state.json" "$ACCOUNT_REPO/state.json.bak-${stamp}"
    ok "bak suffix: .bak-${stamp}"
    if [ -f /etc/systemd/system/mex-bot.service ]; then
        cp /etc/systemd/system/mex-bot.service "/etc/systemd/system/mex-bot.service.python-bak-${stamp}"
        ok "旧 mex-bot.service も bak"
    fi
}

# ============================================================================
# [3/11] Python bot を停止
# ============================================================================
step_stop_python() {
    log "[3/11] Python bot + timers 停止"
    systemctl stop mex-bot.service 2>/dev/null && ok "mex-bot.service stopped" || warn "mex-bot.service stop skip"
    systemctl stop mex-self-update.timer 2>/dev/null || true
    for unit in "mex-daily-${ACCOUNT_ID}" "mex-weekly-retro-${ACCOUNT_ID}" \
                "mex-reactions-poll-${ACCOUNT_ID}" "mex-publish-${ACCOUNT_ID}"; do
        systemctl stop "${unit}.timer" 2>/dev/null || true
        systemctl disable "${unit}.timer" 2>/dev/null || true
    done
    ok "Python timers 停止"
}

# ============================================================================
# [4/11] mex-next install
# ============================================================================
step_install_mex_next() {
    log "[4/11] mex-next を install"
    if [ -d "$MEX_NEXT_DIR/.git" ]; then
        ok "mex-next 既存、git pull で最新化"
        (cd "$MEX_NEXT_DIR" && git fetch origin && git reset --hard origin/main)
    else
        ok "mex-next を clone"
        rm -rf "$MEX_NEXT_DIR"
        git clone https://github.com/zumizumi-3/mex-next.git "$MEX_NEXT_DIR"
    fi
    (cd "$MEX_NEXT_DIR" && npm ci --include=dev && npm run build)
    [ -f "$MEX_NEXT_DIR/dist/main.js" ] || fail "build 失敗 (dist/main.js が無い)"
    ok "build 完了"
}

# ============================================================================
# [5/11] state.json migrate
# ============================================================================
step_migrate_state() {
    log "[5/11] account.json / state.json を mex-next schema に migrate"
    cd "$MEX_NEXT_DIR"
    node dist/scripts/migrate-from-python.js --account-repo "$ACCOUNT_REPO" --dry-run
    echo
    prompt_default "上の dry-run 結果が問題なければ apply しますか? (yes/no)" "yes" CONFIRM
    if [ "$CONFIRM" != "yes" ]; then
        fail "中断: migrate apply をキャンセル"
    fi
    node dist/scripts/migrate-from-python.js --account-repo "$ACCOUNT_REPO"
    ok "schema migrate 完了"
}

# ============================================================================
# [6/11] Doppler secrets 補完
# ============================================================================
step_topup_doppler() {
    log "[6/11] Doppler secrets を mex-next 用に補完"
    # 既存値の存在確認
    local has_anthropic discord_token
    has_anthropic=$(doppler secrets get ANTHROPIC_API_KEY \
        --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" --plain 2>/dev/null || echo "")
    discord_token=$(doppler secrets get DISCORD_BOT_TOKEN \
        --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" --plain 2>/dev/null || echo "")

    if [ -z "$discord_token" ]; then
        fail "DISCORD_BOT_TOKEN が Doppler ${DOPPLER_PROJECT}/${DOPPLER_CONFIG} に無い (Python 版で設定済のはず、要確認)"
    fi
    ok "DISCORD_BOT_TOKEN 確認済"

    if [ -z "$has_anthropic" ]; then
        echo "  ANTHROPIC_API_KEY が Doppler に未登録です (LLM bridge 必須)"
        prompt "Anthropic API key (sk-ant-...):" ANTHROPIC_KEY
        doppler secrets set "ANTHROPIC_API_KEY=${ANTHROPIC_KEY}" \
            --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" --silent
        ok "ANTHROPIC_API_KEY 投入"
    else
        ok "ANTHROPIC_API_KEY 既存"
    fi

    # Channel role mapping (mex-next 規約)
    local ch_attention ch_passive ch_operator
    ch_attention=$(doppler secrets get DISCORD_CHANNEL_CUSTOMER_ATTENTION \
        --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" --plain 2>/dev/null || echo "")
    ch_passive=$(doppler secrets get DISCORD_CHANNEL_CUSTOMER_PASSIVE \
        --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" --plain 2>/dev/null || echo "")
    ch_operator=$(doppler secrets get DISCORD_CHANNEL_OPERATOR \
        --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" --plain 2>/dev/null || echo "")

    # Python 版の channel id 候補を探す (旧名で入ってる可能性)
    local legacy_main legacy_digest legacy_alert
    legacy_main=$(doppler secrets get DISCORD_CHANNEL_CUSTOMER_MAIN \
        --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" --plain 2>/dev/null || echo "")
    legacy_digest=$(doppler secrets get DISCORD_CHANNEL_DAILY_DIGEST \
        --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" --plain 2>/dev/null || echo "")
    legacy_alert=$(doppler secrets get DISCORD_CHANNEL_ALERTS \
        --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" --plain 2>/dev/null || echo "")

    if [ -z "$ch_attention" ]; then
        prompt_default "Customer attention channel ID (反応・承認系)" "${legacy_main:-}" ch_attention
    fi
    if [ -z "$ch_passive" ]; then
        prompt_default "Customer passive channel ID (digest/振り返り、silent 通知)" "${legacy_digest:-${ch_attention}}" ch_passive
    fi
    if [ -z "$ch_operator" ]; then
        prompt_default "Operator alert channel ID" "${legacy_alert:-}" ch_operator
    fi

    [ -n "$ch_attention" ] || fail "DISCORD_CHANNEL_CUSTOMER_ATTENTION が必要"
    [ -n "$ch_passive" ] || fail "DISCORD_CHANNEL_CUSTOMER_PASSIVE が必要"
    [ -n "$ch_operator" ] || fail "DISCORD_CHANNEL_OPERATOR が必要"

    doppler secrets set \
        "DISCORD_CHANNEL_CUSTOMER_ATTENTION=${ch_attention}" \
        "DISCORD_CHANNEL_CUSTOMER_PASSIVE=${ch_passive}" \
        "DISCORD_CHANNEL_OPERATOR=${ch_operator}" \
        "ACCOUNT_ID=${ACCOUNT_ID}" \
        "ACCOUNT_REPO=${ACCOUNT_REPO}" \
        --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" --silent

    # Operator user ID も補完
    local op_users
    op_users=$(doppler secrets get OPERATOR_DISCORD_USER_IDS \
        --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" --plain 2>/dev/null || echo "")
    if [ -z "$op_users" ]; then
        prompt "Operator Discord user IDs (カンマ区切り、bot に DM で操作許可される user)" op_users
        doppler secrets set "OPERATOR_DISCORD_USER_IDS=${op_users}" \
            --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" --silent
        ok "OPERATOR_DISCORD_USER_IDS 投入"
    fi

    # 控えとく (registry に書き戻す用)
    CH_ATTENTION="$ch_attention"
    CH_PASSIVE="$ch_passive"
    CH_OPERATOR="$ch_operator"

    ok "Doppler secrets 整備完了"
}

# ============================================================================
# [7/11] runtime dir + registry
# ============================================================================
step_runtime_dir() {
    log "[7/11] /var/lib/mex-next 整備"
    mkdir -p "$RUNTIME_DIR"
    chmod 755 "$RUNTIME_DIR"

    if [ -f /var/lib/mex/accounts-registry.json ] && [ ! -f "$REGISTRY_PATH" ]; then
        cp /var/lib/mex/accounts-registry.json "$REGISTRY_PATH"
        ok "Python 版から accounts-registry を copy"
    fi

    # zumi-x が registry に居ない (or 新規) なら作る・追加する
    if [ ! -f "$REGISTRY_PATH" ]; then
        cat > "$REGISTRY_PATH" <<EOF
{
  "accounts": [
    {
      "account_id": "${ACCOUNT_ID}",
      "customer_channels": {
        "attention": "${CH_ATTENTION}",
        "passive": "${CH_PASSIVE}",
        "operator": "${CH_OPERATOR}"
      }
    }
  ]
}
EOF
        ok "registry 新規作成"
    else
        # 既存 registry に entry を upsert (jq があればきれい、無ければ手動)
        if have jq; then
            local tmp; tmp=$(mktemp)
            jq --arg id "$ACCOUNT_ID" --arg a "$CH_ATTENTION" --arg p "$CH_PASSIVE" --arg o "$CH_OPERATOR" '
                .accounts |= (
                    map(select(.account_id != $id))
                    + [{ account_id: $id, customer_channels: { attention: $a, passive: $p, operator: $o } }]
                )' "$REGISTRY_PATH" > "$tmp" && mv "$tmp" "$REGISTRY_PATH"
            ok "registry に ${ACCOUNT_ID} entry を upsert"
        else
            warn "jq が無いため registry の手動確認をおすすめ: $REGISTRY_PATH"
        fi
    fi

    # /etc/mex/<account>.env (Doppler service token 入り) は Python 版から流用
    if [ ! -f "$ENV_FILE" ]; then
        warn "$ENV_FILE が無い。Python 版から流用していなければ手動で DOPPLER_TOKEN を入れてください"
        prompt "Doppler service token (read-only / xops-${ACCOUNT_ID}/prd):" SERVICE_TOKEN
        mkdir -p /etc/mex
        echo "DOPPLER_TOKEN=${SERVICE_TOKEN}" > "$ENV_FILE"
        chmod 600 "$ENV_FILE"
        ok "$ENV_FILE 作成"
    else
        ok "$ENV_FILE 既存 (Python 版から流用)"
    fi
}

# ============================================================================
# [8/11] systemd unit 差し替え
# ============================================================================
step_systemd() {
    log "[8/11] systemd unit を mex-next 用に差し替え"

    install_unit() {
        local src="$1"
        local dst="$2"
        local tmp
        tmp=$(mktemp)
        sed "s/{ACCOUNT_ID}/${ACCOUNT_ID}/g" "$src" > "$tmp"
        mv "$tmp" "$dst"
        ok "$(basename "$dst") 配置"
    }

    install_unit "$MEX_NEXT_DIR/deploy/mex-bot.service.template" /etc/systemd/system/mex-bot.service
    cp "$MEX_NEXT_DIR/deploy/mex-self-update.service" /etc/systemd/system/mex-self-update.service
    cp "$MEX_NEXT_DIR/deploy/mex-self-update.timer" /etc/systemd/system/mex-self-update.timer

    for unit in mex-daily mex-weekly-retro mex-reactions-poll mex-publish \
                mex-morning-digest mex-self-check mex-phase-questionnaire-monthly; do
        local svc_tmpl="$MEX_NEXT_DIR/deploy/timers/${unit}.service.template"
        local timer_tmpl="$MEX_NEXT_DIR/deploy/timers/${unit}.timer.template"
        [ -f "$svc_tmpl" ] || { warn "${unit}.service.template が無い、skip"; continue; }
        install_unit "$svc_tmpl" "/etc/systemd/system/${unit}.service"
        install_unit "$timer_tmpl" "/etc/systemd/system/${unit}.timer"
    done

    systemctl daemon-reload
    ok "daemon-reload 完了"
}

# ============================================================================
# [9/11] core-desired.json upsert
# ============================================================================
step_desired() {
    log "[9/11] deploy/mex-core-desired.json に ${ACCOUNT_ID} を登録"
    local desired="$MEX_NEXT_DIR/deploy/mex-core-desired.json"
    if have jq; then
        local tmp; tmp=$(mktemp)
        jq --arg id "$ACCOUNT_ID" '.targets[$id] = { enabled: true, ref: "main" }' "$desired" > "$tmp" \
            && mv "$tmp" "$desired"
        ok "${ACCOUNT_ID} target を upsert"
    else
        warn "jq 無し。手動で $desired の targets に \"${ACCOUNT_ID}\": {enabled:true, ref:\"main\"} を追記してください"
    fi
}

# ============================================================================
# [10/11] smoke test
# ============================================================================
step_smoke() {
    log "[10/11] smoke test (Discord login + LLM + X API 各 1 回)"
    cd "$MEX_NEXT_DIR"
    if doppler run --project "$DOPPLER_PROJECT" --config "$DOPPLER_CONFIG" \
        -- node dist/scripts/smoke-test.js --all; then
        ok "smoke test pass"
    else
        warn "smoke test に失敗あり。journalctl と Doppler secrets を確認してから start してください"
        prompt_default "それでも mex-bot.service を start しますか? (yes/no)" "no" PROCEED
        [ "$PROCEED" = "yes" ] || fail "中断: smoke test fail"
    fi
}

# ============================================================================
# [11/11] mex-bot 起動 + timer enable
# ============================================================================
step_start() {
    log "[11/11] mex-bot.service + timers を起動"
    systemctl enable --now mex-bot.service
    sleep 3
    if ! systemctl is-active --quiet mex-bot.service; then
        journalctl -u mex-bot.service -n 30 --no-pager
        fail "mex-bot.service が起動失敗"
    fi
    ok "mex-bot.service active"

    for unit in mex-self-update mex-self-check mex-daily mex-weekly-retro \
                mex-reactions-poll mex-publish mex-morning-digest \
                mex-phase-questionnaire-monthly; do
        if [ -f "/etc/systemd/system/${unit}.timer" ]; then
            systemctl enable --now "${unit}.timer" || warn "${unit}.timer enable 失敗"
        fi
    done

    ok "全 timer enable 完了"
}

# ============================================================================
# 完了サマリ
# ============================================================================
step_finish() {
    log "✅ migration 完了"
    cat <<EOF

  account_id   : ${ACCOUNT_ID}
  account_repo : ${ACCOUNT_REPO}
  mex_next     : ${MEX_NEXT_DIR}
  registry     : ${REGISTRY_PATH}
  env file     : ${ENV_FILE}

  確認:
    systemctl status mex-bot.service
    journalctl -u mex-bot -f
    systemctl list-timers | grep mex-

  顧客 Discord で:
    - bot に「予約見せて」と話しかける → schedule list が返る
    - /mex schedule list slash command も応答する
    - 翌朝 07:00 に morning digest が来る

  ロールバック (1 週間内に問題出たら):
    sudo systemctl stop mex-bot.service
    sudo cp /etc/systemd/system/mex-bot.service.python-bak-* /etc/systemd/system/mex-bot.service
    sudo systemctl daemon-reload
    sudo systemctl start mex-bot.service
    cp ${ACCOUNT_REPO}/state.json.bak-* ${ACCOUNT_REPO}/state.json   # 必要なら

EOF
}

# ============================================================================
# main
# ============================================================================
main() {
    step_preflight
    step_backup
    step_stop_python
    step_install_mex_next
    step_migrate_state
    step_topup_doppler
    step_runtime_dir
    step_systemd
    step_desired
    step_smoke
    step_start
    step_finish
}

main "$@"
