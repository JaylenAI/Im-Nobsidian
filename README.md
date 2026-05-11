# ObsiNotion

> Bidirectional sync between Obsidian and Notion

[한국어](README.ko.md)

Sync your Obsidian vault with a Notion workspace — bidirectionally. Markdown and Notion blocks are converted accurately, and conflicts are handled safely without data loss.

## Features

- **Bidirectional sync** — Edit in Obsidian or Notion, changes reflect on both sides
- **Accurate conversion** — Markdown ↔ Notion block format with high fidelity
- **Safe conflict resolution** — Simultaneous edits create conflict copies instead of losing data
- **Folder structure mapping** — Obsidian folders = Notion page hierarchy
- **Delta sync** — Only changed files are synced (SHA-256 hash-based)
- **Open source** — MIT license, free, transparent

## Packages

| Package               | Description                      |
| --------------------- | -------------------------------- |
| `@obsinotion/core`    | Sync engine (conversion + state) |
| `obsinotion`          | CLI tool                         |
| `obsidian-obsinotion` | Obsidian community plugin        |

## Quick Start

### CLI

```bash
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

# Resolve conflicts
npx obsinotion resolve
```

#### Non-interactive mode (CI/scripts)

```bash
npx obsinotion init --token ntn_xxx --root-page-id abc123 --non-interactive
```

### Obsidian Plugin

1. Obsidian Settings → Community Plugins → Search **ObsiNotion Sync**
2. Install and enter your Notion Integration Token and root page ID in settings
3. Command palette (Ctrl/Cmd+P) → `ObsiNotion: Sync`

### Getting a Notion Integration Token

1. Go to [Notion Integrations](https://www.notion.so/my-integrations)
2. Click "New integration" → enter a name → submit
3. Copy the "Internal Integration Secret" (starts with `ntn_`)
4. In the Notion page you want to sync: ··· → Connections → Add your integration

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
- [Roadmap](docs/06-devlog/ROADMAP.md)

## Contributing

Contributions are welcome! See [Contributing Guide](CONTRIBUTING.md).

## License

[MIT](LICENSE)
