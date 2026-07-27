# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

> R0~R11 — 지정 볼트 실데이터 E2E 를 매번 clean-slate 로 돌리며 발견한 충실도·견고성
> 결함 트랙. 아직 태그하지 않았다(dev 머지 완료).

### Fixed

- **CLI 가 모든 실패를 종료코드 0 으로 삼키던 문제 (R11-C)** — `index.ts` 가 parseAsync 후 `setTimeout(() => process.exit(0), 100)` 으로 강제 종료했다. better-sqlite3 핸들과 rate limiter 타이머가 이벤트 루프를 붙잡아 강제 종료 자체는 필요하지만, 인자를 0 으로 못박아 각 명령이 실패마다 세워 둔 `process.exitCode = 1`(init·pull·push·sync·resolve)을 **전부 덮어썼다** — 즉 **모든 CLI 실패가 성공으로 나갔다**. 셸도 CI 도 실패를 감지할 수 없었고, node 프로브 두 개로 실측 확인했다(하드코딩 0 → exit 0 / `process.exitCode ?? 0` → exit 1). 종료 코드 결정을 `utils/exit.ts` 의 `resolveExitCode`/`scheduleForcedExit` 로 꺼내 "강제 종료한다"와 "성공으로 종료한다"가 다시 한 줄에 섞이지 않게 했다. R11-B 의 완결성 게이트는 이 봉합 없이는 **작동하지 않는다** — `nobsi verify` 가 실패해도 0 으로 끝나 하니스가 통과로 읽기 때문
- **DB 모드 원격 변경 감지가 1차 data source 만 훑던 문제 (R11-A)** — Notion `2025-09-03` 부터 database 는 `data_sources[]` 를 소유하고 행은 소스별로 조회하는데, `detectRemoteChanges()` 의 DB 갈래만 `queryDatabase()` 인라인 페이지네이션(=1차 소스)으로 열거했다. 같은 계약을 `pullDatabase` 는 `queryAllDatabasePages()`(전 소스)로 지키고 있어, 한 경로만 계약을 어긴 **비대칭**이다(R9a·R9e·R9f·R10-A·R10-C·R10-D 와 같은 결함류). 결과는 미발견에 그치지 않는다 — `deleteSync: true` 면 2번째+ 소스의 행이 "원격에 없다"고 판정돼 **로컬 파일이 고아로 삭제**되고, 다음 pull 이 다시 만들어 **생성↔삭제 진동**이 된다(한 경로가 만든 걸 다른 경로가 지운다). 인라인 사본을 지우고 SSOT 하나만 부르게 봉합

- **볼트 밖 `/p/<id>` 상대 페이지 링크가 끊긴 채 남던 문제 (R10-D)** — R10-B 가 `[[notion:<id>]]` 표기에만 격하를 넣어, 같은 상황의 상대 url 표기(`[¹](/p/<id>?pvs=25#<blockId>)`)는 그대로 남았다(지정 볼트 89건/10파일 — 대상 11개가 상태 DB 대조상 전부 볼트 밖, 코드펜스 안 0건). `/p/<id>` 는 Notion 앱 안에서만 뜻이 있어 옵시디언은 볼트 루트 기준으로 읽고 `p/<id>` 라는 없는 파일을 가리키는 **끊긴 링크**로 그린다 — R10-B 가 없앤 것과 똑같은 증상이고, 없앤 건 비대칭의 **절반**이었다. 사례 대신 모듈 경계를 고쳐 `converter/notion-id-links.ts` 가 표기별 해소·격하를 **한 쌍씩** 갖게 하고(`resolveNotionRelativePageLinks`/`degradeUnresolvedNotionRelativePageLinks`), 오케스트레이터에는 링크 규칙을 한 줄도 남기지 않았다. `#<blockId>` 앵커는 살린다 — 89건 중 80건이 각주라 버리면 각주 80개가 전부 페이지 최상단으로 떨어진다. 반대로 **해소** 쪽은 앵커를 버린다(Notion 블록 id 는 옵시디언 `[[노트#제목]]` 의 앵커가 아니라 옮겨 붙이면 없는 제목을 가리킨다)
- **url 형 페이지 링크가 `[[X\|X]]` 자기별칭을 만들던 문제 (R10-C)** — Notion 이 내려주는 라벨 달린 상대 링크(`[ETC](/p/<id>)`)를 해소하는 갈래가 "라벨이 대상 제목과 같으면 접는다"는 규칙을 빠뜨려, breadcrumb 처럼 라벨이 곧 제목인 링크가 `[[ETC|ETC]]` 로 굳었다(지정 볼트 45건/12파일 — R10-A 를 넣고 다시 pull 해도 한 건도 줄지 않아 드러났다). `[[X|X]]` 는 `[[X]]` 와 뜻이 같지만 push 의 분기(별칭 유무로 mention/URL 링크를 가른다)를 헛돌게 해 mention 이어야 할 링크를 평범한 URL 링크로 내보낸다. 세어 보니 이 접기 규칙은 **네 곳에 복제**돼 있었고 그중 한 곳만 빠져 있었다 — 사례 대신 구조를 고쳐, 위키링크를 뱉는 출구를 `utils/wikilink-title.ts` 의 `formatWikilink(target, label?)` **하나로** 합치고 네 곳이 전부 이를 부르게 했다
- **볼트 밖 Notion 페이지 링크가 끊긴 위키링크로 남던 문제 (R10-B)** — 해소되지 않은 `[[notion:<id>]]` 를 그대로 남기면 옵시디언이 `notion:26d2…` 라는 **이름의 노트를 가리키는 끊긴 링크**로 그리고, 클릭하면 그 이름의 빈 노트를 만들자고 해 볼트를 오염시켰다(지정 볼트 25건/16파일). 같은 breadcrumb 한 줄의 url 기반 링크는 이미 동작하는 상태여서, 한쪽 경로만 죽은 링크를 만들던 비대칭이었다. 해소를 **전부 시도한 뒤에만** `[라벨](https://www.notion.so/<id>)` 로 격하한다 — 순서가 뒤집히면 볼트에 실재하는 대상까지 외부 링크로 굳는다. 격하형은 pull 1차 변환이 `[[notion:<id>|라벨]]` 로 환원하므로 id 가 살아 있고, 그 페이지가 나중에 볼트에 들어오면 정식 위키링크로 해소된다
- **별칭 달린 `[[notion:<id>\|별칭]]` 이 영영 미해소로 남던 문제 (R10-A)** — pull 마감 후처리(`resolveNotionLinks`)가 공용 해소 함수 대신 자기 정규식(`/\[\[notion:([a-f0-9-]+)\]\]/`)을 들고 있어 별칭 형태를 아예 매치하지 못했다. 이 후처리는 **정방향 참조**(A→B 인데 B 가 같은 pull 의 나중에 만들어지는 경우)를 메우는 자리라, 대상이 볼트에 실재하는데도 끊긴 채 남았다(지정 볼트 2건). 해소 지점을 `converter/notion-id-links.ts` **하나로** 합치고, 압축형(32 hex)·하이픈형(36자) 두 id 표기를 모두 받게 했다. 아울러 이 표기에서 별칭이 대상 제목과 같은 `[[X|X]]` 를 접는다 — push 가 별칭 유무로 mention/URL 링크를 가르기 때문에 그대로 두면 mention 이어야 할 링크가 평범한 URL 링크로 나간다
- **DB 행·첨부에 항목 시간 상한이 빠져 있던 문제 (R9e·R9f)** — R9b 가 도입한 `itemTimeoutMs` 는 오케스트레이터의 페이지 루프 4곳에만 걸려 있었다. 지정 볼트 887개 파일 중 629개가 DB 행이라 **보호받지 못하는 쪽이 다수**였고, 첨부 업로드 루프도 마찬가지였다. `DatabaseSyncer` 의 pull·push 행 루프와 `FileHandler` 의 업로드에 같은 상한을 적용. 아울러 `FileHandler` 의 업로드 루프가 `pushFilesForFolder`·`pushAllFiles` 두 곳에 중복돼 있던 것을 `pushSingleFile` 하나로 합쳤다 — R9a 에서 같은 구조(image/file 핸들러 중복) 때문에 한쪽만 상한이 빠졌던 사고의 재발 방지
- **`Retry-After` 를 한 번도 반영하지 못하던 헤더 접근 (R9d)** — `@notionhq/client` 는 `APIResponseError.headers` 에 fetch 응답의 `Headers` **인스턴스**를 그대로 싣는데(타입은 `unknown`) 인덱스(`headers["retry-after"]`)로 읽어 항상 `undefined` 였다. 429 를 맞아도 서버가 지정한 대기를 무시하고 지수 백오프로만 물러났고, R9c 의 전역 쿨다운은 실제로 한 번도 걸리지 않았다. `Headers`·`Map`·평범한 객체(대소문자 무관) 세 모양을 모두 읽도록 봉합. 아울러 쿨다운 발동 조건을 **`Retry-After` 유무 → status 429** 로 교정했다 — 게이트웨이가 헤더를 떼어먹으면 쿨다운이 통째로 사라지기 때문
- **재시도 백오프가 rate limit 슬롯을 점유하던 문제 (R9c — "pull 이 멈춘다"의 근본 원인)** — `withRateLimit` 이 `sema` 를 쥔 채 재시도 전체(최대 60초 × 5회)를 돌려, 불운한 요청 하나가 동시성 한 칸을 최대 5분 점유했다. 기본 동시성이 3이라 그런 요청 3건이면 클라이언트 전체가 멈춘다. 백오프 대기를 **슬롯 반납 뒤로** 옮기고, 429 는 `cooldownUntil` 전역 게이트로 함께 쉬게 해 재시도 폭풍을 막는다
- **재시도가 로그를 남기지 않아 정지와 구분되지 않던 문제 (R9c)** — 시도 횟수·대기시간·사유(status·code)를 경고로 남긴다. `Notion API 재시도 1/5 — 3750ms 대기 (status 429 · rate_limited · ...)`
- **첨부 다운로드에 시간 상한이 없던 문제 (R9a)** — `image-handler` 에는 있던 가드가 `file-handler` 에는 없어, 상한 없는 `fetch` 가 세마포어를 쥔 채 영원히 매달릴 수 있었다. 공용 `utils/download-fetch.ts` 로 통합해 양쪽이 위임
- **빈 칼럼 소실 (R8, D-EMPTY-COLUMN)** — Notion 다단 레이아웃의 내용 없는 칼럼이 pull·push 양쪽에서 제거돼 3열이 왕복 한 번에 2열로 좁혀지던 레이아웃 파괴 봉합
- R0~R7 — 삭제 파일 복원 스캔·임베드 미디어 제자리 교체·링크 왕복 손실 7종·왕복 수렴 회귀·블록 구조(`%` 마커 오인·컬럼 중첩)·CLI 배선 결함 11종·뷰 필터 번역

### Added

- **`nobsi verify [--json]` — DB 완결성 게이트 (R11-B)** — database 별로 **원격 행 id 집합**과 **볼트가 추적 중인 db-row id 집합**을 직접 대조하고, 미발견·잔재·조회 실패가 하나라도 있으면 종료 코드 1 로 끝난다. 기존 게이트(`analyze` 무결성 · `repull` churn 0 · `pushdry` churn 0 · 재-pull 바이트 동일 · 해시 일치)는 전부 **멱등성**이거나 **볼트 내부 성질**이라 체계적 미발견을 구조적으로 못 잡는다 — 디스커버리가 매번 **같은 행을 똑같이** 놓치면 재실행 결과가 첫 실행과 같아 churn 은 0 이고 해시도 전부 일치한다. 실제로 2026-07-17 pull 은 DB 행 **296개**를 침묵 유실한 채 그 전부를 통과했다. 설계 결정 셋: ① **카운트가 아니라 집합**을 비교한다(원격 925·볼트 925 라도 "미발견 1 + 잔재 1" 이면 수만 맞다 — 상쇄되는 게이트는 게이트가 아니다) ② 대조 대상은 볼트가 아니라 오케스트레이터가 조립한다(설정 `notion.databases[]` + 디스커버리 캐시 `discovered_dbs` + DB 모드 루트 DB — "볼트가 추적 중인 DB"만 보면 **통째로 미발견된 DB** 는 볼트에 흔적이 없어 영영 대상에도 못 오른다) ③ 조회 실패를 통과로 접지 않는다(`failures` 로 올리고 `complete = false`, 그 DB 만 총계에서 빼고 나머지는 계속 대조). 코어 API `orchestrator.verifyCompleteness()` · CLI `nobsi verify` · E2E 기본 베이스라인 `verify` 단계 세 표면으로 노출
- **`advanced.mediaDownloadTimeoutMs`** (기본 300초) — 미디어·첨부 다운로드 1회 시도의 시간 상한
- **`advanced.itemTimeoutMs`** (기본 30분) — 페이지 1건 처리의 시간 상한. 한 건이 동기화 전체를 멈춰 세우지 못하게 하고, 상한 초과 시 `시간 상한 초과(...초): pull <경로>` 로 **어느 페이지에서 멎었는지 보고**한다 (R9b)
- **라이브 불변식 I13**(마커·링크 구조 라운드트립)·**I14**(빈 칼럼 보존) — 라이브 불변식 스위트가 8 파일 13 케이스 → **10 파일 15 케이스**

### Quality

- R11 회귀 25건 — DB 모드 다중 data source 3(`tests/sync/db-mode-multi-datasource.test.ts`) · 완결성 단위 11(`tests/audit/completeness.test.ts`) · 배선 4(`tests/sync/completeness-wiring.test.ts`) · CLI verify 4 · 종료 코드 7(`packages/cli/tests/utils/exit.test.ts`). 변이 검증: R11-A 옛 인라인 페이지네이션 복원 → 3건 실패(2번째 소스 행의 **생성**과 `deleteSync: true` 에서의 **미삭제**를 각각 잠근다) · R11-C `proc.exit(0)` 복원 → 2건 실패. 완결성 쪽은 "수는 맞고 내용은 틀린" 상황(`remoteTotal === localTotal` 인데 `complete === false`)과 캐시 JSON 파손이 통과로 둔갑하지 않는지를 전용 케이스로 잠갔다
- E2E 하니스에 `verify` 단계를 **기본 베이스라인**에 추가(읽기 전용). `scripts/e2e/README.md` 에 "멱등성과 완결성은 다른 성질이다" 절로 두 게이트의 관할을 공시
- 신규 회귀 테스트 41건 (download-timeout 9 · deadline 7 · retry-observability 11 · retry-after 헤더 모양 5 · db-row 항목 상한 6 · 첨부 항목 상한 3). R9d 테스트는 **목이 아니라 실제 `Headers` 객체**로 잠갔다 — 평범한 객체로 흉내 내면 옛 버그가 그대로 통과하기 때문이며, 뮤테이션(옛 구현 복원)으로 6건 실패를 확인했다
- 상한 테스트는 전부 **끝나지 않는 프로미스**로 설계해 가드를 지우면 실패가 아니라 hang 으로 드러나게 했다. 변이 검증: R9e 4건 → vitest 타임아웃(20.0초), R9f 3건 → 테스트 타임아웃(15.0초). 통과 자체가 아니라 "제거하면 무너지는가"로 잠금을 증명한다
- 세 겹 시간 상한(API 30초 / 다운로드 300초 / 페이지 30분)을 `TROUBLESHOOTING.md` 에 표로 공시
- R10 회귀 43건(`tests/sync/notion-id-link-alias.test.ts` 37 · `tests/utils/wikilink-title.test.ts` 6)은 사례가 아니라 **성질**을 두 겹으로, 그것도 **표기별로** 잠근다 — ① 후처리 결과가 항상 `격하(해소(x))` 합성과 바이트 단위로 같아야 하고(두 표기 각각), ② 같은 대상·같은 라벨이면 url 표기 `[라벨](/p/<id>)` 과 id 표기 `[[notion:<id>\|라벨]]` 이 볼트 안(→ 같은 위키링크)에서도 볼트 밖(→ 같은 URL)에서도 **같은 바이트**를 내야 한다. 변이 검증 10종: 옛 별칭 무시 정규식 복원 4건 실패 · 옛 인라인 정규식 재삽입 7건 · 격하를 해소보다 **앞으로** 이동 11건 · `formatWikilink` 접기 제거 7건 · **url 갈래만** 옛 형태로 되돌림 4건 · **해소 갈래만** 옛 형태로 되돌림 2건 · 상대링크 격하 제거 6건 · 격하에서 앵커 버리기 1건 · 상대링크 격하를 해소 앞으로 이동 14건 · 모듈로 옮긴 해소에서 접기 제거 4건. 요점은 셋이다 — 어느 쪽 한 곳만 규칙을 잃어도 대칭 잠금이 잡고, 순서(해소 → 격하)는 두 표기 모두에서 잠겨 있으며, 앵커처럼 **양쪽이 같이 틀리는** 변이는 대칭 잠금이 못 잡으므로 값 자체를 보는 전용 케이스를 따로 뒀다
- "볼트 밖 페이지 링크"를 README 양쪽 **영구 제한** 표에 공시

## [0.3.1] - 2026-07-17

> steady churn 근절 + 왕복 충실도 마감 릴리스.
> v0.3.0부터 매 pull 마다 반복되던 "66 updated"(steady churn)의 진범을 근본 원인까지
> 규명·수정하고, clean-slate 실데이터 E2E(887 파일)로 churn-0·무손실을 재확정했다.

### Fixed

- **steady churn 근절 (진범: linked view 컨테이너 이중 등록)** — 신 Notion API(2025-09-03)에서 원본 DB가 공유 범위면 linked view 컨테이너도 `databases.retrieve`가 성공하고 `data_sources`가 채워져 응답만으로 원본과 구분 불가했다. 발견·pull 자가치유·orchestrator 3층에서 컨테이너의 행 소유를 원본에 양보하고 `.base`를 원본 폴더 필터로 재지향(캐시 제거·매핑 기록). **v0.3.0부터 지속되던 매 pull "66 updated"가 0으로 종결**
- **동명 형제 인라인 DB 폴더 충돌 분리** — 같은 부모 아래 같은 제목의 인라인 DB들이 제목 기반 폴더 유도로 한 폴더를 공유해 `.base`·사이드카를 서로 덮어쓰고 행이 섞이던 문제. 폴더 점유 대장으로 결정적 분리(첫 항목 원 폴더 유지, 이후 ` (dbid8)` 접미) — 22쌍 해소
- **HTML 주석 push 유출** — `%%…%%`에 이어 `<!--…-->`도 push 시 Notion 평문 문단으로 노출되던 정보 유출 봉합. `CommentStripper` HTML 패스 + 보존 마커(`style=html`)로 pull 시 원래 문법 복원
- **page mention 신형 URL 미해소** — 콜아웃 breadcrumb의 `<mention-page url="app.notion.com/p/<id>">`가 위키링크로 변환되지 않고 raw 태그로 잔존하던 문제. 변환 정규식을 `notion.so/<id>`·`app.notion.com/p/<id>` 양쪽 모두 흡수하도록 일반화(id 32-hex 앵커)

### Quality

- **1285 테스트 통과**(0 실패), lint·typecheck·build 클린
- **clean-slate 실데이터 E2E** — 볼트 전량 삭제(config만 보존) 후 fresh full pull **887 파일 / 0 실패**(페이지 258 + DB 행 629; linked view 컨테이너 70개를 원본 DB로 해소해 중복 행 파일 제거), audit-vault **결함 0 · 해시 불일치 0 · churn-0 PASS**, 재 pull "no changes"(byte-identical)로 멱등 재확정

## [0.3.0] - 2026-07-14

> 왕복 충실도 일괄 봉합 + 증분 pull 누락 수정 릴리스.
> 실코퍼스 심층 감사(F14~F27)에서 발견된 변환·동기화 결함을 전량 봉합하고,
> 875페이지 실데이터 E2E로 바이트 단위 왕복 무손실(delta-0)·멱등(churn-0)을 실증했다.
> Node.js 엔진 요구가 20 → **22.13+** 로 올라간다(의존성 최신화).

### Added

- **`nobsi pull --force`** — 증분 감지를 건너뛰고 전체 스캔. Notion search 인덱싱 지연으로 영구 누락되던 신규 하위 페이지(F20)·신규 child DB(F21)의 사용자 복구 수단 (F22)
- **옵시디언 주석 push 차단** — 일반 `%%주석%%`이 Notion에 노출되던 정보 유출 봉합. push 전 제거 + 보존 마커로 로컬 무손실 왕복 (F26, comment-stripper)
- **하이라이트 왕복** — `==마크==` push 시 노션 배경색 매핑 + pull 시 `==` 문법 복원 (F24, highlight-restorer)
- **각주 왕복** — `[^1]` 참조/정의가 push→pull 후에도 각주 문법으로 생존 (F25, footnote-guard + escape-normalizer)
- **표 열 정렬 왕복** — `:---:`/`---:` 정렬이 pull 후 복원 (table-alignment + restorer)
- **블록 간격 복원** — Notion 압축형 export를 원시 export 시점에 판정(`notionExportCompact` 메타데이터)해 문단/제목/리스트 간 빈 줄을 신뢰성 있게 재간격. `<empty-block/>` 유래 빈 줄로 인한 휴리스틱 오판 제거 + 같은 종류 블록 재병합 방지 (D1)
- **첨부 중복 제거(pull)** — 제자리 quote+마커와 페이지 끝 image block의 이중 표현을 sha256+basename 대조로 감지, 재다운로드·중복 라인 생성 차단 (D6)

### Fixed

- **캡션 이미지 다운로드 누락** — 캡션 달린 이미지가 만료 URL로 잔존하던 문제 봉합, 로컬 다운로드 정상화 (F14)
- **증분 pull 워터마크 갭** — search 인덱싱 지연 창에서 생성된 신규 하위 페이지가 영구 누락되던 문제 (F20)
- **신규 child DB 영구 미발견** — 발견 캐시 게이트로 최초 full pull 이후 생긴 child DB에 복구 경로가 없던 문제. `--force` 시 재스캔 (F21)
- **접근 불가 DB denylist** — 링크드/미공유/삭제 DB를 매 pull마다 404 재시도하며 스택트레이스를 쏟던 노이즈 차단 + 빈 폴더/.base 오염 방지
- **노트 임베드 삼킴** — `![[노트]]`가 첨부 파일로 오분류되어 사라지던 문제, 첨부 판정을 실제 첨부 확장자로 한정 (D5)
- **프론트매터 title 미주입·날짜 따옴표** — pull 생성 파일의 frontmatter 정합성 (D2/D3)
- **탭 들여쓰기 정규화** — Notion export의 탭 중첩 리스트가 4-space로 정규화되어 코드블록 오파싱 제거 (D4)
- **첨부 폴백 성공 시 ENOENT 스택트레이스 노이즈 억제** (F23)
- **보존 마커 앵커 복원** — 마커가 원문 위치(앵커 인접)로 정확히 재주입

### Changed

- **Node.js 엔진 20 → 22.13+** — CI 매트릭스 20/22 → 22/24 (⚠️ Node 20 사용자는 업그레이드 필요)
- **의존성 최신화** — @notionhq/client v5, better-sqlite3 v12, chokidar v5, lint-staged v17, typescript-eslint v8.64 등

### Quality

- **1151 테스트 통과**(11 skip, 0 실패), lint/typecheck/build 클린
- **실데이터 E2E 실증** — 고문(torture) 노트 push→pull 바이트 단위 delta-0, 875페이지 전체 스캔(`--force`) 정상, 무변경 pull 869개 md 해시 완전 동일(churn-0), 충돌 0

## [0.2.1] - 2026-06-03

> `nobsi --version` 정정 + 문서 최신화 패치 릴리스.
> CLI 버전 출력이 하드코딩(`0.1.1`)이라 모든 릴리스에서 틀리게 표시되던 버그를 `package.json` 동적 읽기로 근본 수정하고,
> 설치 명령(`im-nobsidian`)·테스트 수(1038)·로드맵 등 문서를 현행화했다.

### Fixed

- **`nobsi --version` 정확화** — 하드코딩된 `0.1.1` 대신 `createRequire`로 `package.json` 버전을 동적으로 읽도록 수정. 이제 모든 릴리스에서 자동으로 올바른 버전을 출력한다.
- **설치 명령 오타 교정** — README·가이드·시나리오 문서의 `npm install -g nobsi`(E404)를 올바른 패키지명 `im-nobsidian`으로 정정.

### Changed

- **문서 현행화** — 루트/한국어 README의 테스트 수(696→1038), 플러그인 버전(v0.1.11→v0.2.1), 로드맵을 v0.2.x 기준으로 갱신.

## [0.2.0] - 2026-06-02

> "100% 무손실·멱등·수렴" 미션에 집중한 릴리스.
> 라운드트립 deep-equal 충실도 검증(I1)과 불변식 안전망(드리프트·멱등성·삭제)을 CI에 상시 잠그고,
> 무손실 push를 blockquote·번호목록·underline/color·breadcrumb/TOC·DB 사이드카까지 확장했으며,
> 변환 정본화(I3)·증분 멱등(I5/I10)·중첩 cascade 폭주 차단(#72/#73)으로 데이터 손실 경로를 제거했다.

### Added

- **충실도 측정 인프라** — 본문 링크 분류기 + 멱등성 감사 러너 + 라운드트립 deep-equal 검증(I1)으로 회귀 상시 잠금 (#77)
- **불변식 안전망** — 드리프트/멱등성/삭제 불변식 인프라 + `deleteSync=false` 삭제 카운트 정직화
- **DB 사이드카 `.notion.json`** — Obsidian 미표현 뷰/메타를 각 DB 옆에 무손실 보존 (#45·#33, I4·I7)
- **오프라인 블록 라운드트립 잠금**(I2) + blockquote·번호목록 무손실 push
- **인라인 underline/color 무손실 push** (#47)
- **breadcrumb·TOC 블록** 단일라인 마커 push 복원
- **frontmatter wikilink 복원**(I3)
- **데드 테이블 활성화** — 첨부 dedup(I6) + 크래시 복구 WAL(I12)

### Fixed

#### 변환 정본화 (I3)

- **멘션 정규형 수렴** — 두 경로를 `[[notion:<32hex>]]` 정본으로 통일
- **PreserveMarkerInjector** — 마커를 원래 `startIndex` 위치에 복원
- **file-hosted 이미지** — video/embed 승격 URL 수용
- **인라인 span/color 마커** — 단일 정본으로 통일
- **rich-text 변환 분리** + 미처리 멘션 `plain_text` 보존
- 페이지 모드 pull **relation/people resolver 배선**(M1)
- 제목 **대괄호가 위키링크를 조기 종료**하던 문제 봉합(M5)
- 라벨 동반형 **mention-page breadcrumb 위키링크화**(M6)
- pull 링크 해소 충실도 (M2/M3/M4 + cover-URL + relation)

#### 멱등 · 수렴

- **증분 삭제 전파**(I10) + **`content_hash` 멱등**(I5)
- **다중 data source 무손실 병합** — 전 소스의 행·컬럼 동기화(I4)
- **충돌 해소 결과 Notion 재push** + `notionLastEdited` 재조정(I8)
- **검색 페이지네이션 디듀프** — 고아·folder-note 위치오류·push churn 근본 수정
- **폴더노트 fixpoint 위반** — `resolveNotionLinks` 해시 동기화 + 자식 페이지 삭제 가드
- **DB행 8자 prefix 충돌** 데이터 손실 + 영구 churn 제거(결함11)
- 본문이 **`---`로 시작할 때 frontmatter 유실** 수정

#### cascade 폭주 · 견고화

- **토글/콜아웃 코드펜스 cascade** — 비대칭 들여쓰기 dedent로 차단(#72)
- **중첩 컨테이너 prefix/탭 누적 폭주** — 내부우선 통합 변환 + 테이블 인식 dedent로 차단(#73)
- **대용량 워크스페이스 발견 성능** — deadline 재귀 + search 폴백, root 서브트리 한정(#71)
- 접근 불가 링크드/미공유 **DB graceful degrade**(결함9)
- **`extractValue` 비배열 속성값** 전수 하드닝(결함10)
- DB 자동발견 충실도 — `extractTitle` 크래시 가드 + 신모델 fetch(결함7·8)
- 갤러리 커버 **multivalue degrade** — 배열 커버를 첫 URL 스칼라로(rank22)
- 뷰 엔트리 **title·icon 스칼라 강제** — 숫자/배열 프론트매터 검색 크래시 차단(rank22b, I9)
- DB rename 시 **고아 `.base`/`.notion.json` 정리** + 스키마 진화 반영(rank14)

#### 빌드 · CI

- **루트 vitest 워크스페이스 정합** — plugin 2프로젝트(node/components)를 펼쳐 dev CI 복구
- E2E 하니스 종료코드 누수 수정(`scripts/e2e/run.sh`)
- `.base` 뷰 이름 유일성 보장 + E2E 하니스 정확도 개선

### Changed

- 테스트: **1038개 통과** (core 858 + CLI 31 + plugin 149) — v0.1.12 대비 **+261**
- lint / typecheck 클린, CI(node 20·22) GREEN

### Notes

- DB 사이드카 `.notion.json`이 각 동기화 DB 옆에 새로 생성된다(표현 불가 뷰/메타 보존용). 기존 볼트는 다음 pull 시 자동 생성.

## [0.1.12] - 2026-05-29

> Notion → Obsidian pull 충실도와 동기화 안정성에 집중한 릴리스.
> 중첩 DB를 Obsidian Bases로 완전 재현하고, 갤러리 커버 이미지가 실제로 렌더되도록 고쳤으며,
> push/pull 수렴·충돌 병합·watch 증분 동기화의 데이터 손실 경로를 다수 제거했다.

### Added

- **중첩 DB → 폴더 + `.base` 자동 생성** — 페이지 본문의 `<database>` 참조를 발견해 하위 폴더 + Obsidian Bases(`.base`) + 속성 프론트매터로 재귀 생성 (마크다운 태그 기반 발견 병합)
- **Pull 파이프라인 워커 풀** — 백프레셔 + 병렬 재시도로 대용량 볼트 pull 안정화
- **설정/상수 SSOT 중앙화** — 흩어진 설정을 단일 소스로 통합, 미배선 설정 정리 (Phase 1)

### Fixed

#### Pull 충실도

- **갤러리 커버 이미지 렌더** — Notion `views`(raw 속성 id)와 schema(URL-인코딩 id) 불일치로 `title` 외 모든 속성(커버/표시컬럼/정렬/그룹)이 누락되던 문제 해결. files 속성을 Obsidian Bases가 렌더할 수 있는 스칼라 URL 문자열로 직렬화. 빈 `title` 컬럼 제거. `.base` 파일 자신이 카드로 표시되던 문제(`file.ext == "md"` 필터)
- **인라인 페이지 링크 해결** — `/p/<id>?pvs=` 형식 페이지 멘션을 위키링크로 변환
- **embed/bookmark 라운드트립** — URL 기반 unknown 블록을 클릭 가능한 링크 + 보존 마커로 무손실 보존

#### 동기화 안정성

- **위키링크 push 데이터 손실** 수정 + push↔pull 수렴 보장
- **DB pull 시 로컬 수정 보존** — 무조건 덮어쓰기로 인한 데이터 손실 제거 (Phase 2-A)
- **DB push 부분 실패 복구** — 본문 push 실패 시 거짓 synced 상태 제거 (Phase 2-B)
- **DB 파일 rename 중복 방지** — rename 시 중복 Notion 페이지 생성 차단 (Phase 2-C)
- **3-way 병합 정확도** — LCS 기반 diff3 재작성으로 거짓 충돌 제거 (Phase 3)
- **속성 매퍼 라운드트립 충실도** — 잘못된 값 전송 방지 (Phase 2b)
- **watch 증분 동기화 정합성** 4건
- **Push 경로 원자성**·부분 실패 복구 강화
- **휴지통·보관 페이지 동기화 제외** + 깨진 서브트리 graceful skip
- **Bases 정렬 키** column→property 교정 + 속성 참조 YAML 인용 견고화
- **wikilink_map 최신성** 보장

### Performance

- **첫 pull 전체 스캔 ~21배 가속** — 블록 순회 → Notion search API 기반

### Changed

- 동기화 로직을 `SyncController`로 분리해 UI 비종속화

### Quality

- 테스트 777개 통과 (core 615 + CLI 31 + plugin 131)
- lint / typecheck 클린
- 실데이터 E2E — Im-Nobsidian-Test 볼트 138 노트 / 449 첨부 fresh pull, 갤러리 12 row 이미지 렌더 검증

### Notes

- DB 갤러리 커버용 files 속성은 이제 `[{name,url}]` 객체배열이 아닌 URL 문자열로 저장된다(라운드트립 호환). 기존 볼트는 재pull 시 자동 갱신.

## [0.1.11] - 2026-05-23

### Added

- **Obsidian 플러그인 테스트 115개** — SqlJsStateDB (30+11), VaultAdapter (18), Views (17), Settings (6), Main (7), Integration (9), ConflictModal (5)
- **better-sqlite3 완전 제거** — esbuild alias로 빈 shim 대체. 번들에서 네이티브 모듈 참조 0건
- **styles.css 테마 호환** — 사이드바, DB 뷰 컨테이너, 스테이터스바 스타일 추가
- **Vitest 테스트 인프라** — obsidian-stub.ts (모듈 스텁), mock-sqljs.ts (SQL 모킹), vitest.config.ts
- **CLI E2E 실제 데이터 검증** — Im-Nobsidian-Test 볼트에서 init→pull→push→sync→resolve 전체 플로우 204개 파일

### Fixed

- **`<unknown url="..."/>` 태그 push 실패** — bookmark 등 URL 기반 unknown 태그가 보존 마커로 변환되지 않아 martian 변환기에서 크래시. `NOTION_UNKNOWN_URL_RE` 정규식 추가 + `preserveUnknownBlocks()` 확장
- **`<unknown>` 태그 잔류** — `preProcessMarkdown()`에서 변환 전 `<unknown>` HTML 태그 완전 제거하여 블록 변환 실패 방지
- **WASM 복사 경로** — pnpm 호이스팅 구조에서 `sql-wasm.wasm` 복사 실패. 로컬 node_modules 우선 + pnpm 경로 fallback
- **diff 색상 하드코딩** — `rgba(255,0,0,0.1)` / `rgba(0,255,0,0.1)` → Obsidian CSS 변수 (`--background-modifier-error/success`) 전환

### Changed

- 테스트: 696개 통과 (Core 550 + CLI 31 + Plugin 115)
- 플러그인 빌드: 637KB → 620KB (better-sqlite3 제거 효과)
- sql-wasm.wasm: 644KB (별도 번들)

## [0.1.10] - 2026-05-22

### Added

- **Obsidian Bases 갤러리 커버 이미지 동기화** — Notion 갤러리 뷰의 `page_content` / `page_content_first` 커버를 Bases `formulas` (`file.embeds[0]`)로 매핑하여 카드 썸네일 자동 표시
- **`.base` 파일 `formulas:` 섹션 생성** — 콘텐츠 기반 커버가 필요한 갤러리 뷰에 계산 속성 자동 포함
- **단위 테스트 4건 추가** — 커버 타입 매핑 + formulas 생성 검증 (base-file-generator 총 23건)

### Fixed

- **페이지 커버 위키링크 형식** — 명시적 page cover를 프론트매터에 `[[attachments/...]]` 위키링크 형식으로 저장 (Obsidian Bases cards 뷰 호환 필수)
- **빈 DB 제목 fallback** — `getDatabaseTitle()`이 빈 문자열 반환 시 fallback 체인 미작동 (`??` → `||`)
- **`.base` 파일 업로드 오류** — `.base` 파일을 비-md 파일 목록에서 제외 (Notion File Upload API `validation_error` 방지)

### Changed

- 테스트: 581개 통과 (core 550 + CLI 31)
- `page_content` 커버: 프론트매터 기반 → formula 기반 (`file.embeds[0]`)
- `page_cover` 커버: 일반 경로 → 위키링크 형식

## [0.1.9] - 2026-05-22

### Fixed

- **바이너리 파일 다운로드 깨짐 (치명적)** — `obsidianFetch`가 이미지/PDF/동영상에 `JSON.stringify()` 호출하여 무한 재시도 + Pull 수분간 멈춤. Content-Type 헤더 확인 후 바이너리는 `resp.arrayBuffer` 사용
- **사이드바 상태 업데이트 미표시** — Svelte 5 `mount()` + CustomEvent 패턴이 Obsidian에서 동작 안 함. 직접 콜백 패턴 (`onReady` → `applyUpdate`)으로 전환
- **진행률 바 깜빡임** — `remount()`가 매 업데이트마다 Svelte 컴포넌트를 파괴/재생성. mount-once + 콜백 기반으로 변경
- **커뮤니티 플러그인 심사 요건 6건 수정** — manifest ID, `contentEl`, Setting API, `detachLeavesOfType` 제거, 토큰 패스워드, `minAppVersion`

### Added

- **sql.js WASM 어댑터** — `better-sqlite3` 네이티브 모듈 대체, Obsidian에서 플러그인 정상 로드
- **`IStateDB` 인터페이스** — SQLite 구현체 분리 (CLI: better-sqlite3, Plugin: sql.js)
- **동기화 사이드바 대시보드** — Push/Pull/Sync 버튼, % 진행률 바, 작업 종류 표시, 완료 요약 (5초 자동 사라짐), 취소 버튼
- **양방향 변경 감지** — ↻ 새로고침 시 로컬 + Notion 원격 변경 모두 확인. "원격 변경 (Notion)" 별도 섹션 표시
- **DB 뷰 6종** — Gallery, Board, Table, Calendar, List, Timeline (Svelte 5)
- **뷰 도구바** — 검색, 정렬, "+ 새 항목" 버튼
- **`filterEntries()` 엔진** — 8개 연산자 + 텍스트 전체 검색
- **TableView 인라인 편집** — 더블클릭으로 text/number/checkbox/url 셀 편집
- **`AbortController` 동기화 취소** — 사이드바 취소 버튼으로 진행 중인 동기화 중단
- **CLI `nobsi status --full`** — 기본은 빠른 로컬 체크, `--full`로 Notion API 양방향 확인
- **리본 아이콘** — 원클릭 동기화 + 사이드바 토글

### Changed

- `status()` incremental 최적화 — `lastSyncAt` 존재 시 `searchRecentPages()` 사용 (120초+ → 2-5초)
- 테스트: 523개 통과 (core 523 + CLI 31)
- 플러그인 빌드: 632KB main.js (sql.js WASM은 별도)

## [0.1.8] - 2026-05-21

### Fixed

- **Push가 Notion에 반영 안 되던 치명적 버그** — `updatePageMarkdownPartial` old_str 매칭 실패 시 silent no-op → `replacePageMarkdown` 전체 교체로 전환
- **Silent catch 제거** — pushCreatePage/pushUpdatePage에서 Markdown API 에러 삼키던 try/catch 제거
- **Notion SDK warn 숨김** — `logLevel: LogLevel.ERROR`로 502/503 재시도 경고 숨김
- **파일 스킵 메시지** — `warn` → `debug` 레벨로 변경 (CLI 출력 정리)

### Added

- **DB 자동발견** — 수동 DB ID 설정 없이 자식 데이터베이스 자동 탐지 + `sync_metadata` 캐싱
- **Stat cache 최적화** — mtime/size 기반 빠른 변경 감지 (해시 재계산 최소화)
- **100MB 파일 크기 제한** — 대용량 파일 다운로드 스킵 (OOM 방지)
- **중복 제목 처리** — DB 페이지 제목 충돌 시 page ID 접미사 자동 부여
- **`nobsi fetch` 명령** — 원격 상태 확인 (로컬 파일 쓰기 없이)

### Changed

- `pushUpdatePage`가 더 이상 partial update API 사용 안 함 — 항상 full replace
- `computePatches` 메서드 제거 (partial update 제거 후 불필요)
- DB view configs `db-views.json`에 캐싱 — 재pull 시 재조회 스킵
- 테스트: 554개 통과 (core 523 + CLI 31)

## [0.1.7] - 2026-05-20

### Added

- **CLI 데모 GIF 8종** — init, pull, push, sync, status, diff, resolve, watch 전 명령어 데모
- **In Action 섹션** — README에 4x2 그리드로 모든 CLI 데모 한눈에 배치

### Changed

- README 레이아웃 개선 — Getting Started 간결화 + In Action 그리드
- 불필요한 SVG 데모 파일 제거 (GIF로 대체)
- 버전 0.1.7 업데이트 (core, cli, obsidian-plugin)

## [0.1.6] - 2026-05-20

### Added

- **Beautiful CLI 출력** — chalk 기반 컬러풀한 터미널 UI (push/pull/sync/status/init 전 명령어)
- **실시간 진행률 표시** — 파일별 create/update/delete 아이콘 + [n/N] 카운터
- **dry-run 파일별 출력** — `--dry-run` 모드에서도 개별 파일 진행률 표시
- **CLI 데모 GIF 8종** — asciinema .cast → agg 변환 (init, pull, push, sync, status, diff, resolve, watch)
- **format 유틸리티** — `header()`, `separator()`, `icons`, `dimText()` 공유 모듈

### Fixed

- **dry-run onProgress 미호출** — orchestrator의 push/pull dry-run 경로에서 onProgress 콜백 누락 수정
- **status 날짜 로케일 의존** — `toLocaleString()` → ISO 수동 포맷으로 교체 (한국어 로케일 불일치 방지)
- **CLI 프로세스 미종료** — `parseAsync()` 후 `setTimeout(() => process.exit(0), 100)` 추가

### Changed

- 테스트: 555개 통과 (core 524 + CLI 31)
- README/README.ko.md: 워크플로우 흐름에 GIF 8종 배치, 로드맵 v0.1.6 업데이트

## [0.1.5] - 2026-05-19

### Added

- **DB 뷰 렌더링 엔진** — Notion Views API 연동으로 Gallery/Board/Table/Calendar 4종 Svelte 뷰 컴포넌트
- **Board 드래그앤드롭** — Board 뷰에서 카드 드래그로 상태 변경
- **캘린더 이벤트 생성** — Calendar 뷰에서 날짜 클릭으로 새 항목 생성
- **EntryEditor** — 뷰에서 직접 프론트매터 속성 편집
- **ViewDataProvider** — 마크다운 파일 → 뷰 데이터 변환 엔진
- **FilterEngine** — 속성 기반 필터링/정렬 엔진
- **ColorMap** — Notion 10색 → CSS 변수 매핑
- **커버/아이콘 추출** — DB 페이지의 cover image, emoji/external icon Pull 지원
- **파일 첨부 다운로드** — DB 엔트리의 `file://` 프로토콜 링크(xlsx, pdf, ipynb 등) 자동 다운로드
- **자식 페이지 탐색 확장** — `has_children: true`인 모든 블록 재귀 탐색 (기존 5종 컨테이너만 → 전체)
- **링크 해결 범위 확대** — 동기화된 전체 파일 대상으로 `[[notion:ID]]` 링크 해결
- **Enhanced MD 변환기 확대** — 미디어/탭/색상/밑줄/unknown 블록 보존
- **Notion API 최신화** — `update_content` 부분 업데이트, 페이지 이동 API, File Upload API
- **속성 매핑 확대** — 21 읽기 + 15 쓰기 타입, 프론트매터 정규화
- **DatabaseSyncer** — DB 페이지 양방향 동기화 (Pull/Push)
- **Standalone 파일 동기화** — 비-md 파일 업로드/다운로드 지원
- **Obsidian 통합 레이어** — 뷰 등록, 코드블록 프로세서, Vault Adapter

### Fixed

- **이미지 Push** — File Upload API 상태 전환 버그 수정 (send → 조건부 complete)
- **Pull 변환 버그 5건** — 테이블 라운드트립, 공백 패딩 등
- **DB 엔트리 파일 미다운로드** — `downloadAllFiles()` 호출 누락 수정
- **자식 페이지 미탐색** — bulleted_list 등 비-컨테이너 블록 내 child_page 발견 불가 수정
- **링크 해결 누락** — writtenPaths만 처리 → 전체 synced 파일 대상으로 변경

### Changed

- 테스트: 554개 통과 (core 524 + CLI 30)
- 블록 타입: 25+ 양방향 지원
- 속성 타입: 21 읽기, 15 쓰기

## [0.1.1] - 2026-05-13

### Fixed

- **Documentation audit** — install scripts, SECURITY.md, CONTRIBUTING.md, GLOSSARY.md corrected
- **Install scripts** — download URLs fixed from `Obsidian_Notion_Syncer` to `Im-Nobsidian`
- **SECURITY.md** — token storage location corrected to `.im-nobsidian/config.json`
- **CURRENT_STATUS.md** — fully rewritten to reflect v0.1.0 released state
- **ROADMAP.md** — updated to reflect v0.1.0 release, test count 355

### Changed

- Version bump to 0.1.1 across all packages (core, cli, obsidian-plugin)

## [0.1.0] - 2026-05-11

### Added

- **NotionBlockBuilder** — static utility for generating all Notion API block types (13 basic + 7 media + 7 advanced)
- **Toggle/Column bidirectional sync** — preserve markers for round-trip fidelity
- **Rich text enhancement** — color annotations, underline (`<u>`), mentions (page, date, user)
- **HtmlAnnotationStripper** — cleans HTML/color markers before martian conversion
- **PropertyMapper** — bidirectional frontmatter ↔ Notion database property conversion (15+ types)
- **Database parent mode** — `parentMode: "database"` config option with `databaseId`
- **NotionClient extensions** — `getDatabaseSchema()`, `queryDatabase()` methods
- **Orchestrator database integration** — full push/pull flow for database parent mode
- **Video/embed URL detection** — YouTube, Vimeo, Figma, Google Docs URLs → proper Notion blocks
- **Divider support** — placeholder-based `---` round-trip (martian drops dividers)
- **PropertiesTableInjector** — frontmatter → markdown table for page-mode push
- CLI `init --non-interactive` mode for CI/script usage
- CLI `--verbose` / `--quiet` global options
- Progress callback in sync engine (`onProgress` in push/pull/sync options)
- Per-file progress display in CLI push/pull/sync commands
- English README.md (Korean version moved to README.ko.md)
- README: badges, Supported Features table, Configuration section, Known Limitations
- CODE_OF_CONDUCT.md (Contributor Covenant v2.1)
- CONTRIBUTING.md bilingual (EN/KO)

### Fixed

- **PreserveMarkerInjector** — was a passthrough stub, now restores markers on pull
- **status command conflicts** — `conflictRecords` now properly populated from StateDB
- **Image push** — local images preserved as placeholders instead of broken links
- **Path filtering** — `config.paths.include/exclude` now applied + `.im-nobsidian-ignore` support
- **Conflict files now excluded from push** — previously pushed during sync, overwriting remote
- **pushUpdate safety** — new blocks appended first, then old blocks deleted
- **StateDB transactions** — push/pull DB operations wrapped in transactions for atomicity
- **Rate limit jitter** — randomized jitter to exponential backoff
- **Windows path compatibility** — replaced hardcoded `/` with `path.dirname()` / `path.join()`
- **CLI shebang duplication** — removed duplicate `#!/usr/bin/env node`

### Changed

- Conversion pipeline: 15+ pre/post processors (up from 13)
- Test suite: 355 tests passing (up from 191)
- CURRENT_STATUS.md fully rewritten to reflect actual implementation state

## [0.0.1] - 2026-05-08

### Added

- Project initial structure (pnpm monorepo: core, cli, obsidian-plugin)
- Core conversion engine (ConversionPipeline, 13 pre/post processors)
- Sync engine (SyncOrchestrator, ChangeDetector, StateDB, NotionClient)
- Block converter integration (@tryfabric/martian + notion-to-md)
- Image handler with deduplication
- Tree mapper for folder structure mapping
- File watcher (chokidar) + auto sync service
- Three-way merge conflict resolution
- CLI: 8 commands (init, push, pull, sync, status, diff, resolve, watch)
- Obsidian plugin: settings, vault adapter, conflict modal, status bar
- 191 unit tests + 11 E2E tests (real Notion API)
- GitHub Actions CI/CD pipeline
- Husky pre-commit + commit-msg hooks
- Changeset-based version management
- ESLint + Prettier configuration
- Documentation structure (7 categories)
- Architecture Decision Records (3 ADRs)
