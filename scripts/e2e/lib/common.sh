#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# E2E 하니스 공통 라이브러리 — 모든 스크립트가 source 한다.
#
# 책임: 경로 SSOT · .env 안전 로드 · 컬러 로깅 · redaction 통과 CLI 래퍼.
# 보안: 토큰은 in-process 로만 다루며 절대 echo/print 하지 않는다. 모든 CLI 출력은
#       redact.mjs 를 통과한다. set -x 금지(명령 인자 토큰 노출 방지).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

# 경로 SSOT
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_DIR="$(cd "$LIB_DIR/.." && pwd)"
REPO_ROOT="$(cd "$E2E_DIR/../.." && pwd)"
CLI="$REPO_ROOT/packages/cli/dist/index.js"
REDACT="$LIB_DIR/redact.mjs"
ANALYZE="$E2E_DIR/analyze.mjs"

# 테스트 볼트 — 레포 밖, 절대 커밋되지 않음. IM_TEST_VAULT 로 재정의 가능.
VAULT="${IM_TEST_VAULT:-$HOME/im-nobsidian-test}"

# 컬러 로깅
c_blue=$'\033[34m'; c_green=$'\033[32m'; c_red=$'\033[31m'; c_yellow=$'\033[33m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
log()   { echo "${c_blue}▶${c_off} $*"; }
ok()    { echo "${c_green}✓${c_off} $*"; }
warn()  { echo "${c_yellow}⚠${c_off} $*"; }
err()   { echo "${c_red}✗${c_off} $*"; }
phase() { echo; echo "${c_blue}━━━━━━ $* ━━━━━━${c_off}"; }

# .env 안전 로드 — 키 존재만 검증, 값은 출력하지 않는다.
load_env() {
  local envfile="$REPO_ROOT/.env"
  [[ -f "$envfile" ]] || { err ".env 없음: $envfile"; exit 1; }
  set -a; source "$envfile"; set +a
  [[ -n "${NOTION_TOKEN:-}" ]]        || { err "NOTION_TOKEN 미설정"; exit 1; }
  [[ -n "${NOTION_ROOT_PAGE_ID:-}" ]] || { err "NOTION_ROOT_PAGE_ID 미설정"; exit 1; }
}

# 빌드 산출물 확인.
require_build() {
  [[ -f "$CLI" ]] || { err "CLI dist 없음 — 'pnpm --filter im-nobsidian build' 먼저 실행: $CLI"; exit 1; }
}

# CLI 실행 — 볼트에서 cd 후 실행, 모든 출력 redaction 통과. 반환=CLI 종료코드.
nobsi() {
  ( cd "$VAULT" && node "$CLI" "$@" ) 2>&1 | node "$REDACT"
  return "${PIPESTATUS[0]}"
}

# 분석기 실행 — 무결성 위반 시 비0 반환.
analyze() {
  node "$ANALYZE" "$VAULT"
  return $?
}
