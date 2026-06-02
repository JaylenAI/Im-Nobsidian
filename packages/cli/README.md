# im-nobsidian

> `nobsi` — the CLI for [Im-Nobsidian](https://github.com/JaylenAI/Im-Nobsidian), the only true bidirectional sync between Obsidian and Notion.

<p>
  <a href="https://www.npmjs.com/package/im-nobsidian"><img src="https://img.shields.io/npm/v/im-nobsidian" alt="npm version" /></a>
  <a href="https://github.com/JaylenAI/Im-Nobsidian/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-20%2B-green" alt="Node.js" /></a>
</p>

Edit in Obsidian, see it in Notion — and back. Run `nobsi sync` and both sides stay in sync: formatting, properties, folder structure, attachments. Conflict resolution and round-trip preservation built in.

## Install

```bash
npm install -g nobsi
# or run without installing
npx nobsi --help
```

The binary is available as both `nobsi` and `im-nobsidian`.

## Quick start

```bash
nobsi init      # configure Notion token + root page + vault path
nobsi pull      # Notion → Obsidian
nobsi push      # Obsidian → Notion
nobsi sync      # bidirectional (pull → push)
```

## Commands

| Command         | Description                                         |
| --------------- | --------------------------------------------------- |
| `nobsi init`    | First-time setup — Notion token, root page, vault   |
| `nobsi pull`    | Pull Notion changes into the local vault            |
| `nobsi push`    | Push local changes to Notion                        |
| `nobsi sync`    | Bidirectional sync (pull → push)                    |
| `nobsi status`  | Show sync state (`--full` includes remote changes)  |
| `nobsi resolve` | Resolve conflicts                                   |
| `nobsi watch`   | Watch files + auto-sync on change                   |
| `nobsi diff`    | Show differences between local and Notion           |
| `nobsi fetch`   | Scan Notion remote state (incl. deletion detection) |

Config and sync state live in `.im-nobsidian/` inside your vault. Your Notion token is stored locally and never committed.

## Documentation

[Repo](https://github.com/JaylenAI/Im-Nobsidian#readme) · [Changelog](https://github.com/JaylenAI/Im-Nobsidian/blob/main/docs/06-devlog/CHANGELOG.md)

## License

MIT © hanseungheon
