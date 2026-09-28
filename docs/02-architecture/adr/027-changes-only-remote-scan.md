# ADR-027: 원격은 바뀐 것만 찾고, 전체 대조는 주기마다 한다

> 상태: 승인
> 결정일: 2026-09-28

## 맥락

pull 이 원격을 보는 방식은 둘이었다.

- **전체 대조** — 루트 아래 페이지를 모두 순회하고, 추적 중인데 목록에 없는 페이지를 원격에 물어 삭제를 가른다.
  원격에서 지운 것 · 범위 밖으로 옮긴 것은 이것으로만 보인다. search 는 휴지통에 든 페이지를 돌려주지 않는다.
- **증분** — 지난 pull 뒤에 바뀐 페이지만 search 로 받는다.

`sync.deleteSync` 가 켜져 있으면 pull · 상태 확인마다 전체 대조를 했다. 플러그인은 이 설정을 늘 켠다. 게다가 페이지를
증분으로 찾아도, 설정한 DB 와 발견한 DB 는 pull 마다 **모두** 다시 조회했다. 행이 하나도 바뀌지 않았어도 그랬다.

- 실볼트(발견 DB 166개)에서는 원격이 그대로인데도 재pull 이 523.5초 걸렸다(실측 2026-09-28).
- DB 가 하나도 없는 볼트는 pull 마다 하위 DB 블록 스캔을 다시 했다. 이 스캔은 추적 페이지마다 요청 1회다. 예전에는
  「발견한 DB 캐시가 비었는가」 로 스캔 여부를 가렸기 때문이다.
- 사용자는 Git · Obsidian Git 처럼 바뀐 것만 보이고 받기를 기대한다. 바뀐 것이 없는데 몇 분씩 걸리면 멈춘 것으로
  읽힌다.

## 결정

1. **원격을 훑는 방식은 pull 마다 고른다**(`chooseRemoteScan`). pull 과 상태 확인이 같은 규칙을 읽는다 — 둘이 갈리면
   상태 확인이 「원격 변경 없음」 이라고 한 것을 pull 이 받는다.

   | 전체 대조하는 때                                             | 이유(`FullScanReason`) |
   | ------------------------------------------------------------ | ---------------------- |
   | `--force` · 플러그인 명령 「Pull from Notion (전체 확인)」   | `forced`               |
   | DB 모드 — 루트가 DB 하나라 그 DB 조회가 곧 전체 대조다       | `database-mode`        |
   | 받은 것이 없다 — 처음 pull · 빈 상태 DB                      | `first`                |
   | 주기가 0 이다 · 읽을 수 없다(손으로 만든 설정)               | `every-pull`           |
   | 마지막 전체 대조 + 주기 ≤ 지금 · 한 번도 안 했다(업그레이드) | `due`                  |
   - 그 밖에는 **증분**이다 — 기준 시각(`last_pull_at`) 뒤에 바뀐 것만 찾는다.
   - 주기는 `sync.fullReconcileInterval`(초)이다. 기본 3600, 0 이면 pull 마다, 최대 604800(7일).
   - 상태 확인과 경로를 좁힌 pull 은 주기가 됐어도 전체 대조하지 않는다. 둘은 볼트 전체를 받지 않으므로 전체 대조를
     마쳤다고 적을 수 없다. 상태 확인마다 분 단위를 쓰게 되기도 한다.
   - 전체 대조를 마친 시각(`last_full_pull_at`)은 그 pull 이 **시작한** 시각이다. 시작한 뒤에 지운 것은 이번
     목록에 없을 수 있어서다. 경로를 좁히지 않았고 취소되지 않았을 때만 적는다.

2. **증분 pull 은 바뀐 것이 보인 DB 만 조회한다.** 조회할 DB:
   - search 로 찾은 바뀐 행(추적 중인 행)의 DB
   - search 로 찾은 추적하지 않는 행(새 행)의 부모 DB. 새 행은 페이지로 받지 않는다 — DB 조회가 속성과 함께
     받는다. 그래서 부모를 따로 묻지 않는다(행마다 요청 1회 이상 아낀다).
   - data source search 로 찾은, 스키마를 고쳤거나 새로 만든 DB. 스키마를 고치면 data source 의 수정 시각이 바뀐다.
     행을 고치거나 DB 제목만 바꾸면 그대로다(실측 2026-09-28).
   - 대기 DB(아래 3)
   - 이번 pull 이 새로 등록한 DB — 받은 적이 없다.
   - 볼트에서 행 파일이 사라진 DB — `deleteSync` 가 꺼져 있을 때만. 행을 되살리는 것은 DB 조회다. 켜져 있으면
     지운 것은 원격에서도 지우라는 뜻이라 되살리지 않는다.

   추적 중인 행은 페이지 경로에서 받지 않는다. 그 DB 의 조회가 받는다 — 두 경로가 같은 행을 두 번 받지 않게.
   상태 확인은 DB 를 조회하지 않으므로 고친 행을 원격 변경으로 그대로 싣는다.

3. **받지 못한 DB 는 대기로 남긴다**(`DatabasePullLedger`, 메타 `db_pull_pending`). 조회하다 실패했거나 · 받지 못한
   행이 있거나 · 취소로 닿지 못했거나 · 발견 라운드 한도에 걸린 DB 다. 적어 두지 않으면 그 DB 는 원격이 다시 바뀌거나
   전체 대조가 돌 때까지 받지 못한 채로 남는다 — 그 행의 수정 시각은 다음 조회 창 밖이다.
   - 다음 대기 = (지난 대기 − 이번에 받은 것) ∪ 이번에 받지 못한 것.
   - 이제 동기화하지 않는 DB(설정에서 뺐거나 접근 불가로 뺀 것)는 대기에서 뺀다.
   - 값이 바뀔 때만 쓴다.

4. **DB 마다 실제로 기록한 `.base` 경로를 상태 DB 에 남긴다**(`DbBaseFiles`, 메타 `db_base_files`). 인라인 DB
   자리표시를 `.base` 임베드로 바꿀 때 쓴다(F22). 예전에는 이번 실행이 기록한 것만 메모리에 두었다 — pull 마다 모든
   DB 의 `.base` 를 다시 썼기 때문이다. 이제는 이번에 조회하지 않은 DB 의 것도 알아야 한다.

5. **하위 DB 블록 스캔은 처음 한 번만 한다**(메타 `discovery_scanned_at`). 그 뒤에 생긴 DB 는 받은 페이지의 본문
   (`<database>` 태그)으로 찾는다. `--force` 는 다시 훑는다. 취소해서 다 훑지 못했으면 표시하지 않는다 — 다음 pull 이
   훑는다.

6. **취소를 따른다.** 원격을 훑다가 취소하면 받은 것 없이 끝낸다 — 기준 시각도 전체 대조 시각도 옮기지 않는다. 다
   훑지 못한 목록으로 삭제를 가르지 않는다. DB 를 조회하다 취소하면 닿지 못한 DB 는 대기로 남는다.

7. **원격을 얼마나 훑었는지 화면에 알린다.** 증분이면 Notion 에서 지운 노트가 아직 볼트에 남아 있을 수 있다. 알리지
   않으면 사람은 「지웠는데 남았다」 를 결함으로 읽는다.
   - core 가 계산한다: `PullResult.remoteScan` · `StatusResult.remoteScan` · `StatusResult.lastFullScanAt`.
     `deletionsDeferred` 는 「증분이고 `deleteSync` 가 켜져 있다」 이다. 설정이 꺼져 있으면 전체 대조도 원격 삭제를
     볼트에 반영하지 않으므로 미룰 것이 없다.
   - CLI: `pull` · `sync` 는 「Full scan (이유)」 또는 「Changes-only scan · N unchanged databases skipped」 를 적는다.
     미룬 삭제가 있으면 반영될 때와 `nobsi pull --force` 를 적는다. `status` 는 「Full scan: 시각」 을 늘 적는다.
     `--json` 은 `remoteScan` 을 싣는다.
   - 플러그인: 사이드바에 「전체 확인」 행(마지막 전체 확인 시각, 마우스를 올리면 설명)을 둔다. 명령 「Pull from Notion
     (전체 확인)」 을 추가한다. 상태 알림에 마지막 전체 확인 시각과, 미룬 삭제가 있으면 그 사실을 적는다.

## 선택지 — 원격 삭제를 어떻게 알아보나

| 선택지                                | 판단                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 늘 전체 대조(예전, `deleteSync` 켜짐) | 정확하다. 실볼트 재pull 523.5초 — 바뀐 것이 없어도                                                          |
| 늘 증분                               | 원격 삭제 · 범위 밖 이동을 영영 보지 못한다(search 는 휴지통을 돌려주지 않는다)                             |
| 증분 + 추적 페이지를 하나씩 확인      | 추적 페이지마다 요청 1회 — 전체 대조와 같은 비용이다                                                        |
| Notion webhook                        | 받을 공개 URL 이 있어야 한다 — 로컬에서 도는 CLI · 플러그인에 맞지 않는다                                   |
| **증분 + 주기마다 전체 대조**         | 바뀐 것만 빠르게 받고, 삭제는 주기 안에 반영한다. 기다리지 않으려면 `--force` · 「전체 확인」 — **고른 것** |

## 트레이드오프

- **원격 삭제가 늦다.** Notion 에서 지운 노트는 다음 전체 대조(기본 1시간 뒤) 때 볼트에서 지운다. 범위 밖으로 옮긴
  페이지도 같다. 화면이 그 사실과 때를 알린다. 기다리지 않으려면 `nobsi pull --force` · 「Pull from Notion (전체
  확인)」 을 쓴다.
- **상태 확인은 주기가 돼도 전체 대조하지 않는다.** 그래서 상태 확인의 원격 변경에는 원격 삭제가 없을 수 있다 —
  화면이 알린다.
- **DB 사이로 옮긴 행**은 옛 DB 가 바뀐 것으로 보이지 않아 옛 파일이 다음 전체 대조까지 남는다.
- **원본을 발견하지 못한 연결 DB(linked view) 컨테이너**의 새 행은 전체 대조 때 받는다 — search 는 원본 DB 를 부모로
  돌려주는데, 그 원본이 등록되어 있지 않다.
- **가라앉지 않은 창.** 수정 시각(분 단위)에서 2분이 지나기 전에 본 행은, 2분이 지난 뒤 다시 볼 때까지 pull 마다
  그 DB 를 다시 조회한다(ADR-017 의 같은 분 편집 규칙). 무변경이면 파일을 다시 쓰지 않는다.
- **스키마를 고쳤거나 새로 만든 DB 는 조회 창(기준 시각 − 15분) 동안 pull 마다 다시 조회한다.** data source 의 수정
  시각만으로는 이미 받은 스키마인지 가를 수 없다. 창을 지나면 건너뛴다 — 실측에서 DB 를 만든 뒤 15분 동안은 재pull
  마다 DB 2개를 조회했고, 지난 뒤에는 0개였다.
- **DB 제목만 바꾸면 증분이 보지 못한다.** data source 의 수정 시각이 그대로다(실측). `.base` · `.notion.json` 이름은
  다음 전체 대조 때 바뀐다.
- **업그레이드 뒤 첫 pull 은 전체 대조다**(`last_full_pull_at` 이 없다). DB 가 하나도 없는 볼트는 블록 스캔도 한 번
  더 한다(`discovery_scanned_at` 이 없다).
- **플러그인에는 주기 설정 화면이 없다** — 기본 3600초다. 「전체 확인」 명령은 `--force` 와 같아 블록 스캔도 다시
  한다(추적 페이지마다 요청 1회).
- **search 의 누락은 전체 대조가 메운다.** search 가 바뀐 페이지 · data source 를 빠뜨리면 그 변경은 다음 전체
  대조 때 받는다.

## 영향

- 추가
  - `core/sync/remote-scan.ts`: `chooseRemoteScan` · `remoteScanInfo` · `DatabasePullLedger` · 메타 키
  - `core/sync/db-base-files.ts`: `DbBaseFiles`
- 수정
  - `core/sync/orchestrator.ts`: 훑는 방식 고르기 · 조회할 DB 고르기 · 대기 저장 · 블록 스캔 한 번 · 취소.
    설정한 DB 를 받지 못하면 경고 로그만이 아니라 `failed` 에도 싣는다.
  - `core/sync/database-syncer.ts`: `pullAll` 이 고른 DB 만 조회하고 취소를 따른다. `baseFileInfo` 는 `DbBaseFiles` 다.
  - `core/notion/client.ts`(먼저 들어감, 5923533): `searchRecentPages` 가 행의 부모 DB 를 싣는다.
    `searchRecentDataSources` 추가. 훑기가 취소를 따른다.
  - `cli/utils/format.ts` · `commands/pull.ts` · `sync.ts` · `status.ts` · `utils/json-output.ts`
  - `obsidian-plugin/main.ts` · `sync/sync-controller.ts` · `views/SyncDashboard.svelte`
- 공개 API(계약 변경)
  - `sync.deleteSync` 가 켜진 볼트의 pull 은 원격 삭제를 매번이 아니라 전체 대조 때 반영한다.
  - 추가: `RemoteScanInfo` · `FullScanReason` · `PullResult.remoteScan` · `StatusResult.remoteScan`.
  - `StatusResult.lastFullScanAt` 은 필수 필드다 — `StatusResult` 를 직접 만드는 쪽은 채워야 한다.
- 설정: `sync.fullReconcileInterval` 추가(기본 3600). 없는 설정 파일은 기본값을 읽는다.
- 상태 DB: 메타 키 `last_full_pull_at` · `db_pull_pending` · `db_base_files` · `discovery_scanned_at` 추가. 표
  스키마 변경 없음.

## 검증

- 단위 · 통합
  - `core/tests/sync/remote-scan.test.ts` · `fast-change-detection.test.ts` · `db-base-files.test.ts` ·
    `discovery-block-scan.test.ts`
  - `cli/tests/utils/format.test.ts` · `tests/commands/pull.test.ts` · `sync.test.ts` · `status.test.ts` ·
    `json-output.test.ts`
  - `obsidian-plugin/tests/main.test.ts` · `sync/sync-controller.test.ts` · `views/sync-dashboard.test.ts`
- 변이: 이 결정이 더한 분기에 변이 80건을 심어 79건이 시험에 걸렸다. 남은 1건(404 로 뺀 DB 를 대기에서 지우는
  줄)은 `keepOnly` 가 같은 일을 해 동등 변이다.
- 실 Notion(프로브 페이지, 2026-09-28)
  - DB 2개 · 노트 2개 볼트: 첫 pull(전체) 요청 34회 11.3초 → 조회 창을 지난 재pull(증분) 요청 3회 3.6초.
    `--force` 는 요청 20회 7.2초.
  - DB 없는 볼트: 첫 pull 요청 15회(블록 조회 8) → 재pull 요청 3회(블록 조회 0).
  - 행 수정 · 새 행 · 스키마 변경은 증분이 받았다. 휴지통 · DB 제목 변경은 증분이 보지 못하고 전체 대조가 받았다.
    취소한 pull 은 못 받은 DB 를 대기로 남기고 다음 pull 이 받았다.
  - 단계별 표 — `docs/06-devlog/journal/2026-09-28.md` 「바뀐 것만 받는 pull」 절
