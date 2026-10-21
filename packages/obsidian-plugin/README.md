# Im-Notion Sync — Obsidian plugin

> The Obsidian plugin for [Im-Nobsidian](https://github.com/JaylenAI/Im-Nobsidian) — true bidirectional sync with Notion.

Sync your vault with Notion without leaving Obsidian. Runs entirely on a sql.js (WASM) state database — no native modules.

## Features

- **Sync sidebar dashboard** — Push / Pull / Sync buttons, % progress bar, cancel button, and a Git-style change list: click a file to see its line diff against the last sync, then push, revert or pull just that file with its icon buttons (hover an icon for what it does; revert asks first). Conflicted notes are listed only under Conflicts.
- **6 database view types** — Gallery, Board, Table, Calendar, List, Timeline (Svelte 5).
- **Notion DB → Obsidian Bases** — `.base` files generated automatically, with gallery cover images.
- **Inline table editing**, conflict-resolution modal, and ribbon icons for one-click sync.
- **Round-trip that settles** — 25+ block types, colors, underlines and Notion-only blocks survive a push and pull; where Notion stores something differently the note changes once and then stays put (see [Known Limitations](https://github.com/JaylenAI/Im-Nobsidian#known-limitations)).

## Install

### Community plugins

Not listed in the community plugin store yet — install with BRAT or by hand below.

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
2. Enter your Notion integration token and the root page — paste the page's address, or its 32-character ID.
3. Use the sidebar dashboard or the ribbon icon to Push / Pull / Sync.

- **The token lives in Obsidian's keychain, not in the vault.** Obsidian keeps a keychain per vault and per
  device, so enter the token once in each vault (and on each computer) you sync. Settings from v0.3.2 and
  earlier are moved into the keychain on first load.
- **Date-time time zone.** Date-time properties are written and sent in this computer's time zone unless you
  pick one under _Date-time time zone_. Changing it does not rewrite times already in your notes.

Requires Obsidian v1.12.4+. Desktop only.

## Documentation

[Repo](https://github.com/JaylenAI/Im-Nobsidian#readme) · [Changelog](https://github.com/JaylenAI/Im-Nobsidian/blob/main/docs/06-devlog/CHANGELOG.md)

## License

MIT © hanseungheon
