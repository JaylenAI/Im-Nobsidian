# fresh-user E2E 하니스

"새 유저처럼" Im-Nobsidian 의 전 CLI 명령어(init·pull·push·sync)를 **실제 Notion** 대상으로
구동해 Notion↔Obsidian 동기화 충실도를 매 실행 재현 검증한다.

## 구성

```
scripts/e2e/
├── run.sh            # 메인 오케스트레이터 (단계별 phase 함수)
├── analyze.mjs       # pull 결과 + 상태 DB 무결성 분석기 (충돌접미사·중복 page_id·folder-note 위치)
│                     #   ※ 오프라인 전용(FS+상태DB) — 원격을 안 보므로 미발견은 못 잡는다 → `verify` 단계가 담당
├── lib/
│   ├── common.sh     # 경로 SSOT · .env 안전 로드 · redaction CLI 래퍼 · JSON 판정 · 볼트 가드
│   ├── cleanup-probe.mjs  # roundtrip probe 를 Notion 휴지통 · 상태 DB · 볼트에서 치운다
│   └── redact.mjs    # 비밀정보(토큰·서명URL) 마스킹 필터 (stdin→stdout)
└── README.md
```

## 사용

```bash
pnpm --filter @im-nobsidian/core --filter im-nobsidian build   # 최신 코드 반영
scripts/e2e/run.sh            # 안전 베이스라인 (Notion 쓰기 0 · 볼트를 비우지 않음)
scripts/e2e/run.sh pull analyze   # 특정 단계만
IM_E2E_ALLOW_RESET=1 scripts/e2e/run.sh fresh   # 볼트를 새 유저 상태로 → init → 베이스라인
IM_E2E_ALLOW_RESET=1 scripts/e2e/run.sh full    # fresh + sync + 격리 probe 실쓰기 왕복
IM_TEST_VAULT=/tmp/v scripts/e2e/run.sh   # 볼트 경로 재정의
```

결과는 화면 요약과 함께 `$LOGDIR/summary.json` 으로도 남는다(단계별 결과 · 소요 초).

## 볼트를 비우는 단계(`reset`)의 안전장치

예전에는 인자 없이 부르면 `reset` 이 기본으로 돌아 볼트를 `rm -rf` 했다. 지금은:

- `IM_E2E_ALLOW_RESET=1` 을 명시해야만 돈다. 인자 없는 기본 실행에는 `reset` 이 없다.
- 지우지 않고 **백업 폴더로 옮긴다** — `<볼트>.e2e-backup-<시각>` (`IM_E2E_BACKUP_DIR` 로
  위치 변경). 되돌리는 명령을 화면에 찍는다. 백업은 스스로 지우지 않는다.
- 옮기기 전에 경로 가드를 통과해야 한다: 절대 경로여야 하고, `/` · `$HOME` · 레포 안은
  거부한다. 비어 있지 않은데 `.im-nobsidian/` 가 없으면(Im-Nobsidian 볼트가 아니면) 거부하고,
  Obsidian 에 **열려 있는** 볼트도 거부한다.
- `reset`·`init` 없이 시작하는데 볼트가 초기화돼 있지 않으면 추측하지 않고 멈춘다.

## 판정은 JSON 으로

멱등 단계(`repull`·`pushdry`·`sync`)는 CLI `--json` 결과의 `churn` 으로 판정한다
(pull 은 생성+수정+삭제+**복원**, push 는 생성+수정+삭제). 사람용 문구를 grep 하던 예전
판정은 조용히 틀렸다 — sync 로그에 Pull 쪽 `no changes` 한 줄만 있어도 Push 변경과 무관하게
0 으로 봤고, `restored`·`deleted` 는 아예 세지 않았다. `sync` 는 실제로 push 하므로 직전
`pushdry` 가 멱등이 아니면 돌지 않는다.

## 단계

| 단계        | 동작                                                             |  Notion 쓰기   |
| ----------- | ---------------------------------------------------------------- | :------------: |
| `reset`     | 볼트(+상태 DB)를 백업 폴더로 옮기고 새 유저 상태로(허용 필요)    |       —        |
| `init`      | 비대화형 초기 설정                                               |       —        |
| `pull`      | Notion → Obsidian                                                |      읽기      |
| `analyze`   | 무결성 검사(충돌접미사·중복 page_id·folder-note 위치·고아)       |       —        |
| `verify`    | **완결성**(원격 행·페이지 = 볼트 행·페이지) — 체계적 미발견 차단 |      읽기      |
| `repull`    | pull 멱등성(재실행 churn 0 기대)                                 |      읽기      |
| `pushdry`   | push 멱등성(dry-run, churn 0 기대)                               |      없음      |
| `sync`      | 양방향 멱등성(직전 `pushdry` 가 0 일 때만)                       |  쓰기(변경 0)  |
| `roundtrip` | `__e2e_probe__` 격리 실쓰기 왕복 → 이번에 만든 것만 정리         | **쓰기(격리)** |

## 안전 규칙

- 토큰은 in-process 로만 다루며 절대 출력하지 않는다 — 모든 출력은 `redact.mjs` 통과.
- 베이스라인은 Notion 쓰기 0(읽기·드라이런)이라 기존 노트를 변형하지 않는다.
- 실쓰기는 `roundtrip` 에서만, `__e2e_probe__` 네임스페이스에 격리. 끝나면
  `cleanup-probe.mjs` 가 **이번 실행이 만든 레코드만** Notion 휴지통 · 상태 DB · 볼트에서
  치운다. 이 폴더는 다른 시험도 쓰는 네임스페이스라 폴더째 치우지 않는다 — 이미 있던
  probe 페이지는 갱신만 되고 남는다(실행을 거듭해도 쌓이지 않는다). 휴지통 이동이 전부
  성공했을 때만 로컬을 지워, 실패하면 다음 정리가 같은 레코드로 다시 시도한다.
- `deleteSync` 기본 false → 파괴적 삭제 전파 없음.
- 테스트 볼트(`$HOME/im-nobsidian-test`)는 레포 밖이라 절대 커밋되지 않는다.

## 멱등성과 완결성은 다른 성질이다

`analyze`·`repull`·`pushdry`·`sync` 는 전부 **멱등성**(재실행해도 안 바뀐다)을 본다.
멱등성은 *체계적 미발견*을 구조적으로 잡지 못한다 — 디스커버리가 매번 **같은 것을 똑같이**
놓치면 두 번째 실행도 첫 번째와 결과가 같아 churn 은 0 이고 해시도 전부 일치한다.
실제로 2026-07-17 pull 은 DB 행 296개를 침묵 유실한 채 이 하니스의 모든 단계를 통과했다.

더 고약한 변형도 실측됐다. 2026-07-28 pull 은 페이지를 **268개(search 폴백) / 342개(순회
완주)** 로 다르게 열거하고도 `repull churn 0` 을 통과했다 — churn 은 created+updated 만
세므로 **두 번째 열거가 더 작아도 일치와 구분되지 않는다**. "안 바뀐다"는 "빠짐없다"의
증거가 아니다.

`verify` 단계만 **완결성**(원격에 있는 게 볼트에도 다 있다)을 본다. 두 축을 본다 —
database 별 행 집합(R11-B), 그리고 root 하위 페이지 집합(R12-C). 카운트가 아니라 집합을
비교하므로 "미발견 1건 + 잔재 1건"이 상쇄돼 통과하는 일이 없다. 페이지 축은 **pull 과
일부러 다른 열거**(workspace search)를 써서 교차 대조한다 — 같은 경로로 두 번 세면
경로가 가진 편향을 둘 다 똑같이 물려받는다.
