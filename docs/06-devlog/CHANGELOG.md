# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- CLI `init --non-interactive` mode for CI/script usage
- CLI `--verbose` / `--quiet` global options
- Progress callback in sync engine (`onProgress` in push/pull/sync options)
- Per-file progress display in CLI push/pull/sync commands
- English README.md (Korean version moved to README.ko.md)

### Fixed

- **Conflict files now excluded from push** — previously, files in conflict state were pushed during sync, overwriting remote changes
- **pushUpdate safety** — new blocks are appended first, then old blocks deleted (previously deleted first, risking data loss on failure)
- **StateDB transactions** — pushCreate/pushUpdate/pullCreate DB operations wrapped in transactions for atomicity
- **Rate limit jitter** — added randomized jitter to exponential backoff to prevent thundering herd
- **Windows path compatibility** — replaced hardcoded `/` separators with `path.dirname()` / `path.join()` in NodeVaultFS
- **CLI shebang duplication** — removed duplicate `#!/usr/bin/env node` from source (tsup banner already adds it)
- Orchestrator test mock: `getByStatus` now distinguishes status argument, `transaction` mock added

### Changed

- CURRENT_STATUS.md fully rewritten to reflect actual implementation state (was severely outdated)

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
