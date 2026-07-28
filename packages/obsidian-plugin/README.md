# Im-Notion Sync — Obsidian plugin

> The Obsidian plugin for [Im-Nobsidian](https://github.com/JaylenAI/Im-Nobsidian) — true bidirectional sync with Notion.

Sync your vault with Notion without leaving Obsidian. Runs entirely on a sql.js (WASM) state database — no native modules.

## Features

- **Sync sidebar dashboard** — Push / Pull / Sync buttons, % progress bar, bidirectional change detection, cancel button.
- **6 database view types** — Gallery, Board, Table, Calendar, List, Timeline (Svelte 5).
- **Notion DB → Obsidian Bases** — `.base` files generated automatically, with gallery cover images.
- **Inline table editing**, conflict-resolution modal, and ribbon icons for one-click sync.
- **Lossless round-trip** — 25+ block types, colors, underlines and Notion-only blocks preserved.

## Install

### Community plugins

Submission to the Obsidian community plugin store is in progress.

### BRAT (beta)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat).
2. Add beta plugin: `JaylenAI/Im-Nobsidian`.
3. Enable **Im-Notion Sync** under Settings → Community plugins.

### Manual

Copy **four** files from a [release](https://github.com/JaylenAI/Im-Nobsidian/releases) —
`main.js`, `manifest.json`, `styles.css` and `sql-wasm.wasm` — into
`<vault>/.obsidian/plugins/im-notion-sync/`.

Two details are load-bearing:

- **The folder must be named `im-notion-sync`** (the plugin `id` in `manifest.json`). The plugin
  locates its SQLite WASM binary at `.obsidian/plugins/<manifest.id>/sql-wasm.wasm`, so any other
  folder name leaves the state database unable to open.
- **`sql-wasm.wasm` is required.** It is the SQLite engine the plugin runs on — without it the
  plugin loads but sync never initializes.

## Setup

1. Open Settings → **Im-Notion Sync**.
2. Enter your Notion integration token and root page ID.
3. Use the sidebar dashboard or the ribbon icon to Push / Pull / Sync.

Requires Obsidian v1.7.0+. Desktop only.

## Documentation

[Repo](https://github.com/JaylenAI/Im-Nobsidian#readme) · [Changelog](https://github.com/JaylenAI/Im-Nobsidian/blob/main/docs/06-devlog/CHANGELOG.md)

## License

MIT © hanseungheon
