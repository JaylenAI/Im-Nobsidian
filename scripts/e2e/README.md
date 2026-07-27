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
│   ├── common.sh     # 경로 SSOT · .env 안전 로드 · redaction CLI 래퍼
│   └── redact.mjs    # 비밀정보(토큰·서명URL) 마스킹 필터 (stdin→stdout)
└── README.md
```

## 사용

```bash
pnpm --filter @im-nobsidian/core --filter im-nobsidian build   # 최신 코드 반영
scripts/e2e/run.sh            # 안전 베이스라인 (Notion 쓰기 0)
scripts/e2e/run.sh full       # 베이스라인 + 격리 probe 실쓰기 왕복
scripts/e2e/run.sh pull analyze   # 특정 단계만
IM_TEST_VAULT=/tmp/v scripts/e2e/run.sh   # 볼트 경로 재정의
```

## 단계

| 단계        | 동작                                                       |  Notion 쓰기   |
| ----------- | ---------------------------------------------------------- | :------------: |
| `reset`     | 볼트(+상태 DB) 완전 초기화 → 새 유저                       |       —        |
| `init`      | 비대화형 초기 설정                                         |       —        |
| `pull`      | Notion → Obsidian                                          |      읽기      |
| `analyze`   | 무결성 검사(충돌접미사·중복 page_id·folder-note 위치·고아) |       —        |
| `verify`    | **DB 완결성**(원격 행 = 볼트 행) — 체계적 미발견 차단      |      읽기      |
| `repull`    | pull 멱등성(재실행 churn 0 기대)                           |      읽기      |
| `pushdry`   | push 멱등성(dry-run, churn 0 기대)                         |      없음      |
| `roundtrip` | `__e2e_probe__` 격리 실쓰기 왕복                           | **쓰기(격리)** |

## 안전 규칙

- 토큰은 in-process 로만 다루며 절대 출력하지 않는다 — 모든 출력은 `redact.mjs` 통과.
- 베이스라인은 Notion 쓰기 0(읽기·드라이런)이라 기존 노트를 변형하지 않는다.
- 실쓰기는 `roundtrip` 에서만, `__e2e_probe__` 네임스페이스에 격리·자기정리.
- `deleteSync` 기본 false → 파괴적 삭제 전파 없음.
- 테스트 볼트(`$HOME/im-nobsidian-test`)는 레포 밖이라 절대 커밋되지 않는다.

## 멱등성과 완결성은 다른 성질이다

`analyze`·`repull`·`pushdry`·`sync` 는 전부 **멱등성**(재실행해도 안 바뀐다)을 본다.
멱등성은 *체계적 미발견*을 구조적으로 잡지 못한다 — 디스커버리가 매번 **같은 행을 똑같이**
놓치면 두 번째 실행도 첫 번째와 결과가 같아 churn 은 0 이고 해시도 전부 일치한다.
실제로 2026-07-17 pull 은 DB 행 296개를 침묵 유실한 채 이 하니스의 모든 단계를 통과했다.

`verify` 단계만 **완결성**(원격에 있는 게 볼트에도 다 있다)을 본다. 원격 행 id 집합과
볼트 db-row id 집합을 database 별로 직접 대조한다. 카운트가 아니라 집합을 비교하므로
"미발견 1건 + 잔재 1건"이 상쇄돼 통과하는 일이 없다.
