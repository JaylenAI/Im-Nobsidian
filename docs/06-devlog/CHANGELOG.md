# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.5] - 2026-05-17

### Fixed

- **Notion `<callout>` 태그 변환** — Notion API가 `<callout>` 태그를 반환하지만 기존 변환기는 `::: callout` 형식만 처리. 양쪽 형식 모두 지원하도록 `convertCallouts()` 리팩토링
- **미디어 태그 들여쓰기** — Notion API가 리스트 내 미디어를 `\t<pdf src=...>` 형태로 반환. 미디어 태그 정규식에 `[\t ]*` 선행 공백 허용 추가
- **인라인 수식 이스케이프** — Notion API가 `$E = mc^2$`를 `\$E = mc\^2\$`로 이스케이프. `convertNotionMath()`에 이스케이프된 수식 복원 로직 추가
- **첨자 이스케이프** — `H~2~O` → `H\~2\~O`, `X^2^` → `X\^2\^` 이스케이프 복원. `unescapeNotionChars()` 추가
- **테이블 정렬 행 중복** — Notion API가 `|---|` 정렬 행을 데이터 행으로 저장하여 Pull 시 정렬 행 중복 생성. `isAlignmentRow()` 필터 추가
- **gray-matter Date 객체** — `gray-matter`가 ISO 날짜 문자열을 JavaScript `Date` 객체로 자동 변환하여 정규화 우회. `normalizeValue()`에 `Date` 인스턴스 처리 추가

### Verified (E2E — 2026-05-17)

- 7개 파일 13종 포맷 Push→Pull 라운드트립 — 11/13 완벽
- 실전형 3파일 (회의록/기술사양/학습노트) 라운드트립 — 완벽
- 콜아웃 8종, 수학 수식 9개, 첨자 5개, 대형 테이블 10행 — 전체 복원
- 486 단위 테스트 전체 통과

## [0.1.4] - 2026-05-16

### Added

- **DatabaseSyncer** — 다중 Notion 데이터베이스 양방향 동기화. `databases` 설정으로 DB별 로컬 폴더/속성 매핑/필터 지정 가능
- **Standalone 파일 동기화** — 비-md 파일 (이미지/PDF 등) 업로드/다운로드 지원
- **pushUpdatePage 폴백 체인 개선** — 부분 업데이트 실패 시 replacePageMarkdown → blocks API 3단계 폴백
- 테스트 434 → 486 (52개 추가)
  - 부분 업데이트 검증 4개 (compute-patches)
  - Enhanced MD 라운드트립 9개 (미디어/탭/색상/중첩토글/다중색상/테이블/수학식)
  - 픽스처 기반 라운드트립 6개 (media-embed, color-formatting, notion-only, complex-table, frontmatter-all-types, mixed-callout-toggle)
  - DatabaseSyncer 단위 테스트 17개
  - Orchestrator 모킹 보강 16개
- 라운드트립 픽스처 17 → 20개 (complex-table, frontmatter-all-types, mixed-callout-toggle)

### Fixed

- **이미지 Push File Upload API 버그** — `send()` 후 상태가 `uploaded`로 자동 전환되어 `complete()` 호출 시 에러 발생하던 문제 수정. send() 응답 상태 확인 후 `pending`일 때만 complete() 호출

### Changed

- `SyncOrchestrator` — DatabaseSyncer 위임으로 push/pull 시 DB 동기화 자동 실행
- `Config` 타입 — `databases` 배열 추가 (DatabaseSyncConfig)
- `NotionClient` — `queryAllDatabasePages()`, `getDataSourceId()` 추가

## [0.1.3] - 2026-05-15

### Added

- **Partial page update (`update_content`)** — 변경이 적을 때(≤20 패치) search-and-replace 방식 부분 업데이트. 동시 편집 시 다른 섹션 보존
- **Move page API** — 파일 이동 시 Notion 페이지를 delete+create 대신 위치 이동. 히스토리/코멘트 보존
- **Conflict remote content** — 충돌 시 `remoteContent: ""` 대신 실제 Notion 페이지 내용 조회
- **Media tag conversion** — `<audio>/<video>/<pdf>/<file>` Enhanced MD 태그 ↔ 이모지 링크 양방향 변환
- **Tab block preservation** — `<tab>` 블록 ↔ `> [!tab]` 콜아웃 양방향 변환
- **Color/underline preservation** — `<span color>/<span underline>` → 보존 마커로 라운드트립 유지 (기존: 색상 제거)
- **Unknown block preservation** — `<unknown>` 블록 → 보존 마커 생성 (기존: 삭제). bookmark/embed/link preview 등 Notion 전용 블록 보존
- **Read-only property skip** — Push 시 `created_time`, `formula`, `rollup`, `unique_id` 등 8종 읽기전용 속성 자동 스킵 (API 에러 방지)
- **Timezone normalization** — `T00:00:00.000+09:00` 등 타임존 오프셋 포함 자정 시각도 `YYYY-MM-DD`로 정규화
- **Empty array exclusion** — 빈 배열 속성(`tags: []`) 프론트매터에서 자동 제외
- 테스트 409 → 434 (25개 추가: 미디어/색상/밑줄/unknown/tab/속성 스킵/타임존)
- 라운드트립 픽스처 14 → 17개 (media-embed, color-formatting, notion-only-blocks)

### Changed

- `<unknown>` 블록 처리: 삭제 → 보존 마커 (`%%im-nobsidian:unknown:...%%`)
- `<span color>` 처리: 색상 제거 → 보존 마커 (`%%im-nobsidian:color:...%%`)
- Push 시 `moved` 상태 처리: `pushUpdate()` → `pushMove()` (Move API 우선, 실패 시 fallback)
- `normalizeDate()`: 3개 패턴 → 통합 정규식 `MIDNIGHT_RE`

## [0.1.2] - 2026-05-15

### Added

- **Relation Write** — 프론트매터 `[[wikilink]]` → Notion relation 속성 양방향 매핑
- **Relation Pull 역변환** — Notion relation pageId → `[[PageName]]` wikilink 자동 변환
- **People Write** — user ID 기반 Notion people 속성 쓰기
- **Files Write** — 외부 URL 기반 Notion files 속성 쓰기
- **Date range Write** — start + end 양방향 지원 (end 필드 추가)
- **PDF 블록 Pull** — 커스텀 트랜스포머로 `[📄 caption](url)` 변환
- **Embed 블록 Pull** — 커스텀 트랜스포머로 `[caption](url)` 변환
- **ISO 날짜 정규화** — `T00:00:00.000Z` 제거하여 깔끔한 `YYYY-MM-DD` 프론트매터
- **WikilinkResolver 연동** — orchestrator에서 propertyMapper에 stateDb 위키링크 해석기 연결
- 테스트 377→409 (date range, relation 테스트 추가)

## [0.1.1] - 2026-05-14

### Fixed

- **`resolveParentPath()` 재귀적 경로 해석** — Pull 시 깊은 중첩 폴더 구조가 1단계로 평탄화되던 문제 수정. 부모 페이지를 재귀적으로 추적하여 전체 경로 체인 복원
- **`pullCreate()` 폴더 레코드 제거** — 같은 parentPageId를 notionPageId로 사용하여 UNIQUE 제약 조건 충돌 (7건) 발생하던 문제 수정
- **`isRetryable()` 에러 코드 확장** — `notionhq_client_request_timeout`, `ECONNRESET`, `ETIMEDOUT` 에러를 자동 재시도 대상에 추가
- **`detectLocalChanges()` 폴더 레코드 삭제 감지 방지** — `folder-note`/`folder-only` fileType을 가진 레코드가 잘못 삭제로 감지되던 문제 수정
- **`ensureFolderPage()` 폴더-노트 중복 생성 방지** — StateDB에서 기존 폴더-노트 레코드를 먼저 확인하여 중복 페이지 생성 방지

### Verified

- 180파일 GC_AI Push: 180/180 성공, 0 실패
- 283파일 Pull: 283/283 성공, 0 UNIQUE 에러
- 폴더 구조: GC_AI/Admin, CVfit, ERP_NextGen/Releases, Meetings, Projects, Study 전부 정확

## [0.1.0] - 2026-05-14

### Added

- **Notion Markdown API** — 공식 Markdown API (GET/POST/PATCH)로 변환 품질 대폭 향상
- **Notion File Upload API** — 로컬 이미지를 Notion에 직접 업로드
- **위키링크 ↔ 페이지 멘션** — `[[link]]` → Notion 페이지 멘션 양방향 매핑
- **YAML 코드블록 프로퍼티** — 프론트매터 무손실 왕복 보존
- **enhanced-md-converter** — Notion Enhanced Markdown ↔ Obsidian 마크다운 변환기
  - 수학 수식 (inline/block LaTeX)
  - HTML 테이블 → 마크다운 테이블
  - 페이지 링크 → 위키링크
  - 색상 스팬 제거
  - 빈 블록 정리
  - 파이프 이스케이프 해제
- **콜아웃 타입 보존** — preserve marker로 원본 콜아웃 타입 완벽 복원
- **15+ Notion 블록 타입 양방향 변환** — 제목, 코드, 리스트, 수식, 콜아웃, 토글, 테이블, 컬럼, 구분선, 임베드
- **프론트매터 ↔ Notion 속성 매핑** — 15+ 프로퍼티 타입 (select, multi-select, date, number, checkbox, URL, people, status 등)
- **Database 부모 모드** — `parentMode: "database"` 설정으로 DB 행 동기화
- **토글/컬럼/구분선/비디오/임베드** 양방향 변환
- **색상/밑줄/멘션** 보존
- **보존 마커 시스템** — 라운드트립 보장 (`%%im-nobsidian:...%%`)
- **3-way 머지 충돌 해결** — ask / local-wins / remote-wins / manual 4가지 전략
- **.im-nobsidian-ignore** 경로 필터링 (.gitignore 형식)
- **CLI 8개 명령어** — init, push, pull, sync, status, diff, resolve, watch
- **동기화 방향 제한** — `sync.direction: "push" / "pull" / "both"`
- **Force push** — `--force` 옵션으로 충돌 파일 강제 push
- **Dry run** — `--dry-run`으로 예정 작업 수 미리 확인
- **중복 파일명 처리** — Pull 시 `Name (1).md` ~ `Name (99).md` 자동 부여
- **중단 복구** — `cleanupInterruptedSync()`로 자동 정리
- **파일 감시 + 자동 동기화** — chokidar 기반 watch 모드
- **Rate limiting** — async-sema 3 req/s + exponential backoff + jitter
- **SQLite WAL 상태 DB** — 트랜잭션 기반 원자적 상태 관리
- **이미지 Pull 다운로드** — 중복 제거 + attachments 폴더 자동 관리
- **폴더 구조 → Notion 페이지 계층** 양방향 매핑
- **CLI 비대화형 모드** — `init --non-interactive --token xxx --root-page-id xxx`
- **CLI --verbose / --quiet** 글로벌 옵션
- **VaultFS.readBinary()** — 이미지 업로드용 바이너리 파일 읽기
- 377 단위 테스트 + 11 E2E 테스트 (실제 Notion API)
- 라운드트립 테스트 20개 (토글, 위키링크, 이미지, 프론트매터, 중첩구조)
- 테스트 픽스처 14개
- OSS 문서 완비 (README EN/KO, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, CHANGELOG)
- CI/CD (GitHub Actions, Node 20+22 매트릭스, dependabot, audit)

### Known Limitations

- **이미지 Push** — 단일 파트 업로드 시 send() 후 상태 확인 필요 (complete() 조건부 호출로 해결)
- **빈 줄 압축** — Notion Markdown API가 빈 줄을 정규화 (렌더링 차이 없음)
- **첫 Push 위키링크** — 새 페이지 간 교차 참조는 첫 동기화 시 미해결, 이후 자동 해결
- **Notion 전용 블록** — 버튼/폼/동기블록은 API가 unsupported 반환, 플레이스홀더 보존
- **Rate limit** — Notion 공식 제한 3 req/s

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
