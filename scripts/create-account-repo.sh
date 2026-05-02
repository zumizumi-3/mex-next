#!/usr/bin/env bash
# Create a private MeX account ops repository and clone/scaffold it locally.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
STARTER_DIR="${REPO_ROOT}/templates/account-starter"

log() { echo "[$(date -Iseconds)] $*"; }
fail() { echo "create-account-repo: $*" >&2; exit 1; }
prompt() { read -rp "  > $1 " "$2" </dev/tty; }
confirm() {
    local message="$1"
    local default="${2:-n}"
    local answer
    local suffix="[y/N]"
    if [[ "$default" == "y" ]]; then
        suffix="[Y/n]"
    fi
    read -rp "  > ${message} ${suffix} " answer </dev/tty
    answer="${answer:-$default}"
    [[ "$answer" =~ ^[Yy]$|^[Yy][Ee][Ss]$ ]]
}
usage() {
    cat <<'EOF'
Usage: scripts/create-account-repo.sh <github-owner>/<repo-name> [<local-clone-path>]

Examples:
  scripts/create-account-repo.sh zumizumi-3/example-x-ops
  scripts/create-account-repo.sh tanaka-kun/tanaka-x-ops /srv/mex/tanaka-x-ops
EOF
}

copy_starter_contents() {
    local dest="$1"
    [ -d "$STARTER_DIR" ] || fail "starter template not found: $STARTER_DIR"
    find "$STARTER_DIR" -mindepth 1 -maxdepth 1 -exec cp -R {} "$dest"/ \;
}

ensure_destination_available() {
    local path="$1"
    if [ ! -e "$path" ]; then
        return 0
    fi
    if [ -d "$path" ] && [ -z "$(find "$path" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
        rmdir "$path"
        return 0
    fi
    if confirm "local clone path already exists: $path. Replace it?" "n"; then
        rm -rf "$path"
        return 0
    fi
    fail "local clone path exists: $path"
}

move_clone_if_needed() {
    local clone_dir="$1"
    local requested_path="${2:-}"
    if [ -z "$requested_path" ]; then
        printf '%s\n' "$clone_dir"
        return 0
    fi

    local requested_abs
    requested_abs="$(mkdir -p "$(dirname "$requested_path")" && cd "$(dirname "$requested_path")" && pwd)/$(basename "$requested_path")"
    local clone_abs
    clone_abs="$(cd "$clone_dir" && pwd)"
    if [ "$clone_abs" = "$requested_abs" ]; then
        printf '%s\n' "$clone_abs"
        return 0
    fi

    ensure_destination_available "$requested_abs"
    mkdir -p "$(dirname "$requested_abs")"
    mv "$clone_abs" "$requested_abs"
    printf '%s\n' "$requested_abs"
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
    usage
    exit 0
fi

[ "$#" -ge 1 ] && [ "$#" -le 2 ] || { usage >&2; exit 2; }

FULL_REPO="$1"
LOCAL_CLONE_PATH="${2:-}"
if [[ ! "$FULL_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    fail "repo must be in owner/name form: $FULL_REPO"
fi

command -v gh >/dev/null 2>&1 || fail "gh CLI is required"
command -v git >/dev/null 2>&1 || fail "git is required"
gh auth status >/dev/null 2>&1 || fail "gh auth status failed; run gh auth login first"

echo ""
echo "About to create a private MeX account ops repo:"
echo "  GitHub repo: $FULL_REPO"
if [ -n "$LOCAL_CLONE_PATH" ]; then
    echo "  Local path : $LOCAL_CLONE_PATH"
else
    echo "  Local path : ./$(basename "$FULL_REPO")"
fi
[ -z "${MEX_ACCOUNT_STARTER_REPO:-}" ] || echo "  Template   : $MEX_ACCOUNT_STARTER_REPO"
confirm "Create this private repo now?" "y" || fail "cancelled"

REPO_NAME="${FULL_REPO##*/}"
CLONE_DIR="$REPO_NAME"

if [ -n "${MEX_ACCOUNT_STARTER_REPO:-}" ]; then
    gh repo create "$FULL_REPO" \
        --template "$MEX_ACCOUNT_STARTER_REPO" \
        --private \
        --description "MeX account ops" \
        --clone
else
    gh repo create "$FULL_REPO" \
        --private \
        --description "MeX account ops" \
        --clone
    copy_starter_contents "$CLONE_DIR"
    (
        cd "$CLONE_DIR"
        git add -A
        git commit -m "chore: scaffold from mex-next account-starter"
        git push origin HEAD
    )
fi

FINAL_PATH="$(move_clone_if_needed "$CLONE_DIR" "$LOCAL_CLONE_PATH")"

cat <<EOF

Account repo ready:
  path: $FINAL_PATH
  repo: $FULL_REPO

Next: add this account to accounts-registry.json.
EOF
