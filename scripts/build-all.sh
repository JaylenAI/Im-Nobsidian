#!/bin/bash
set -euo pipefail

echo "=== 전체 빌드 ==="

echo "[1/3] @im-nobsidian/core 빌드..."
pnpm --filter @im-nobsidian/core build

echo "[2/3] im-nobsidian CLI 빌드..."
pnpm --filter im-nobsidian build

echo "[3/3] Obsidian 플러그인 빌드..."
pnpm --filter obsidian-im-nobsidian build

echo ""
echo "=== 빌드 완료 ==="
