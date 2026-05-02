#!/usr/bin/env bash
# MeX Next install script for Ubuntu 22.04 / 24.04 LTS.
#
# 使い方 (VPS で root):
#   curl -fsSL https://raw.githubusercontent.com/zumizumi-3/mex-next/main/scripts/install.sh | bash
#
# 冪等。何度走らせても OK。やること:
#   [1] apt basics + build-essential
#   [2] Node.js 20 LTS (NodeSource)
#   [3] gh CLI
#   [4] doppler CLI
#   [5] Claude Code CLI (npm global)
#   [6] mex-next を /opt/mex-next に clone (or pull) → npm ci → npm run build
#   [7] sanity check
#
# ENV:
#   MEX_NEXT_REPO_URL  default: https://github.com/zumizumi-3/mex-next.git
#   MEX_NEXT_REF       default: main

set -euo pipefail

MEX_NEXT_REPO_URL="${MEX_NEXT_REPO_URL:-https://github.com/zumizumi-3/mex-next.git}"
MEX_NEXT_REF="${MEX_NEXT_REF:-main}"
MEX_NEXT_DIR="/opt/mex-next"

log()  { echo "[$(date -Iseconds)] $*"; }
fail() { echo "[FATAL] $*" >&2; exit 1; }
has()  { command -v "$1" >/dev/null 2>&1; }

if [ "$EUID" -ne 0 ]; then
    fail "root として実行してください (apt / /opt 操作のため)"
fi

# ------------ [1] apt basics ------------
install_apt_basics() {
    log "[1/7] apt basics + build tools"
    apt update -qq
    apt install -y \
        git curl jq tmux \
        build-essential software-properties-common \
        ca-certificates gnupg lsb-release
}

# ------------ [2] Node.js 20 LTS ------------
install_node() {
    log "[2/7] Node.js 20 LTS"
    if has node && node --version | grep -qE '^v(2[0-9]|[3-9][0-9])'; then
        log "Node.js 既存: $(node --version) (skip)"
        return 0
    fi
    log "Node.js 20 を NodeSource から install"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
    log "node $(node --version), npm $(npm --version)"
}

# ------------ [3] gh CLI ------------
install_gh() {
    log "[3/7] gh CLI"
    if has gh; then
        log "gh 既存: $(gh --version | head -1) (skip)"
        return 0
    fi
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null
    chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list
    apt update -qq
    apt install -y gh
    log "gh $(gh --version | head -1)"
}

# ------------ [4] doppler CLI ------------
install_doppler() {
    log "[4/7] doppler CLI"
    if has doppler; then
        log "doppler 既存: $(doppler --version) (skip)"
        return 0
    fi
    curl -fsSL https://cli.doppler.com/install.sh | sh
    log "doppler $(doppler --version)"
}

# ------------ [5] Claude Code ------------
install_claude_code() {
    log "[5/7] Claude Code CLI"
    if has claude; then
        log "Claude Code 既存: $(claude --version 2>&1 | head -1) (skip)"
        return 0
    fi
    npm install -g @anthropic-ai/claude-code
    log "claude $(claude --version 2>&1 | head -1)"
}

# ------------ [6] mex-next clone + build ------------
install_mex_next() {
    log "[6/7] mex-next install (${MEX_NEXT_DIR})"
    if [ ! -d "${MEX_NEXT_DIR}/.git" ]; then
        log "git clone ${MEX_NEXT_REPO_URL} → ${MEX_NEXT_DIR}"
        git clone "${MEX_NEXT_REPO_URL}" "${MEX_NEXT_DIR}"
    else
        log "既存 repo を fetch"
        git -C "${MEX_NEXT_DIR}" fetch origin
    fi
    git -C "${MEX_NEXT_DIR}" checkout "${MEX_NEXT_REF}"
    git -C "${MEX_NEXT_DIR}" reset --hard "origin/${MEX_NEXT_REF}"

    log "npm ci (production deps + build deps)"
    # build に typescript が必要なので omit=dev は使わない (build 後に再度 install で omit=dev は self-update.sh 側で)
    (cd "${MEX_NEXT_DIR}" && npm ci)

    log "npm run build"
    (cd "${MEX_NEXT_DIR}" && npm run build)
}

# ------------ [7] sanity check ------------
sanity_check() {
    log "[7/7] sanity check"
    if [ ! -f "${MEX_NEXT_DIR}/dist/main.js" ]; then
        fail "build 失敗: ${MEX_NEXT_DIR}/dist/main.js が無い"
    fi
    log "main.js: $(ls -la ${MEX_NEXT_DIR}/dist/main.js)"
    log "node version: $(node --version)"
    log "npm version: $(npm --version)"
}

# ------------ summary ------------
finish() {
    log "install 完了"
    cat <<'EOF'

============================================================
MeX Next install 完了。次の step:

  1) claude login        # Anthropic OAuth
  2) gh auth login       # GitHub login
  3) doppler login       # Doppler login

その後 operator が:
  4) bash /opt/mex-next/scripts/bootstrap.sh

詳細: /opt/mex-next/docs/operator/
============================================================
EOF
}

main() {
    install_apt_basics
    install_node
    install_gh
    install_doppler
    install_claude_code
    install_mex_next
    sanity_check
    finish
}

main "$@"
