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

# CLI 를 --json 으로 실행 — stdout(JSON 한 줄)은 파일로, 로그(stderr)는 화면과 .log 로.
# 판정은 사람용 문구가 아니라 이 JSON 으로 한다(문구 grep 은 조용히 틀렸다 — run.sh 참고).
#   nobsi_json <이름> <CLI 인자...>   → $LOGDIR/<이름>.json · $LOGDIR/<이름>.log
nobsi_json() {
  local name="$1"; shift
  local status
  ( cd "$VAULT" && node "$CLI" "$@" --json ) \
    2> >(node "$REDACT" | tee "$LOGDIR/$name.log" >&2) \
    | node "$REDACT" > "$LOGDIR/$name.json"
  status="${PIPESTATUS[0]}"
  wait  # 프로세스 치환(stderr 필터)이 로그를 다 쓸 때까지
  return "$status"
}

# JSON 결과에서 값 하나를 꺼낸다. 없거나 해석 불가면 빈 문자열.
#   json_get <파일> <점경로>   예) json_get "$LOGDIR/sync.json" push.churn
json_get() {
  node -e '
    const fs = require("node:fs");
    try {
      let v = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      for (const k of process.argv[2].split(".")) v = v?.[k];
      if (Array.isArray(v)) v = v.length;
      process.stdout.write(v === undefined || v === null ? "" : String(v));
    } catch { process.stdout.write(""); }
  ' "$1" "$2"
}

# 이 경로가 Obsidian 에 «열려 있는» 볼트인가. 설정 파일을 못 찾으면 아니라고 본다.
vault_open_in_obsidian() {
  local target="$1" cfg
  for cfg in "$HOME/.config/obsidian/obsidian.json" \
             "$HOME/Library/Application Support/obsidian/obsidian.json"; do
    [[ -f "$cfg" ]] || continue
    if node -e '
      const fs = require("node:fs"), path = require("node:path");
      const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const want = path.resolve(process.argv[2]);
      const open = Object.values(cfg.vaults ?? {}).some(
        (v) => v && v.open === true && path.resolve(v.path) === want);
      process.exit(open ? 0 : 1);
    ' "$cfg" "$target"; then
      return 0
    fi
  done
  return 1
}

# 볼트를 비우거나 옮기기 «전» 가드. 하나라도 걸리면 아무것도 건드리지 않고 끝낸다.
#   · 절대 경로 · / · $HOME · 레포 안은 거부
#   · 비어 있지 않은데 .im-nobsidian/ 가 없으면 Im-Nobsidian 볼트가 아니다 → 거부
#   · Obsidian 에 열려 있는 볼트 → 거부
assert_resettable_vault() {
  local real
  [[ "$VAULT" = /* ]] || { err "볼트 경로가 절대 경로가 아님 — 거부: $VAULT"; exit 2; }
  real="$(realpath -m "$VAULT")"
  case "$real" in
    / | "$HOME" | "$REPO_ROOT" | "$REPO_ROOT"/*)
      err "위험한 볼트 경로 — 거부: $real"; exit 2 ;;
  esac
  if [[ -d "$real" && -n "$(ls -A "$real" 2>/dev/null)" && ! -d "$real/.im-nobsidian" ]]; then
    err "Im-Nobsidian 볼트가 아님(.im-nobsidian/ 없음) — 거부: $real"; exit 2
  fi
  if vault_open_in_obsidian "$real"; then
    err "Obsidian 에 열려 있는 볼트 — 거부: $real"; exit 2
  fi
}

# 분석기 실행 — 무결성 위반 시 비0 반환.
analyze() {
  node "$ANALYZE" "$VAULT"
  return $?
}
