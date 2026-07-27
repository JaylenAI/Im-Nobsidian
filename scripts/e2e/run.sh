#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# fresh-user E2E 하니스 — "새 유저처럼" 전 명령어를 실제 Notion 대상으로 검증.
#
#   ./run.sh [phase ...]        지정 단계만 (기본: 안전 베이스라인)
#   ./run.sh                    기본 = reset init pull analyze verify repull pushdry
#   ./run.sh full               안전 베이스라인 + sync(양방향 멱등) + 격리 probe 왕복
#   IM_TEST_VAULT=/path ./run.sh   볼트 경로 재정의
#
# 안전 규칙:
#   · pull/repull/analyze/verify/pushdry 는 Notion 쓰기 0 (읽기·드라이런).
#   · sync 는 fresh pull 직후 실행 → 로컬==원격이라 푸시 변경 0(멱등). 기존 노트 불변.
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

# 완결성 — 원격에 있는 것이 볼트에 빠짐없이 있는가(행 R11-B · 페이지 R12-C).
#
# 나머지 단계는 전부 **멱등성**을 본다(analyze·repull·pushdry·sync). 멱등성은 체계적
# 미발견을 구조적으로 못 잡는다 — 디스커버리가 매번 같은 행을 놓치면 재실행 결과도
# 똑같아 churn 은 0 이고 해시도 전부 일치한다. 실제로 2026-07-17 pull 은 DB 행 296개를
# 침묵 유실한 채 이 하니스의 전 단계를 통과했고, 2026-07-28 pull 은 페이지를 268 → 342
# 로 다르게 열거하고도 repull churn 0 을 통과했다(churn 은 created+updated 만 세므로
# 두 번째 열거가 더 작아도 일치와 구분되지 않는다). 이 단계만 "빠짐없다"를 본다.
# 읽기 전용(databases.retrieve + dataSources.query + search)이라 기본 베이스라인에 넣는다.
p_verify() {
  phase "VERIFY — 완결성(원격 행/페이지 = 볼트 행/페이지)"
  if nobsi verify | tee "$LOGDIR/verify.log"; then
    local remote vault premote pvault
    remote=$(/usr/bin/grep -oE 'Remote rows: *[0-9]+' "$LOGDIR/verify.log" | /usr/bin/grep -oE '[0-9]+' | head -1)
    vault=$(/usr/bin/grep -oE 'Vault rows: *[0-9]+' "$LOGDIR/verify.log" | /usr/bin/grep -oE '[0-9]+' | head -1)
    premote=$(/usr/bin/grep -oE 'Remote pages: *[0-9]+' "$LOGDIR/verify.log" | /usr/bin/grep -oE '[0-9]+' | head -1)
    pvault=$(/usr/bin/grep -oE 'Vault pages: *[0-9]+' "$LOGDIR/verify.log" | /usr/bin/grep -oE '[0-9]+' | head -1)
    ok "완결성 PASS — 행 ${remote:-?}=${vault:-?} · 페이지 원격 ${premote:-생략} ⊆ 볼트 ${pvault:-생략}"
    RESULTS[verify]="완결(행 ${remote:-?}=${vault:-?}·쪽 ${premote:-–}/${pvault:-–})"
  else
    err "완결성 FAIL — verify.log 참조(미발견/잔재/조회실패)"
    RESULTS[verify]="불완전"
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

# 양방향 동기화 명령 멱등성 — fresh pull 직후 로컬==원격이므로 변경 0 기대.
# (CLI `sync` = Pull → Push 의 단일 명령 검증. 실제 push 경로를 타되 변경분이 없어 비파괴.)
p_sync() {
  phase "SYNC — 양방향(Pull→Push) 멱등성(변경 0 기대)"
  nobsi sync | tee "$LOGDIR/sync.log"
  local churn; churn=$(churn_of "$LOGDIR/sync.log")
  if [[ "$churn" == "0" ]]; then ok "sync 멱등 (churn 0)"; RESULTS[sync]="멱등(0)"; else warn "sync churn=$churn"; RESULTS[sync]="churn=$churn"; fi
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
  for k in reset init pull analyze verify repull pushdry sync roundtrip; do
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
      실패 | 위반 | 손실 | 불완전 | churn=*)
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
    phases=(reset init pull analyze verify repull pushdry)
  elif [[ "${phases[0]}" == "full" ]]; then
    phases=(reset init pull analyze verify repull pushdry sync roundtrip)
  fi

  log "테스트 볼트: $VAULT"
  log "단계: ${phases[*]}"
  for ph in "${phases[@]}"; do
    case "$ph" in
      reset)     p_reset ;;
      init)      p_init || exit 1 ;;
      pull)      p_pull ;;
      analyze)   p_analyze ;;
      verify)    p_verify ;;
      repull)    p_repull ;;
      pushdry)   p_pushdry ;;
      sync)      p_sync ;;
      roundtrip) p_roundtrip ;;
      *) err "알 수 없는 단계: $ph"; exit 2 ;;
    esac
  done
  p_summary
  overall_status
}

main "$@"
