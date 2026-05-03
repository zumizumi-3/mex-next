#!/usr/bin/env bash
# Render and install per-account MeX Next systemd timer/service units.
#
# Usage:
#   ACCOUNT_ID=zumi-x bash scripts/install-systemd-units.sh
#   MEX_SYSTEMD_DRY_RUN=1 ACCOUNT_ID=zumi-x bash scripts/install-systemd-units.sh
#   bash scripts/install-systemd-units.sh zumi-x --dry-run

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MEX_NEXT_DIR="${MEX_NEXT_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
DEPLOY_TIMERS_DIR="${MEX_NEXT_DIR}/deploy/timers"
SYSTEMD_DIR="${MEX_SYSTEMD_UNIT_DIR:-/etc/systemd/system}"
DRY_RUN="${MEX_SYSTEMD_DRY_RUN:-0}"
ACCOUNT_ID="${ACCOUNT_ID:-}"

log() { echo "[install-systemd-units] $*"; }
fail() { echo "[install-systemd-units][FATAL] $*" >&2; exit 1; }
run() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    log "dry-run: $*"
  else
    "$@"
  fi
}
run_ignore() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    log "dry-run: $*"
  else
    "$@" >/dev/null 2>&1 || true
  fi
}

for arg in "$@"; do
  case "${arg}" in
    --dry-run)
      DRY_RUN=1
      ;;
    -*)
      fail "unknown option: ${arg}"
      ;;
    *)
      if [[ -n "${ACCOUNT_ID}" ]]; then
        fail "ACCOUNT_ID specified more than once"
      fi
      ACCOUNT_ID="${arg}"
      ;;
  esac
done

if [[ -z "${ACCOUNT_ID}" ]]; then
  fail "ACCOUNT_ID env or first argument is required"
fi
if [[ "${ACCOUNT_ID}" =~ [[:space:]] ]]; then
  fail "invalid ACCOUNT_ID: must not contain whitespace"
fi
if [[ ! "${ACCOUNT_ID}" =~ ^[a-z]([a-z0-9-]*[a-z0-9])?$ ]]; then
  fail "invalid ACCOUNT_ID: ${ACCOUNT_ID}"
fi
if [[ ! -d "${DEPLOY_TIMERS_DIR}" ]]; then
  fail "missing deploy timers dir: ${DEPLOY_TIMERS_DIR}"
fi
if [[ "${DRY_RUN}" != "1" && "${EUID}" -ne 0 ]]; then
  fail "root is required unless MEX_SYSTEMD_DRY_RUN=1"
fi

assert_unit_name() {
  local unit_name="$1"
  [[ "${unit_name}" =~ ^mex-[a-z-]+-${ACCOUNT_ID}\.(service|timer)$ ]] || {
    echo "invalid unit name: ${unit_name}" >&2
    exit 1
  }
}

render_template() {
  local src="$1"
  local dst="$2"
  local unit_name
  unit_name="$(basename "${dst}")"
  assert_unit_name "${unit_name}"
  log "render $(basename "${src}") -> ${dst}"
  if [[ "${DRY_RUN}" == "1" ]]; then
    echo "===== ${dst} ====="
    sed "s|{ACCOUNT_ID}|${ACCOUNT_ID}|g" "${src}"
    return 0
  fi
  local tmp
  tmp="$(mktemp)"
  sed "s|{ACCOUNT_ID}|${ACCOUNT_ID}|g" "${src}" > "${tmp}"
  install -m 0644 "${tmp}" "${dst}"
  rm -f "${tmp}"
}

mapfile -t SERVICE_TEMPLATES < <(find "${DEPLOY_TIMERS_DIR}" -maxdepth 1 -name '*.service.template' | sort)
if [[ "${#SERVICE_TEMPLATES[@]}" -eq 0 ]]; then
  fail "no service templates found in ${DEPLOY_TIMERS_DIR}"
fi

BASES=()
for svc_tmpl in "${SERVICE_TEMPLATES[@]}"; do
  base="$(basename "${svc_tmpl}" .service.template)"
  timer_tmpl="${DEPLOY_TIMERS_DIR}/${base}.timer.template"
  if [[ ! -f "${timer_tmpl}" ]]; then
    log "skip ${base}: missing timer template"
    continue
  fi
  BASES+=("${base}")
  service_unit="${base}-${ACCOUNT_ID}.service"
  timer_unit="${base}-${ACCOUNT_ID}.timer"
  assert_unit_name "${service_unit}"
  assert_unit_name "${timer_unit}"
  render_template "${svc_tmpl}" "${SYSTEMD_DIR}/${service_unit}"
  render_template "${timer_tmpl}" "${SYSTEMD_DIR}/${timer_unit}"
done

run systemctl daemon-reload

for base in "${BASES[@]}"; do
  unit_name="${base}-${ACCOUNT_ID}.timer"
  assert_unit_name "${unit_name}"
  run systemctl enable --now "${unit_name}"
  run systemctl restart "${unit_name}"
done

for base in "${BASES[@]}"; do
  legacy_service="${SYSTEMD_DIR}/${base}.service"
  legacy_timer="${SYSTEMD_DIR}/${base}.timer"
  run_ignore systemctl disable --now "${base}.timer"
  run_ignore systemctl disable --now "${base}.service"
  if [[ "${DRY_RUN}" == "1" ]]; then
    log "dry-run: rm -f ${legacy_service} ${legacy_timer}"
  else
    rm -f "${legacy_service}" "${legacy_timer}"
  fi
done

run systemctl daemon-reload
log "done: installed ${#BASES[@]} timer/service pairs for ${ACCOUNT_ID}"
