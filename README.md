<p align="center">
  <img src="assets/banner.png" alt="Im-Nobsidian" width="600" />
</p>

<h1 align="center">Im-Nobsidian</h1>

<p align="center">
  <strong>The only true bidirectional sync between Obsidian and Notion.</strong>
</p>

<p align="center">
  <a href="https://github.com/JaylenAI/Im-Nobsidian/actions/workflows/ci.yml"><img src="https://github.com/JaylenAI/Im-Nobsidian/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/im-nobsidian"><img src="https://img.shields.io/npm/v/im-nobsidian" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-20%2B-green" alt="Node.js" /></a>
  <a href="https://www.npmjs.com/package/im-nobsidian"><img src="https://img.shields.io/npm/dm/im-nobsidian" alt="npm downloads" /></a>
</p>

<p align="center">
  <a href="README.ko.md">한국어</a> · <a href="docs/06-devlog/CHANGELOG.md">Changelog</a> · <a href="CONTRIBUTING.md">Contributing</a> · <a href="SECURITY.md">Security</a>
</p>

---

Edit in Obsidian, see it in Notion. Edit in Notion, see it in Obsidian. No copy-paste, no export-import, no manual sync. Just run `nobsi sync` and both sides stay perfectly in sync — formatting, properties, folder structure, and all.

Every other tool is one-way. Im-Nobsidian is the first and only open-source project that does true **bidirectional** sync with conflict resolution, property mapping, and round-trip preservation.

## Highlights

**True bidirectional sync** &nbsp; Edit on either side — changes propagate both ways. Not "export then import," but real two-way sync with change detection and delta updates.

**25+ block types preserved** &nbsp; Headings, code blocks, math (LaTeX), callouts, toggles, tables, checklists, columns, dividers, embeds, media (audio/video/pdf/file), tab blocks — all converted accurately in both directions. Colors, underlines, and Notion-only blocks are preserved via round-trip markers.

**Smart partial updates** &nbsp; When changes are small, Im-Nobsidian uses search-and-replace instead of overwriting the entire page — preserving other people's edits on the same page. Large changes still use full replace.

**Frontmatter ↔ Notion properties** &nbsp; Your YAML frontmatter maps directly to Notion database properties. Select, multi-select, date, number, checkbox, URL, people, status — 21 read types, 15 write types. Read-only properties (formula, rollup, etc.) are automatically skipped.

**Conflict resolution built in** &nbsp; When both sides change the same file, Im-Nobsidian detects it and shows the actual remote content for comparison. Choose: keep local, keep remote, or resolve manually. No silent data loss, ever.

**Multi-database sync** &nbsp; Sync multiple Notion databases to separate local folders. Each database gets its own property mapping and filter. Database pages become individual markdown files with frontmatter properties.

**File attachments downloaded** &nbsp; Excel, PDF, Jupyter notebooks, and other file attachments in Notion are automatically downloaded to your local vault. Internal `file://` protocol links are resolved via the Notion API and saved locally.

**Deep child page discovery** &nbsp; Child pages nested inside any block type (lists, paragraphs, headings, toggles) are discovered and synced. Not just top-level children — every page in your hierarchy is found.

**Folder structure = Page hierarchy** &nbsp; Your Obsidian folder tree maps 1:1 to Notion's page hierarchy. `projects/plan.md` → Notion page "plan" under "projects."

**Zero configuration sync state** &nbsp; No database to set up. No server to run. State tracking is fully automatic via a local SQLite file in `.im-nobsidian/` — you never touch it.

**Notion DB → Obsidian Bases** &nbsp; Notion databases are automatically converted to Obsidian Bases `.base` files. Gallery views get cover images via `file.embeds[0]` formulas. Table, cards, list views with sorting, grouping, and property ordering — all mapped from Notion's Views API.

**Obsidian Plugin** &nbsp; Install as an Obsidian plugin with sync sidebar dashboard (Push/Pull/Sync buttons, progress bar, bidirectional change detection, cancel button), 6 DB view types, and ribbon icons for one-click sync.

**Library + CLI + Plugin** &nbsp; Use it as a CLI tool, import it as a Node.js library for custom integrations, or install it as an Obsidian plugin.

## Quick Install

### Linux, macOS, WSL2, Termux

```bash
curl -fsSL https://raw.githubusercontent.com/JaylenAI/Im-Nobsidian/main/scripts/install.sh | bash
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/JaylenAI/Im-Nobsidian/main/scripts/install.ps1 | iex
```

### Manual Install

If you already have Node.js 20+:

```bash
npm install -g im-nobsidian
```

Or run without installing:

```bash
npx im-nobsidian sync
```

## Getting Started

### 1. Create a Notion Integration

1. Go to [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. Click **"New integration"** → name it anything → submit
3. Copy the **Internal Integration Secret** (starts with `ntn_`)

### 2. Connect Your Page

In Notion, open the page you want to sync → click `···` (top-right) → **Connections** → add your integration.

### 3. Initialize

```bash
cd ~/your-obsidian-vault
nobsi init
```

The interactive setup will ask for your token and show available pages. Pick one. Done.

### 4. Sync

```bash
nobsi sync     # Bidirectional — pull then push
nobsi push     # Obsidian → Notion only
nobsi pull     # Notion → Obsidian only
nobsi watch    # Auto-sync on file changes
```

That's it. Your vault and Notion workspace are now linked.

## In Action

<table>
<tr>
<td align="center"><strong>nobsi init</strong></td>
<td align="center"><strong>nobsi sync</strong></td>
</tr>
<tr>
<td><img src="assets/demo/init.gif" alt="nobsi init" width="400" /></td>
<td><img src="assets/demo/sync.gif" alt="nobsi sync" width="400" /></td>
</tr>
<tr>
<td align="center"><strong>nobsi push</strong></td>
<td align="center"><strong>nobsi pull</strong></td>
</tr>
<tr>
<td><img src="assets/demo/push.gif" alt="nobsi push" width="400" /></td>
<td><img src="assets/demo/pull.gif" alt="nobsi pull" width="400" /></td>
</tr>
<tr>
<td align="center"><strong>nobsi status</strong></td>
<td align="center"><strong>nobsi diff</strong></td>
</tr>
<tr>
<td><img src="assets/demo/status.gif" alt="nobsi status" width="400" /></td>
<td><img src="assets/demo/diff.gif" alt="nobsi diff" width="400" /></td>
</tr>
<tr>
<td align="center"><strong>nobsi resolve</strong></td>
<td align="center"><strong>nobsi watch</strong></td>
</tr>
<tr>
<td><img src="assets/demo/resolve.gif" alt="nobsi resolve" width="400" /></td>
<td><img src="assets/demo/watch.gif" alt="nobsi watch" width="400" /></td>
</tr>
</table>

## CLI Reference

| Command             | Description                                                   |
| ------------------- | ------------------------------------------------------------- |
| `nobsi init`        | Interactive setup — Notion token + root page                  |
| `nobsi push`        | Push local changes to Notion                                  |
| `nobsi pull`        | Pull Notion changes to local                                  |
| `nobsi sync`        | Bidirectional sync (pull → push)                              |
| `nobsi status`      | Show sync status + conflicts (add `--full` for bidirectional) |
| `nobsi diff [path]` | Show diff between local and Notion                            |
| `nobsi resolve`     | Resolve sync conflicts                                        |
| `nobsi watch`       | Watch for changes + auto-sync                                 |

All commands support `--dry-run` to preview changes without applying them.

### Non-interactive mode (CI / scripts)

```bash
nobsi init --token ntn_xxx --root-page-id abc123 --non-interactive
nobsi sync --dry-run
```

## How It Works

```
Obsidian Vault                        Notion Workspace
┌──────────────┐                    ┌──────────────────┐
│  project/    │   nobsi push       │  📄 project      │
│   plan.md    │  ───────────────►  │    📄 plan       │
│   notes.md   │                    │    📄 notes      │
│  meeting.md  │  ◄───────────────  │  📄 meeting      │
│              │   nobsi pull       │                   │
└──────────────┘                    └──────────────────┘
        │                                    │
        └──────── nobsi sync ────────────────┘
                  (bidirectional)
```

### Push (Obsidian → Notion)

1. Scans your vault for `.md` files
2. Compares SHA-256 hashes against last sync state
3. Converts changed files: frontmatter → properties, markdown → Notion blocks
4. Creates/updates pages via Notion API (rate-limited at 3 req/s)

### Pull (Notion → Obsidian)

1. Recursively reads pages under your root page
2. Detects changes by `last_edited_time`
3. Converts Notion blocks → markdown, properties → frontmatter
4. Downloads images to your attachments folder (deduplicated)

### Conflict Resolution

When both sides change the same file:

- `ask` — prompt to choose (CLI default)
- `local-wins` — keep Obsidian version
- `remote-wins` — keep Notion version
- `manual` — insert conflict markers for manual resolution

## Supported Conversions

| Feature                                         | Push |     Pull     |
| ----------------------------------------------- | :--: | :----------: |
| Headings, paragraphs, bold/italic/strikethrough |  ✅  |      ✅      |
| Code blocks (30+ languages)                     |  ✅  |      ✅      |
| Ordered / unordered / checkbox lists            |  ✅  |      ✅      |
| Links and wikilinks                             |  ✅  |      ✅      |
| Callouts / Notion callout blocks (collapsible)  |  ✅  |      ✅      |
| Math equations (LaTeX, inline + block)          |  ✅  |      ✅      |
| Tables                                          |  ✅  |      ✅      |
| Dividers                                        |  ✅  |      ✅      |
| Toggle blocks                                   |  ✅  |      ✅      |
| Column layouts                                  |  ✅  |      ✅      |
| Colors and underlines                           |  ✅  | ✅ Preserved |
| Media (audio / video / pdf / file)              |  ✅  |      ✅      |
| Tab blocks                                      |  ✅  | ✅ Preserved |
| Video / embed URLs                              |  ✅  |      ✅      |
| Frontmatter ↔ database properties (21 types)    |  ✅  |      ✅      |
| Images                                          |  ✅  | ✅ Download  |
| File attachments (xlsx, pdf, ipynb, etc.)       |  —   | ✅ Download  |
| Cover images + icons                            |  —   | ✅ Download  |
| Notion-only blocks (bookmark, embed, etc.)      |  ✅  | ✅ Preserved |
| Notion-only blocks (button, form, synced block) |  —   | 📌 Preserved |

## Configuration

After `nobsi init`, config lives in `.im-nobsidian/config.json`:

```jsonc
{
  "notion": {
    "token": "ntn_...", // your integration token
    "rootPageId": "...", // root page or database ID
    "parentMode": "page", // "page" or "database"
  },
  "sync": {
    "direction": "both", // "push" | "pull" | "both"
    "conflictStrategy": "manual", // "ask" | "local-wins" | "remote-wins" | "manual"
  },
  "paths": {
    "include": ["**/*"], // glob patterns to include
    "exclude": [], // glob patterns to exclude
    "attachments": "attachments", // image download folder
  },
}
```

You can also create `.im-nobsidian-ignore` (same syntax as `.gitignore`) to exclude files from sync.

## Database Mode

Sync to a Notion **database** instead of a page tree. Each markdown file becomes a database row, and frontmatter fields map to database properties:

```yaml
---
status: In Progress # → Select property
tags: [ai, project] # → Multi-select property
priority: 1 # → Number property
due: 2026-06-30 # → Date property
---
```

Enable it:

```bash
# Set parentMode to "database" and point to your database ID
nobsi init  # select a database as your root
```

## Packages

| Package                                             | Description                                          | npm                                                                                                         |
| --------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [`@im-nobsidian/core`](packages/core)               | Sync engine — conversion, state, conflict resolution | [![npm](https://img.shields.io/npm/v/@im-nobsidian/core)](https://www.npmjs.com/package/@im-nobsidian/core) |
| [`im-nobsidian`](packages/cli)                      | CLI tool (`nobsi` command)                           | [![npm](https://img.shields.io/npm/v/im-nobsidian)](https://www.npmjs.com/package/im-nobsidian)             |
| [`obsidian-im-nobsidian`](packages/obsidian-plugin) | Obsidian plugin (sync sidebar + DB views)            | v0.2.1 (BRAT install)                                                                                       |

### Using as a Library

```typescript
import {
  SyncOrchestrator,
  ConfigManager,
  StateDB,
  NotionClient,
  NodeVaultFS,
} from "@im-nobsidian/core";

const config = await new ConfigManager("/path/to/vault").load();
const stateDb = StateDB.open("/path/to/vault/.im-nobsidian/sync.db");
const client = new NotionClient({ token: config.notion.token });
const vaultFs = new NodeVaultFS("/path/to/vault", config.paths);

const orchestrator = new SyncOrchestrator(config, stateDb, client, vaultFs);

// Push all local changes to Notion
const result = await orchestrator.push({ dryRun: false });
console.log(`Created: ${result.created}, Updated: ${result.updated}`);

// Pull all Notion changes to local
await orchestrator.pull({ dryRun: false });

// Bidirectional sync
await orchestrator.sync({ dryRun: false });
```

## Known Limitations

| Limitation             | Reason                                                           | Workaround                                               |
| ---------------------- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| Notion-only blocks     | API returns `unsupported` for buttons, forms, synced blocks      | Preserved as callout placeholders                        |
| Rate limit             | Notion enforces 3 requests/second                                | Built-in rate limiter with exponential backoff           |
| Blank line compression | Notion Markdown API normalizes whitespace                        | No semantic difference — renders identically in Obsidian |
| First-push wikilinks   | Cross-references between new pages may not resolve on first sync | Resolved automatically on subsequent syncs               |

## Roadmap

```
v0.2.1 ✅ Current — --version dynamic read fix, docs refresh, 1038 tests
v0.2.0  100% lossless·idempotent·convergent, invariant safety net, npm publish
v0.1.12 Pull fidelity + sync stability, nested DB→Bases, gallery covers, 777 tests
v0.1.11 Plugin tests 115, better-sqlite3 removed, push bug fix, 696 tests
v1.0.0  → Community plugin submission, multi-workspace, 1000+ notes
```

See [ROADMAP.md](docs/06-devlog/ROADMAP.md) for the full plan.

## Development

```bash
git clone https://github.com/JaylenAI/Im-Nobsidian.git
cd Im-Nobsidian
pnpm install
pnpm build
pnpm test          # 1038 tests
pnpm lint
pnpm typecheck

# Register the nobsi command globally from local build
cd packages/cli && npm link && cd ../..
nobsi --version
```

### Project Structure

```
packages/
├── core/              # @im-nobsidian/core — sync engine
│   ├── src/
│   │   ├── converter/     # Markdown ↔ Notion conversion pipeline
│   │   ├── notion/        # Notion API client + property mapper
│   │   ├── state/         # SQLite state database
│   │   ├── sync/          # Orchestrator, change detection, vault FS
│   │   ├── view/          # DB view rendering + Bases .base file generator
│   │   └── utils/         # Hash, logger, sanitize
│   └── tests/
├── cli/               # im-nobsidian CLI (nobsi command)
└── obsidian-plugin/   # Obsidian plugin (sync sidebar + DB views)
    └── src/views/         # Svelte 5 components (Gallery/Board/Table/Calendar/List/Timeline + Sidebar)
```

## Contributing

Contributions welcome! See the [Contributing Guide](CONTRIBUTING.md) for setup, code style, and PR process.

```bash
git clone https://github.com/JaylenAI/Im-Nobsidian.git
cd Im-Nobsidian
pnpm install && pnpm build && pnpm test
```

## Security

To report vulnerabilities, see [Security Policy](SECURITY.md).

## License

[MIT](LICENSE) — built by [@JaylenAI](https://github.com/JaylenAI).
