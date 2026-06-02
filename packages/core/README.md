# @im-nobsidian/core

> Core sync engine for [Im-Nobsidian](https://github.com/JaylenAI/Im-Nobsidian) — the only true bidirectional sync between Obsidian and Notion.

<p>
  <a href="https://www.npmjs.com/package/@im-nobsidian/core"><img src="https://img.shields.io/npm/v/@im-nobsidian/core" alt="npm version" /></a>
  <a href="https://github.com/JaylenAI/Im-Nobsidian/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-20%2B-green" alt="Node.js" /></a>
</p>

The programmable engine behind the `nobsi` CLI and the Im-Nobsidian Obsidian plugin — importable directly for custom integrations. Markdown ↔ Notion conversion (25+ block types, round-trip markers for lossless preservation), frontmatter ↔ property mapping (21 read / 15 write types), 3-way conflict resolution, and incremental sync orchestration.

## Install

```bash
npm install @im-nobsidian/core
```

ESM only, Node.js 20+.

## Modules

- **`converter/`** — Markdown ↔ Notion conversion. `createDefaultPipeline()`; preserve markers keep Notion-only blocks, colors and underlines lossless on round-trip.
- **`notion/`** — `NotionClient` (official SDK, 3 req/s rate limit), `NotionBlockBuilder`, `PropertyMapper`.
- **`sync/`** — `SyncOrchestrator` (pull / push / sync), `DatabaseSyncer`.
- **`state/`** — `StateDB` sync-state database (`IStateDB` interface — better-sqlite3 in the CLI, sql.js in the plugin).
- **`conflict/`** — `threeWayMerge`, `ConflictResolver`.
- **`structure/`** — `TreeMapper` (folder tree ↔ page hierarchy).
- **`watcher/`** — `FileWatcher`, `WatchSyncService`.
- **`audit/`** — `classifyBodyFidelity`, `summarizeFidelity` (round-trip fidelity measurement).

## Usage

```ts
import { SyncOrchestrator, ConfigManager } from "@im-nobsidian/core";
```

The engine is configuration-driven (Notion token, root page, vault path). For an end-to-end reference, see the [`nobsi` CLI](https://www.npmjs.com/package/im-nobsidian) — a thin wrapper over this package.

## Documentation

[Repo](https://github.com/JaylenAI/Im-Nobsidian#readme) · [Architecture](https://github.com/JaylenAI/Im-Nobsidian/tree/main/docs/02-architecture) · [Changelog](https://github.com/JaylenAI/Im-Nobsidian/blob/main/docs/06-devlog/CHANGELOG.md)

## License

MIT © hanseungheon
