# ObsiNotion

[![CI](https://github.com/JaylenAI/Obsidian_Notion_Syncer/actions/workflows/ci.yml/badge.svg)](https://github.com/JaylenAI/Obsidian_Notion_Syncer/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/obsinotion)](https://www.npmjs.com/package/obsinotion)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green)](https://nodejs.org)

> Bidirectional sync between Obsidian and Notion

[한국어](README.ko.md)

Sync your Obsidian vault with a Notion workspace — bidirectionally. Markdown and Notion blocks are converted accurately, and conflicts are handled safely without data loss.

## Features

- **Bidirectional sync** — Edit in Obsidian or Notion, changes reflect on both sides
- **Accurate conversion** — Markdown ↔ Notion block format with high fidelity
- **Safe conflict resolution** — Simultaneous edits create conflict copies instead of losing data
- **Database parent mode** — Sync to a Notion database with frontmatter ↔ property mapping
- **Folder structure mapping** — Obsidian folders = Notion page hierarchy
- **Delta sync** — Only changed files are synced (SHA-256 hash-based)
- **Open source** — MIT license, free, transparent

## Supported Features

| Feature                                   | Push (Obsidian → Notion) | Pull (Notion → Obsidian) |
| ----------------------------------------- | :----------------------: | :----------------------: |
| Headings, paragraphs, formatting          |            ✅            |            ✅            |
| Code blocks (language-specific)           |            ✅            |            ✅            |
| Lists / checkboxes                        |            ✅            |            ✅            |
| Links / wikilinks                         |            ✅            |            ✅            |
| Callouts (collapsible)                    |            ✅            |            ✅            |
| Math (LaTeX)                              |            ✅            |            ✅            |
| Tables                                    |            ✅            |            ✅            |
| Dividers                                  |            ✅            |            ✅            |
| Frontmatter ↔ properties (15+ types)      |            ✅            |            ✅            |
| Toggle blocks                             |            ✅            |            ✅            |
| Column layouts                            |            ✅            |            ✅            |
| Color / underline / mentions              |            ✅            |            ✅            |
| Video / embed URLs                        |            ✅            |            ✅            |
| Images                                    |       Placeholder        |       ✅ Download        |
| Notion-only blocks (button, form, synced) |            —             |       Placeholder        |

## Packages

| Package               | Description                        |
| --------------------- | ---------------------------------- |
| `@obsinotion/core`    | Sync engine (conversion + state)   |
| `obsinotion`          | CLI tool                           |
| `obsidian-obsinotion` | Obsidian community plugin (v0.5.0) |

## Quick Start

### CLI

```bash
# Install globally
npm install -g obsinotion

# Initialize (set Notion token + root page)
npx obsinotion init

# Check sync status
npx obsinotion status

# Bidirectional sync
npx obsinotion sync

# Obsidian → Notion
npx obsinotion push

# Notion → Obsidian
npx obsinotion pull

# Watch for file changes + auto sync
npx obsinotion watch

# View changes before syncing
npx obsinotion diff

# Resolve conflicts
npx obsinotion resolve
```

#### Non-interactive mode (CI/scripts)

```bash
npx obsinotion init --token ntn_xxx --root-page-id abc123 --non-interactive
```

### Obsidian Plugin

> Coming in v0.5.0. The Obsidian community plugin is under development.
> For now, use the CLI tool.

### Getting a Notion Integration Token

1. Go to [Notion Integrations](https://www.notion.so/my-integrations)
2. Click "New integration" → enter a name → submit
3. Copy the "Internal Integration Secret" (starts with `ntn_`)
4. In the Notion page you want to sync: ··· → Connections → Add your integration

## Configuration

ObsiNotion stores its config in `.obsinotion/config.json`. Key options:

```jsonc
{
  "notion": {
    "token": "ntn_...",
    "rootPageId": "...",
    "parentMode": "page", // "page" or "database"
    "databaseId": "...", // required when parentMode is "database"
  },
  "sync": {
    "direction": "both", // "push" | "pull" | "both"
    "conflictStrategy": "manual",
    "deleteSync": false,
  },
  "paths": {
    "include": ["**/*"],
    "exclude": [],
  },
}
```

## Known Limitations

- **Image push**: Notion API does not support file uploads — local images are preserved as placeholders on push and restored on pull.
- **Notion-only blocks**: Buttons, forms, and synced blocks are read-only (API limitation) — preserved as callout placeholders.
- **Rate limit**: 3 requests/second (Notion official limit).

## Development

### Requirements

- Node.js 20+
- pnpm 9+

### Local Development

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

### Project Structure

```
packages/
├── core/              # @obsinotion/core — core sync engine
├── cli/               # obsinotion — CLI tool
└── obsidian-plugin/   # Obsidian community plugin
```

## Documentation

- [Project Brief](docs/00-overview/PROJECT_BRIEF.md)
- [Current Status](docs/06-devlog/CURRENT_STATUS.md)
- [Changelog](docs/06-devlog/CHANGELOG.md)

## Contributing

Contributions are welcome! See [Contributing Guide](CONTRIBUTING.md).

## Security

To report vulnerabilities, see [Security Policy](SECURITY.md).

## License

[MIT](LICENSE)
