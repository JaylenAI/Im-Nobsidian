# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
