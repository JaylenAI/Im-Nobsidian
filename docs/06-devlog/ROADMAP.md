# Im-Nobsidian Roadmap

> Last updated: 2026-05-14

## Current State (v0.1.0)

First public release. True bidirectional Obsidian ↔ Notion sync via CLI.
377 tests passing, 15+ block types, frontmatter roundtrip, conflict resolution.

---

## Release Timeline

```
v0.1.0  ✅ Current — Bidirectional sync via Notion Markdown API
v0.2.0  → Incremental sync + block-level diff + Myers diff
v0.5.0  → Obsidian community plugin (sql.js WASM)
v1.0.0  → Database view sync, multi-workspace, 1000+ notes
```

---

## v0.1.0 — First Public Release (Current)

### Completed

- [x] True bidirectional sync (push/pull/sync)
- [x] Notion Markdown API integration (enhanced conversion quality)
- [x] 15+ Notion block types bidirectional conversion
- [x] Frontmatter ↔ Notion properties mapping (15+ types, YAML code block roundtrip)
- [x] Wikilink ↔ Notion page mention bidirectional mapping
- [x] Toggle/column/divider/video/embed bidirectional support
- [x] Color/underline/mention preservation
- [x] Preserve marker system for round-trip fidelity
- [x] 3-way merge conflict resolution (4 strategies)
- [x] .im-nobsidian-ignore path filtering
- [x] CLI 8 commands (init/push/pull/sync/status/diff/resolve/watch)
- [x] File watcher + auto sync
- [x] Rate limiting + exponential backoff + jitter
- [x] SQLite WAL state DB + transactions
- [x] Folder structure → Notion page hierarchy mapping
- [x] Image pull download + deduplication
- [x] Database parent mode (PropertyMapper)
- [x] 377 tests + 11 E2E tests
- [x] OSS docs (README EN/KO, CONTRIBUTING, COC, SECURITY, CHANGELOG)
- [x] CI/CD (GitHub Actions, Node 20+22 matrix)

### Known Limitations

- Image push: Notion API has no file upload for page content → placeholder preservation
- Blank line compression: Notion normalizes whitespace (no semantic difference)
- First-push wikilinks: Cross-references between new pages may not resolve on first sync
- Notion-only blocks (button, form, synced block): API returns unsupported

---

## v0.2.0 — Performance & Quality

### Tasks

- [ ] Incremental sync: `last_edited_time` cursor-based change detection
- [ ] Block-level diff: page-level → block-level delta updates
- [ ] Myers diff algorithm for 3-way merge
- [ ] @tryfabric/martian fork (katex >=0.16, ESM compat)
- [ ] Benchmark: 100/500/1000 note sync performance

---

## v0.5.0 — Obsidian Plugin Release

### Tasks

- [ ] sql.js (WASM) DB adapter (replace better-sqlite3)
- [ ] Plugin real-world testing (10+ notes vault)
- [ ] obsidianmd/obsidian-releases PR submission
- [ ] BRAT beta channel pre-release
- [ ] manifest.json / versions.json validation

---

## v1.0.0 — Stable Release

### Tasks

- [ ] Database view sync (filters, sorts, relations)
- [ ] Notion API file upload support (when API supports it)
- [ ] Multi-workspace support
- [ ] Performance: 1000+ notes within 5 minutes
- [ ] Obsidian community plugin official registration

---

## Market Position

| Tool               | Direction              | Status                     |
| ------------------ | ---------------------- | -------------------------- |
| obsidian-to-notion | One-way (→Notion)      | ~550 stars, low activity   |
| Nobsidion          | Claims bidirectional   | Small, incomplete          |
| Obsidian Importer  | One-way (→Obsidian)    | Official, migration only   |
| **Im-Nobsidian**   | **True bidirectional** | **Library + CLI + Plugin** |

### Why Im-Nobsidian

1. Only true bidirectional sync tool
2. Only project offering programmatic API (library)
3. Only project with built-in conflict resolution
4. Only project with CLI + Plugin + Library triple deployment
5. Bilingual docs (EN/KO) for global + Korean community
