#!/bin/bash
set -euo pipefail

echo "=== 전체 빌드 ==="

echo "[1/3] @obsinotion/core 빌드..."
pnpm --filter @obsinotion/core build

echo "[2/3] obsinotion CLI 빌드..."
pnpm --filter obsinotion build

echo "[3/3] Obsidian 플러그인 빌드..."
pnpm --filter obsidian-obsinotion build

echo ""
echo "=== 빌드 완료 ==="
