# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] - 2026-05-13

### Added

- **Notion Markdown API** — notion-to-md v3 대신 공식 Markdown API (GET/POST/PATCH) 사용
- **Notion File Upload API** — 로컬 이미지를 Notion에 직접 업로드
- **위키링크 ↔ 페이지 멘션** — `[[link]]` → Notion 페이지 멘션 양방향 매핑
- **YAML 코드블록 프로퍼티** — 프론트매터 무손실 왕복 (마크다운 테이블 → YAML)
- **콜아웃 타입 보존** — preserve marker로 원본 콜아웃 타입 완벽 복원
- **enhanced-md-converter** — Notion Enhanced Markdown ↔ Obsidian 마크다운 변환
- **동기화 방향 제한** — `sync.direction: "push-only"` / `"pull-only"` 지원
- **충돌 전략** — `conflictStrategy: "local-first"` / `"remote-first"` / `"manual"`
- **Force push** — `--force` 옵션으로 충돌 파일 강제 push
- **Dry run 실제 수량** — 예정 작업 수를 실제 값으로 반환
- **중복 파일명 처리** — Pull 시 `Name (1).md` ~ `Name (99).md` 자동 부여
- **중단 복구** — `cleanupInterruptedSync()`로 in_progress 플래그 자동 정리
- **블록 삭제 병렬화** — `async-sema` 세마포어로 pushUpdate 성능 개선
- **VaultFS.readBinary()** — 바이너리 파일 읽기 (이미지 업로드용)
- 라운드트립 테스트 20개 (토글, 위키링크, 이미지, 프론트매터, 중첩구조)
- 테스트 픽스처 14개 (toggle, nested-structure, special-chars, minimal 추가)

### Fixed

- **토글 내부 콘텐츠 누락** — Markdown API로 전환하여 근본 해결
- **위키링크 영구 파괴** — 볼드 텍스트 변환 → 페이지 멘션으로 교체
- **프론트매터 특수문자 깨짐** — 파이프/쉼표/따옴표 등 YAML 안전 직렬화
- **콜아웃 별칭 변경** — `[!summary]` → `[!abstract]`로 바뀌던 문제 해결
- **거짓 변경 감지** — timestamp 정확도 개선
- **deleteSync=false 시 삭제 방지** — pending 상태로 전환

### Changed

- `@notionhq/client` 2.3.0 → 5.21.0 업그레이드
- Notion-Version 헤더 2022-06-28 → 2026-03-11
- PropertiesTableInjector: 마크다운 테이블 → YAML 코드블록 (레거시 호환 유지)
- Test suite: 377 tests passing (up from 341)

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
- Test suite: 341 tests passing (up from 191)
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
