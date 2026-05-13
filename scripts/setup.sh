#!/bin/bash
set -euo pipefail

echo "=== Im-Nobsidian 개발 환경 세팅 ==="

# Node.js 버전 확인
NODE_VERSION=$(node -v | cut -d'.' -f1 | tr -d 'v')
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "ERROR: Node.js 20+ 필요 (현재: $(node -v))"
  exit 1
fi

# pnpm 확인
if ! command -v pnpm &> /dev/null; then
  echo "pnpm 설치 중..."
  npm install -g pnpm
fi

# 의존성 설치
echo "의존성 설치 중..."
pnpm install

# Husky 초기화
echo "Husky 초기화 중..."
pnpm prepare

# 환경변수 파일
if [ ! -f .env ]; then
  cp .env.example .env
  echo ".env 파일 생성됨 — 토큰 설정 필요"
fi

# 빌드 확인
echo "빌드 확인 중..."
pnpm build

echo ""
echo "=== 세팅 완료! ==="
echo ""
echo "다음 단계:"
echo "  1. .env 파일에 NOTION_TOKEN 설정"
echo "  2. pnpm test 로 테스트 실행"
echo "  3. pnpm dev 로 개발 시작"
