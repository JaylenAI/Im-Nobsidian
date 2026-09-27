#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# fresh-user E2E 하니스 — "새 유저처럼" 전 명령어를 실제 Notion 대상으로 검증.
#
#   ./run.sh                    기본 = 안전 베이스라인(pull analyze verify repull pushdry)
#   ./run.sh pull analyze       지정 단계만
#   IM_E2E_ALLOW_RESET=1 ./run.sh fresh   볼트를 새 유저 상태로 → init → 베이스라인
#   IM_E2E_ALLOW_RESET=1 ./run.sh full    fresh + sync(양방향 멱등) + 격리 probe 왕복
#   IM_TEST_VAULT=/path ./run.sh          볼트 경로 재정의
#
# 안전 규칙:
#   · 기본 실행은 볼트를 비우지 않는다. reset 은 IM_E2E_ALLOW_RESET=1 일 때만 돌고,
#     경로 가드(assert_resettable_vault)를 통과해야 하며, 지우지 않고 백업 폴더로 옮긴다.
#     전에는 인자 없이 부르면 reset 이 기본으로 돌아 볼트를 `rm -rf` 했다.
#   · pull/repull/analyze/verify/pushdry 는 Notion 쓰기 0 (읽기·드라이런).
#   · sync 는 fresh pull 직후 실행 → 로컬==원격이라 푸시 변경 0(멱등). 기존 노트 불변.
#   · 실쓰기(roundtrip)는 __e2e_probe__ 네임스페이스에 격리하고, 끝나면 이번 실행이 만든
#     레코드만 Notion·상태 DB·볼트 세 곳에서 치운다(lib/cleanup-probe.mjs).
#   · deleteSync 기본 false → 파괴적 전파 없음.
#   · 토큰은 절대 출력되지 않음(redact.mjs 통과).
#
# 판정: 멱등 단계는 CLI `--json` 결과의 churn 으로 판정한다. 사람용 문구를 grep 하던
# 예전 판정은 두 가지로 조용히 틀렸다 — sync 로그에 Pull 쪽 "no changes" 한 줄만 있어도
# Push 변경과 무관하게 0 으로 봤고, restored·deleted 는 아예 세지 않았다.
# ─────────────────────────────────────────────────────────────────────────────
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

LOGDIR="$(mktemp -d)"
declare -A RESULTS  # phase -> 한줄 결과
declare -A SECONDS_OF  # phase -> 소요 초(JSON durationMs 기준)

PROBE="__e2e_probe__"
CLEANUP="$LIB_DIR/cleanup-probe.mjs"

# durationMs(JSON) → "12.3" 초. 없으면 빈 문자열.
seconds_of() {
  local ms; ms="$(json_get "$1" "$2")"
  [[ -n "$ms" ]] && awk -v ms="$ms" 'BEGIN { printf "%.1f", ms / 1000 }'
}

# 멱등 판정 공용 — churn 0 · 실패 0 이면 멱등. 실행 자체가 실패하면(JSON 없음) 실패.
judge_idempotent() {
  local key="$1" file="$2" churnKey="$3" failedKey="$4" label="$5"
  local churn failed
  churn="$(json_get "$file" "$churnKey")"
  failed="$(json_get "$file" "$failedKey")"
  if [[ -z "$churn" ]]; then
    err "$label — 결과 JSON 을 읽지 못함($file)"; RESULTS[$key]="실패"; return
  fi
  if [[ "$churn" == "0" && "${failed:-0}" == "0" ]]; then
    ok "$label 멱등 (churn 0)"; RESULTS[$key]="멱등(0)"
  else
    warn "$label churn=$churn · 실패=${failed:-0}"; RESULTS[$key]="churn=$churn"
  fi
}

# ─── 단계 ───
p_reset() {
  phase "RESET — 볼트를 새 유저 상태로(기존 볼트는 백업 폴더로 옮김)"
  if [[ "${IM_E2E_ALLOW_RESET:-}" != "1" ]]; then
    err "reset 은 볼트를 비우는 단계다 — IM_E2E_ALLOW_RESET=1 로 명시해야 돈다"
    exit 2
  fi
  assert_resettable_vault
  if [[ -e "$VAULT" ]]; then
    local backup="${IM_E2E_BACKUP_DIR:-$(dirname "$VAULT")}/$(basename "$VAULT").e2e-backup-$(date +%Y%m%d-%H%M%S)"
    mv "$VAULT" "$backup" || { err "백업 이동 실패 — reset 중단(볼트는 그대로)"; exit 1; }
    ok "기존 볼트 백업: $backup"
    log "되돌리기: rm -rf \"$VAULT\" && mv \"$backup\" \"$VAULT\""
    RESULTS[reset]="초기화(백업 $(basename "$backup"))"
  else
    RESULTS[reset]="초기화(기존 볼트 없음)"
  fi
  mkdir -p "$VAULT"
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
  nobsi_json pull pull
  local md failed
  md=$(find "$VAULT" -name '*.md' -not -path '*/.im-nobsidian/*' | wc -l)
  failed="$(json_get "$LOGDIR/pull.json" failed)"
  SECONDS_OF[pull]="$(seconds_of "$LOGDIR/pull.json" durationMs)"
  if [[ -z "$failed" ]]; then
    err "pull 결과 JSON 을 읽지 못함"; RESULTS[pull]="실패"; return
  fi
  if [[ "$failed" != "0" ]]; then
    warn "pull 실패 ${failed}건 — $LOGDIR/pull.json"
    RESULTS[pull]="실패(${failed}건)"; return
  fi
  RESULTS[pull]="md ${md}개 · ${SECONDS_OF[pull]}초"
  ok "pull 완료 — md ${md}개 · ${SECONDS_OF[pull]}초"
}

p_analyze() {
  phase "ANALYZE — 동기화 충실도 무결성 검사"
  if node "$ANALYZE" "$VAULT" >"$LOGDIR/analyze.json" 2>"$LOGDIR/analyze.err"; then
    cat "$LOGDIR/analyze.err"
    RESULTS[analyze]="CLEAN"
    ok "무결성 CLEAN"
  else
    cat "$LOGDIR/analyze.err"
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
  nobsi_json repull pull
  SECONDS_OF[repull]="$(seconds_of "$LOGDIR/repull.json" durationMs)"
  judge_idempotent repull "$LOGDIR/repull.json" churn failed "재pull(${SECONDS_OF[repull]}초)"
}

p_pushdry() {
  phase "PUSH(dry-run) — push 멱등성(쓰기 없이 변경 0 기대)"
  nobsi_json pushdry push --dry-run
  SECONDS_OF[pushdry]="$(seconds_of "$LOGDIR/pushdry.json" durationMs)"
  judge_idempotent pushdry "$LOGDIR/pushdry.json" churn failed "push 드라이런(${SECONDS_OF[pushdry]}초)"
}

# 양방향 동기화 명령 멱등성 — fresh pull 직후 로컬==원격이므로 변경 0 기대.
# (CLI `sync` = Pull → Push 의 단일 명령 검증. 실제 push 경로를 타되 변경분이 없어 비파괴.)
# 🔴 실제로 push 하는 단계다 — 직전 pushdry 가 멱등(0)이 아니면 돌지 않는다.
p_sync() {
  phase "SYNC — 양방향(Pull→Push) 멱등성(변경 0 기대)"
  if [[ -n "${RESULTS[pushdry]:-}" && "${RESULTS[pushdry]}" != "멱등(0)" ]]; then
    err "pushdry 가 멱등이 아니다(${RESULTS[pushdry]}) — 실제 push 를 막으려고 sync 를 건너뛴다"
    RESULTS[sync]="실패(pushdry 비멱등)"; return
  fi
  nobsi_json sync sync
  SECONDS_OF[sync]="$(seconds_of "$LOGDIR/sync.json" durationMs)"
  local failed pf qf
  pf="$(json_get "$LOGDIR/sync.json" pull.failed)"
  qf="$(json_get "$LOGDIR/sync.json" push.failed)"
  failed=$(( ${pf:-0} + ${qf:-0} ))
  judge_idempotent sync "$LOGDIR/sync.json" churn _none "sync(${SECONDS_OF[sync]}초)"
  if [[ "$failed" != "0" ]]; then
    warn "sync 실패 ${failed}건"; RESULTS[sync]="실패(${failed}건)"
  fi
}

# 격리 실쓰기 왕복 — __e2e_probe__ 안에서만. 기존 노트 불변.
# probe 파일 하나만 지웠다가 pull 로 되살린다(예전엔 probe 폴더째 지워 다른 시험의 probe
# 29개까지 복원 대상으로 끌어들였다). 끝나면 «이번 실행이 만든» 레코드만 세 곳에서 치운다.
p_roundtrip() {
  phase "ROUNDTRIP — 격리 probe 실쓰기 왕복(create→push→지우기→pull 복원→검증→정리)"
  local dir="$VAULT/$PROBE" file="$PROBE/probe.md"
  local marker="e2e-marker-$(find "$VAULT" -name '*.md' | wc -l)"  # 결정적(시계X) 유니크값
  local since; since="$(date -u '+%Y-%m-%d %H:%M:%S')"   # 상태 DB created_at 과 같은 형식(UTC)
  mkdir -p "$dir"
  printf '# E2E Probe\n\n%s\n\n- 리스트1\n- 리스트2\n' "$marker" > "$VAULT/$file"
  log "probe 노트 생성: $file (marker=$marker)"

  nobsi_json rt_push push --path "$file"
  local pushed; pushed="$(json_get "$LOGDIR/rt_push.json" churn)"
  if [[ -z "$pushed" || "$pushed" == "0" ]]; then
    err "probe push 가 아무것도 쓰지 않았다(churn=${pushed:-?})"; RESULTS[roundtrip]="손실"; return
  fi

  rm -f -- "${VAULT:?}/$file"
  nobsi_json rt_pull pull
  if [[ -f "$VAULT/$file" ]] && /usr/bin/grep -q "$marker" "$VAULT/$file"; then
    ok "왕복 무손실 — marker 보존"
    RESULTS[roundtrip]="무손실"
  else
    err "왕복 손실 — probe 본문 미복원"
    RESULTS[roundtrip]="손실"
  fi

  if node "$CLEANUP" "$VAULT" "$PROBE" "$since" 2>&1 | node "$REDACT" | tee "$LOGDIR/rt_cleanup.json"; then
    ok "probe 정리 — 이번 실행이 만든 레코드만(Notion 휴지통 · 상태 DB · 볼트)"
  else
    err "probe 정리 실패 — $LOGDIR/rt_cleanup.json (다음 정리가 같은 레코드로 다시 시도)"
    [[ "${RESULTS[roundtrip]}" == "무손실" ]] && RESULTS[roundtrip]="무손실·정리실패"
  fi
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
  # 기계가 읽는 요약 — 전후 비교·CI 가 문구를 grep 하지 않게.
  local args=()
  for k in "${!RESULTS[@]}"; do args+=("$k" "${RESULTS[$k]}" "${SECONDS_OF[$k]:-}"); done
  node -e '
    const a = process.argv.slice(1), out = {};
    for (let i = 0; i < a.length; i += 3)
      out[a[i]] = { result: a[i + 1], seconds: a[i + 2] === "" ? null : Number(a[i + 2]) };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  ' "${args[@]}" > "$LOGDIR/summary.json"
  echo "  요약 JSON: $LOGDIR/summary.json"
}

# 실행 단계 결과로 종합 성패를 판정한다 — 성공 0 / 실제 실패만 비0.
# (요약 루프의 마지막 `[[ ]] &&` 테스트가 미실행 단계에서 false 가 되어 스크립트
#  종료코드로 누수되던 문제를 막고, CI/자동화가 exit code 로 성패를 신뢰하게 한다.)
overall_status() {
  local k failed=0
  for k in "${!RESULTS[@]}"; do
    case "${RESULTS[$k]}" in
      실패* | 위반 | 손실 | 불완전 | churn=* | *정리실패)
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
  case "${phases[0]:-}" in
    "")    phases=(pull analyze verify repull pushdry) ;;
    fresh) phases=(reset init pull analyze verify repull pushdry) ;;
    full)  phases=(reset init pull analyze verify repull pushdry sync roundtrip) ;;
  esac

  # reset 없이 시작하는 실행은 이미 초기화된 볼트가 있어야 한다 — 없으면 무엇을 할지
  # 추측하지 않고 멈춘다(예전엔 기본값이 reset 이라 이 판단을 삭제로 대신했다).
  if [[ " ${phases[*]} " != *" reset "* && " ${phases[*]} " != *" init "* \
        && ! -f "$VAULT/.im-nobsidian/config.json" ]]; then
    err "초기화되지 않은 볼트: $VAULT"
    log "새 유저 시나리오: IM_E2E_ALLOW_RESET=1 $0 fresh"
    exit 2
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
