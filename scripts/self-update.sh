#!/usr/bin/env bash
# self-update.sh — git pull + build + restart bot
#
# `mex-self-update.service` の ExecStart から呼ばれる。
# 失敗時は restart せず log だけ残す (best effort で operator alert)。

set -uo pipefail

MEX_NEXT_DIR="${MEX_NEXT_DIR:-/opt/mex-next}"
MEX_NEXT_REF="${MEX_NEXT_REF:-main}"
BOT_SERVICE="${BOT_SERVICE:-mex-bot.service}"

log() { echo "[$(date -Iseconds)] [self-update] $*"; }
err() { echo "[$(date -Iseconds)] [self-update] [ERROR] $*" >&2; }

alert_operator() {
    local message="$1"
    if [ -n "${OPERATOR_DISCORD_WEBHOOK:-}" ]; then
        curl -sS -X POST "${OPERATOR_DISCORD_WEBHOOK}" \
            -H "Content-Type: application/json" \
            -d "$(printf '{"content":"[mex-self-update FAIL] %s"}' "${message//\"/\\\"}")" \
            >/dev/null 2>&1 || true
    fi
}

run_step() {
    local label="$1"; shift
    log "step: ${label}"
    if ! "$@"; then
        err "${label} 失敗 (rc=$?)"
        alert_operator "${label} 失敗"
        return 1
    fi
}

main() {
    log "self-update start (${MEX_NEXT_DIR} @ ${MEX_NEXT_REF})"

    if [ ! -d "${MEX_NEXT_DIR}/.git" ]; then
        err "${MEX_NEXT_DIR} is not a git repo, abort"
        alert_operator "${MEX_NEXT_DIR} is not a git repo"
        exit 1
    fi

    cd "${MEX_NEXT_DIR}"

    run_step "git fetch"     git fetch origin --prune        || exit 1
    run_step "git reset"     git reset --hard "origin/${MEX_NEXT_REF}" || exit 1
    run_step "npm ci"        npm ci                          || exit 1
    run_step "npm run build" npm run build                   || exit 1

    log "build OK -> restart ${BOT_SERVICE}"
    if ! systemctl restart "${BOT_SERVICE}"; then
        err "${BOT_SERVICE} restart failed"
        alert_operator "${BOT_SERVICE} restart failed"
        exit 1
    fi

    log "self-update done"
}

main "$@"
