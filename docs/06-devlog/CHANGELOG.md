# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
