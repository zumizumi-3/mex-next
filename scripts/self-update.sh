#!/usr/bin/env bash
# self-update.sh — git pull + build + restart bot
#
# `mex-self-update.service` の ExecStart から呼ばれる。
# 失敗時の挙動:
#   - build までの step は失敗で alert + exit 1
#   - bot restart 失敗時は **1 回だけ** `systemctl start --no-block` で
#     再起動を試みる。それも失敗したら alert + exit 1。
#     (一過性の dbus / unit hang を 1 回 retry で吸収する想定)

set -uo pipefail

MEX_NEXT_DIR="${MEX_NEXT_DIR:-/opt/mex-next}"
MEX_NEXT_REF="${MEX_NEXT_REF:-main}"
BOT_SERVICE="${BOT_SERVICE:-mex-bot.service}"

log() { echo "[$(date -Iseconds)] [self-update] $*"; }
err() { echo "[$(date -Iseconds)] [self-update] [ERROR] $*" >&2; }

# Operator alert helper. NOOP when OPERATOR_DISCORD_WEBHOOK is unset.
# Errors from curl are swallowed — we don't want the alert path itself
# to mask the original failure.
send_alert() {
    local message="$1"
    if [ -n "${OPERATOR_DISCORD_WEBHOOK:-}" ]; then
        curl -sS -X POST "${OPERATOR_DISCORD_WEBHOOK}" \
            -H "Content-Type: application/json" \
            -d "$(printf '{"content":"[mex-self-update FAIL] %s"}' "${message//\"/\\\"}")" \
            >/dev/null 2>&1 || true
    fi
}

# Backwards-compat alias — older versions called this `alert_operator`.
alert_operator() { send_alert "$@"; }

run_step() {
    local label="$1"; shift
    log "step: ${label}"
    if ! "$@"; then
        err "${label} 失敗 (rc=$?)"
        send_alert "${label} 失敗"
        return 1
    fi
}

# Restart the bot service with a single fallback attempt.
#
# Returns 0 on success (either initial restart or fallback start).
# Returns 1 if both attempts fail. The caller emits the operator
# alert with the combined context.
restart_bot_with_fallback() {
    if systemctl restart "${BOT_SERVICE}"; then
        log "${BOT_SERVICE} restart OK"
        return 0
    fi
    err "${BOT_SERVICE} restart failed — attempting fallback start"
    log "step: systemctl start --no-block ${BOT_SERVICE}"
    if systemctl start --no-block "${BOT_SERVICE}"; then
        log "${BOT_SERVICE} fallback start dispatched"
        return 0
    fi
    err "${BOT_SERVICE} fallback start also failed"
    return 1
}

main() {
    log "self-update start (${MEX_NEXT_DIR} @ ${MEX_NEXT_REF})"

    if [ ! -d "${MEX_NEXT_DIR}/.git" ]; then
        err "${MEX_NEXT_DIR} is not a git repo, abort"
        send_alert "${MEX_NEXT_DIR} is not a git repo"
        exit 1
    fi

    cd "${MEX_NEXT_DIR}"

    run_step "git fetch"     git fetch origin --prune        || exit 1
    run_step "git reset"     git reset --hard "origin/${MEX_NEXT_REF}" || exit 1
    run_step "npm ci"        npm ci                          || exit 1
    run_step "npm run build" npm run build                   || exit 1

    log "build OK -> restart ${BOT_SERVICE}"
    if ! restart_bot_with_fallback; then
        send_alert "${BOT_SERVICE} restart + fallback start both failed"
        exit 1
    fi

    log "self-update done"
}

# When sourced (e.g. by tests), expose helpers without running main.
if [ "${BASH_SOURCE[0]:-$0}" = "${0}" ]; then
    main "$@"
fi
