# Im-Nobsidian v0.19.1 — Previews Say What They Did Not Count

> **Release date:** 2026-11-02
> **Focus:** a patch found by the v0.19.0 npm smoke. A preview no longer leaves out database rows silently when it
> cannot know them yet; it says so.

---

## English

### 🐛 Fixed

- **`pull --dry-run` and `sync --dry-run` left out rows of databases the pull would discover.** A vault that lost
  `.im-nobsidian/sync.db` also lost its list of discovered databases, and a database inside a page that is new in
  Notion is found only when that page is pulled. The preview did not count those rows and did not say so, so it showed
  less than the real pull (the v0.19.0 smoke: 5 notes to re-link in the preview, 8 re-linked by the pull). The preview
  now says that rows of databases it will discover were not counted. `--json` reports it as
  `undiscoveredDatabases: true`, and the plugin's preview lists it under 「그 밖에」.

---

## 한국어

### 🐛 고친 것

- **`pull --dry-run` · `sync --dry-run` 이 받으면서 찾을 DB 의 행을 말없이 빠뜨렸습니다.** 상태 DB 를 잃은 볼트는 찾아 둔 DB 목록도
  함께 잃고, Notion 에 새로 생긴 페이지 안의 DB 는 그 페이지를 받아야 찾습니다. 미리 보기가 그 행을 세지 않고 알리지도 않아 실제
  pull 보다 적게 보였습니다(0.19.0 smoke: 미리 보기 5 · 실제 8). 이제 「새로 찾을 Notion DB 의 행은 미리 세지 않았습니다」 를
  적습니다. `--json` 은 `undiscoveredDatabases: true`, 플러그인 미리 보기는 「그 밖에」 에 적습니다.

### 알려진 한계

- 미리 보기는 그 행을 세지 않고 알리기만 합니다 — 세려면 모든 페이지를 훑어야 합니다(페이지마다 요청 1회).
- 볼트에 이미 있던 페이지에 Notion 에서 새로 넣은 DB 도 받아야 찾습니다. 이때는 알리지 않습니다.

---

## Verification

- **Tests:** core 4,338 · cli 185 · plugin 505 on Linux (build, lint, format, typecheck), and CI on Linux (Node 22,
  24), macOS and Windows.
- **Real Notion:** the v0.19.0 smoke vault with `sync.db` deleted. `pull --dry-run` listed 5 notes to re-link and the
  new line; `--json` reported `created: 0` and `undiscoveredDatabases: true`. The real pull re-linked 8, and the next
  `pull --dry-run` printed no notice.

---

## Upgrading

No configuration changes are required.

```bash
npm install -g im-nobsidian@0.19.1
npm install @im-nobsidian/core@0.19.1
```

**Obsidian plugin:** download `main.js`, `manifest.json` and `styles.css` from this release into
`<vault>/<config folder>/plugins/im-notion-sync/`, or update through BRAT.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
