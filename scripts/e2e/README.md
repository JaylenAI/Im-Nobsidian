# fresh-user E2E 하니스

"새 유저처럼" Im-Nobsidian 의 전 CLI 명령어(init·pull·push·sync)를 **실제 Notion** 대상으로
구동해 Notion↔Obsidian 동기화 충실도를 매 실행 재현 검증한다.

## 구성

```
scripts/e2e/
├── run.sh            # 메인 오케스트레이터 (단계별 phase 함수)
├── analyze.mjs       # pull 결과 + 상태 DB 무결성 분석기 (충돌접미사·중복 page_id·folder-note 위치)
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
| `repull`    | pull 멱등성(재실행 churn 0 기대)                           |      읽기      |
| `pushdry`   | push 멱등성(dry-run, churn 0 기대)                         |      없음      |
| `roundtrip` | `__e2e_probe__` 격리 실쓰기 왕복                           | **쓰기(격리)** |

## 안전 규칙

- 토큰은 in-process 로만 다루며 절대 출력하지 않는다 — 모든 출력은 `redact.mjs` 통과.
- 베이스라인은 Notion 쓰기 0(읽기·드라이런)이라 기존 노트를 변형하지 않는다.
- 실쓰기는 `roundtrip` 에서만, `__e2e_probe__` 네임스페이스에 격리·자기정리.
- `deleteSync` 기본 false → 파괴적 삭제 전파 없음.
- 테스트 볼트(`$HOME/im-nobsidian-test`)는 레포 밖이라 절대 커밋되지 않는다.
