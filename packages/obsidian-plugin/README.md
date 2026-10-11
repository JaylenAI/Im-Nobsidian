# Im-Notion Sync — Obsidian plugin

> The Obsidian plugin for [Im-Nobsidian](https://github.com/JaylenAI/Im-Nobsidian) — true bidirectional sync with Notion.

Sync your vault with Notion without leaving Obsidian. Runs entirely on a sql.js (WASM) state database — no native modules.

## Features

- **Sync sidebar dashboard** — Push / Pull / Sync buttons, % progress bar, cancel button, and a Git-style change list: click a file to see its line diff against the last sync, then push, revert or pull just that file with its icon buttons (hover an icon for what it does; revert asks first). Conflicted notes are listed only under Conflicts.
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

Copy **three** files from a [release](https://github.com/JaylenAI/Im-Nobsidian/releases) —
`main.js`, `manifest.json` and `styles.css` — into `<vault>/<config folder>/plugins/im-notion-sync/`
(the config folder is `.obsidian` unless you changed it under Settings → Files and links).

The SQLite engine the plugin keeps its sync state in is built into `main.js`, so there is no
fourth file to copy. Releases up to v0.3.2 shipped it separately as `sql-wasm.wasm`; it is safe to
delete that file from the plugin folder after updating.

## Setup

1. Open Settings → **Im-Notion Sync**.
2. Enter your Notion integration token and root page ID.
3. Use the sidebar dashboard or the ribbon icon to Push / Pull / Sync.

Requires Obsidian v1.7.0+. Desktop only.

## Documentation

[Repo](https://github.com/JaylenAI/Im-Nobsidian#readme) · [Changelog](https://github.com/JaylenAI/Im-Nobsidian/blob/main/docs/06-devlog/CHANGELOG.md)

## License

MIT © hanseungheon
