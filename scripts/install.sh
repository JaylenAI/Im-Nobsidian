#!/bin/bash
# Im-Nobsidian Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/JaylenAI/Obsidian_Notion_Syncer/main/scripts/install.sh | bash

set -euo pipefail

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# --- Helpers ---
info()    { echo -e "${BLUE}[info]${NC} $1"; }
success() { echo -e "${GREEN}[ok]${NC} $1"; }
warn()    { echo -e "${YELLOW}[warn]${NC} $1"; }
error()   { echo -e "${RED}[error]${NC} $1"; }

header() {
  echo ""
  echo -e "${BOLD}${CYAN}"
  echo "  ╔═══════════════════════════════════════╗"
  echo "  ║        Im-Nobsidian Installer          ║"
  echo "  ║   Obsidian ↔ Notion Bidirectional Sync ║"
  echo "  ╚═══════════════════════════════════════╝"
  echo -e "${NC}"
}

# --- OS Detection ---
detect_os() {
  OS="unknown"
  ARCH="$(uname -m)"

  case "$(uname -s)" in
    Linux*)
      if [ -f /data/data/com.termux/files/usr/bin/bash ]; then
        OS="termux"
      elif grep -qi microsoft /proc/version 2>/dev/null; then
        OS="wsl2"
      else
        OS="linux"
      fi
      ;;
    Darwin*)
      OS="macos"
      ;;
    MINGW*|MSYS*|CYGWIN*)
      OS="windows-git-bash"
      ;;
    *)
      OS="unknown"
      ;;
  esac

  echo "$OS"
}

# --- Node.js Check ---
check_node() {
  if command -v node &>/dev/null; then
    local node_version
    node_version=$(node -v | sed 's/v//' | cut -d'.' -f1)
    if [ "$node_version" -ge 20 ]; then
      success "Node.js $(node -v) detected"
      return 0
    else
      warn "Node.js $(node -v) found, but 20+ required"
      return 1
    fi
  else
    return 1
  fi
}

# --- Install Node.js ---
install_node() {
  local os="$1"

  info "Installing Node.js 22 LTS..."

  case "$os" in
    termux)
      info "Using pkg (Termux)..."
      pkg update -y && pkg install -y nodejs-lts
      ;;
    macos)
      if command -v brew &>/dev/null; then
        info "Using Homebrew..."
        brew install node@22
      else
        install_node_via_nvm
      fi
      ;;
    linux|wsl2)
      install_node_via_nvm
      ;;
    windows-git-bash)
      error "On Windows, use the PowerShell installer instead:"
      echo ""
      echo "  irm https://raw.githubusercontent.com/JaylenAI/Obsidian_Notion_Syncer/main/scripts/install.ps1 | iex"
      echo ""
      exit 1
      ;;
    *)
      error "Unsupported OS. Install Node.js 20+ manually: https://nodejs.org"
      exit 1
      ;;
  esac
}

install_node_via_nvm() {
  if command -v nvm &>/dev/null; then
    info "Using existing nvm..."
    nvm install 22
    nvm use 22
  elif [ -s "$HOME/.nvm/nvm.sh" ]; then
    info "Loading existing nvm..."
    export NVM_DIR="$HOME/.nvm"
    . "$NVM_DIR/nvm.sh"
    nvm install 22
    nvm use 22
  else
    info "Installing nvm..."
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash

    export NVM_DIR="$HOME/.nvm"
    . "$NVM_DIR/nvm.sh"

    nvm install 22
    nvm use 22
    success "nvm + Node.js 22 installed"
  fi
}

# --- Install Im-Nobsidian ---
install_im_nobsidian() {
  info "Installing im-nobsidian..."

  if command -v nobsi &>/dev/null; then
    local current_version
    current_version=$(nobsi --version 2>/dev/null || echo "unknown")
    warn "im-nobsidian $current_version already installed — upgrading..."
  fi

  npm install -g im-nobsidian

  if command -v nobsi &>/dev/null; then
    success "im-nobsidian $(nobsi --version) installed"
  else
    error "Installation failed. Try manually: npm install -g im-nobsidian"
    exit 1
  fi
}

# --- Verify ---
verify_installation() {
  info "Verifying installation..."

  local version
  version=$(nobsi --version 2>/dev/null)

  if [ -z "$version" ]; then
    error "Verification failed — nobsi not found in PATH"
    echo ""
    echo "Try reloading your shell:"
    echo "  source ~/.bashrc"
    echo "  source ~/.zshrc"
    exit 1
  fi

  success "im-nobsidian $version is ready"
}

# --- Print Success ---
print_success() {
  echo ""
  echo -e "${GREEN}${BOLD}  Installation complete!${NC}"
  echo ""
  echo -e "  ${BOLD}Getting started:${NC}"
  echo ""
  echo -e "    ${DIM}# Go to your Obsidian vault${NC}"
  echo -e "    ${CYAN}cd ~/your-obsidian-vault${NC}"
  echo ""
  echo -e "    ${DIM}# Set up Notion connection (interactive)${NC}"
  echo -e "    ${CYAN}nobsi init${NC}"
  echo ""
  echo -e "    ${DIM}# Sync both ways${NC}"
  echo -e "    ${CYAN}nobsi sync${NC}"
  echo ""
  echo -e "  ${BOLD}Other commands:${NC}"
  echo -e "    nobsi push      ${DIM}Obsidian → Notion${NC}"
  echo -e "    nobsi pull      ${DIM}Notion → Obsidian${NC}"
  echo -e "    nobsi status    ${DIM}Check sync status${NC}"
  echo -e "    nobsi watch     ${DIM}Auto-sync on file changes${NC}"
  echo ""
  echo -e "  ${BOLD}Need a Notion token?${NC}"
  echo -e "    https://www.notion.so/my-integrations"
  echo ""
  echo -e "  ${BOLD}Docs:${NC}"
  echo -e "    https://github.com/JaylenAI/Obsidian_Notion_Syncer"
  echo ""
}

# --- Main ---
main() {
  header

  local os
  os=$(detect_os)
  info "Detected OS: $os ($(uname -m))"

  if ! check_node; then
    install_node "$os"

    if ! check_node; then
      error "Node.js installation failed. Install manually: https://nodejs.org"
      exit 1
    fi
  fi

  install_im_nobsidian
  verify_installation
  print_success
}

main "$@"
