#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# fresh-user E2E 하니스 — "새 유저처럼" 전 명령어를 실제 Notion 대상으로 검증.
#
#   ./run.sh [phase ...]        지정 단계만 (기본: 안전 베이스라인)
#   ./run.sh                    기본 = reset init pull analyze repull pushdry
#   ./run.sh full               안전 베이스라인 + 격리 probe 실쓰기 왕복(roundtrip)
#   IM_TEST_VAULT=/path ./run.sh   볼트 경로 재정의
#
# 안전 규칙:
#   · pull/repull/analyze/pushdry 는 Notion 쓰기 0 (읽기·드라이런).
#   · 실쓰기(roundtrip)는 __e2e_probe__ 네임스페이스에 격리, 자기정리. 기존 노트 불변.
#   · deleteSync 기본 false → 파괴적 전파 없음.
#   · 토큰은 절대 출력되지 않음(redact.mjs 통과).
# ─────────────────────────────────────────────────────────────────────────────
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

LOGDIR="$(mktemp -d)"
declare -A RESULTS  # phase -> 한줄 결과

# 멱등성 판정: 출력에 "no changes" 가 있으면 0, 아니면 created/updated 합.
churn_of() {
  local logf="$1"
  if /usr/bin/grep -q "no changes" "$logf"; then echo 0; return; fi
  local c u
  c=$(/usr/bin/grep -oE '[0-9]+ created' "$logf" | /usr/bin/grep -oE '[0-9]+' | head -1)
  u=$(/usr/bin/grep -oE '[0-9]+ updated' "$logf" | /usr/bin/grep -oE '[0-9]+' | head -1)
  echo $(( ${c:-0} + ${u:-0} ))
}

# ─── 단계 ───
p_reset() {
  phase "RESET — 볼트 완전 초기화(새 유저)"
  rm -rf "$VAULT"
  mkdir -p "$VAULT"
  ok "볼트 비움: $VAULT"
  RESULTS[reset]="볼트 초기화"
}

p_init() {
  phase "INIT — 비대화형 초기 설정"
  if nobsi init --non-interactive --token "$NOTION_TOKEN" --root-page-id "$NOTION_ROOT_PAGE_ID" | tee "$LOGDIR/init.log"; then
    [[ -f "$VAULT/.im-nobsidian/config.json" ]] && ok "config.json 생성" || { err "config.json 미생성"; RESULTS[init]="실패"; return 1; }
    RESULTS[init]="OK"
  else
    err "init 실패"; RESULTS[init]="실패"; return 1
  fi
}

p_pull() {
  phase "PULL — Notion → Obsidian (읽기)"
  nobsi pull | tee "$LOGDIR/pull.log"
  local md; md=$(find "$VAULT" -name '*.md' -not -path '*/.im-nobsidian/*' | wc -l)
  RESULTS[pull]="md ${md}개"
  ok "pull 완료 — md ${md}개"
}

p_analyze() {
  phase "ANALYZE — 동기화 충실도 무결성 검사"
  if node "$ANALYZE" "$VAULT" >"$LOGDIR/analyze.json" 2>/tmp/_an_err; then
    cat /tmp/_an_err
    RESULTS[analyze]="CLEAN"
    ok "무결성 CLEAN"
  else
    cat /tmp/_an_err
    RESULTS[analyze]="위반"
    err "무결성 위반 — analyze.json 참조"
  fi
}

p_repull() {
  phase "REPULL — pull 멱등성(재실행 시 변경 0 기대)"
  nobsi pull | tee "$LOGDIR/repull.log"
  local churn; churn=$(churn_of "$LOGDIR/repull.log")
  if [[ "$churn" == "0" ]]; then ok "pull 멱등 (churn 0)"; RESULTS[repull]="멱등(0)"; else warn "재pull churn=$churn"; RESULTS[repull]="churn=$churn"; fi
}

p_pushdry() {
  phase "PUSH(dry-run) — push 멱등성(쓰기 없이 변경 0 기대)"
  nobsi push --dry-run | tee "$LOGDIR/pushdry.log"
  local churn; churn=$(churn_of "$LOGDIR/pushdry.log")
  if [[ "$churn" == "0" ]]; then ok "push 멱등 (churn 0, 쓰기 없음)"; RESULTS[pushdry]="멱등(0)"; else warn "push 예정 변경 churn=$churn"; RESULTS[pushdry]="churn=$churn"; fi
}

# 격리 실쓰기 왕복 — __e2e_probe__ 안에서만. 기존 노트 불변.
p_roundtrip() {
  phase "ROUNDTRIP — 격리 probe 실쓰기 왕복(create→push→repull→검증→정리)"
  local probe="__e2e_probe__"
  local marker="e2e-marker-$(find "$VAULT" -name '*.md' | wc -l)"  # 결정적(시계X) 유니크값
  mkdir -p "$VAULT/$probe"
  printf '# E2E Probe\n\n%s\n\n- 리스트1\n- 리스트2\n' "$marker" > "$VAULT/$probe/probe.md"
  log "probe 노트 생성: $probe/probe.md (marker=$marker)"
  nobsi push | tee "$LOGDIR/rt_push.log"
  rm -rf "$VAULT/$probe"
  nobsi pull | tee "$LOGDIR/rt_pull.log"
  if [[ -f "$VAULT/$probe/probe.md" ]] && /usr/bin/grep -q "$marker" "$VAULT/$probe/probe.md"; then
    ok "왕복 무손실 — marker 보존"
    RESULTS[roundtrip]="무손실"
  else
    err "왕복 손실 — probe 본문 미복원"
    RESULTS[roundtrip]="손실"
  fi
  warn "정리 안내: Notion 의 '$probe' 페이지는 수동 또는 deleteSync 로 제거 필요"
}

p_summary() {
  phase "요약"
  echo "  로그: $LOGDIR"
  local k
  for k in reset init pull analyze repull pushdry roundtrip; do
    if [[ -n "${RESULTS[$k]:-}" ]]; then
      printf "  %-10s %s\n" "$k" "${RESULTS[$k]}"
    fi
  done
}

# 실행 단계 결과로 종합 성패를 판정한다 — 성공 0 / 실제 실패만 비0.
# (요약 루프의 마지막 `[[ ]] &&` 테스트가 미실행 단계에서 false 가 되어 스크립트
#  종료코드로 누수되던 문제를 막고, CI/자동화가 exit code 로 성패를 신뢰하게 한다.)
overall_status() {
  local k failed=0
  for k in "${!RESULTS[@]}"; do
    case "${RESULTS[$k]}" in
      실패 | 위반 | 손실 | churn=*)
        failed=1
        err "단계 실패: ${k}=${RESULTS[$k]}"
        ;;
    esac
  done
  if [[ $failed -eq 0 ]]; then ok "E2E 전체 통과"; fi
  return "$failed"
}

# ─── 메인 ───
main() {
  require_build
  load_env

  local phases=("$@")
  if [[ ${#phases[@]} -eq 0 ]]; then
    phases=(reset init pull analyze repull pushdry)
  elif [[ "${phases[0]}" == "full" ]]; then
    phases=(reset init pull analyze repull pushdry roundtrip)
  fi

  log "테스트 볼트: $VAULT"
  log "단계: ${phases[*]}"
  for ph in "${phases[@]}"; do
    case "$ph" in
      reset)     p_reset ;;
      init)      p_init || exit 1 ;;
      pull)      p_pull ;;
      analyze)   p_analyze ;;
      repull)    p_repull ;;
      pushdry)   p_pushdry ;;
      roundtrip) p_roundtrip ;;
      *) err "알 수 없는 단계: $ph"; exit 2 ;;
    esac
  done
  p_summary
  overall_status
}

main "$@"
