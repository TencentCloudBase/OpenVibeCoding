#!/bin/bash

# ========================================
#  Project Initialization Script
#  Entry point for setting up the project
#
#  Stateful 分支：init 写 .env.local + .env.cloud；不跑 Docker/TCR（见 scripts/init.mjs）
# ========================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# Print functions
print_step() {
    echo ""
    echo -e "${BOLD}${CYAN}━━━ $1 ━━━${RESET}"
}

print_ok() {
    echo -e "${GREEN}✓${RESET} $1"
}

print_warn() {
    echo -e "${YELLOW}!${RESET} $1"
}

print_error() {
    echo -e "${RED}✗${RESET} $1"
}

print_info() {
    echo -e "${CYAN}→${RESET} $1"
}

# ========================================
#  Check Node.js
# ========================================

check_node() {
    print_step "Checking Node.js"

    if ! command -v node &> /dev/null; then
        print_error "Node.js is not installed"
        echo ""
        echo "Please install Node.js 18 or later:"
        echo "  • Using nvm: nvm install 18"
        echo "  • Using fnm: fnm install 18"
        echo "  • Direct download: https://nodejs.org/"
        exit 1
    fi

    NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
    echo -e "Node.js version: $(node -v)"

    if [ "$NODE_VERSION" -lt 18 ]; then
        print_error "Node.js 18+ is required, but found version $NODE_VERSION"
        echo "Please upgrade Node.js to version 18 or later"
        exit 1
    fi

    print_ok "Node.js $NODE_VERSION meets requirements (>= 18)"
}

# ========================================
#  Check pnpm
# ========================================

check_pnpm() {
    print_step "Checking pnpm"

    if command -v pnpm &> /dev/null; then
        PNPM_VERSION=$(pnpm -v)
        print_ok "pnpm $PNPM_VERSION is installed"
        return 0
    fi

    print_warn "pnpm is not installed"

    # Try to install via corepack first
    if command -v corepack &> /dev/null; then
        print_info "Installing pnpm via corepack..."
        corepack enable
        corepack prepare pnpm@latest --activate
        print_ok "pnpm installed successfully"
        return 0
    fi

    # Try to install via npm
    if command -v npm &> /dev/null; then
        print_info "Installing pnpm via npm..."
        npm install -g pnpm
        print_ok "pnpm installed successfully"
        return 0
    fi

    print_error "Failed to install pnpm"
    echo "Please install pnpm manually:"
    echo "  npm install -g pnpm"
    echo "  # or"
    echo "  corepack enable && corepack prepare pnpm@latest --activate"
    exit 1
}

# ========================================
#  Main
# ========================================

echo ""
echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${CYAN}║     🚀 Project Initialization Script        ║${RESET}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════╝${RESET}"

# Check prerequisites
check_node
check_pnpm

print_ok "Ready to run initialization"

# Run the main initialization script
print_step "Running initialization"
exec node scripts/init.mjs "$@"
