# Im-Nobsidian v0.17.1 — Settings That Do What They Say

> **Release date:** 2026-11-01
> **Focus:** phase 12 of the full-sync plan, the last one. No new features: settings and documentation that disagreed
> with the code now agree, and a full regression against real Notion confirms what syncs.

---

## English

### 🐛 Fixed

- **`sync.autoSync` and `sync.autoSyncInterval` in the config file did nothing.** `nobsi watch` only read
  `--interval`, so periodic sync never ran however the file was set. `watch` now follows these two settings when
  `--interval` is not given; `--interval` still wins (`0` turns it off). The plugin keeps its own setting.
- **`propertyMapping` and `titleProperty` in `notion.databases` did nothing.** No code read them. They are removed
  from the schema; if your config sets them to something other than the default, loading it says so. Properties pair
  with frontmatter keys by name, and the title property is read from the Notion database.

### 📝 Documentation

- **The support table said attachments, icons and covers are not pushed.** They are: attachments embedded in a note
  go up with the note, other attachments go to their folder's Notion page (`sync.syncFiles`), and frontmatter
  `icon` / `cover` are sent when they change. Buttons, forms and synced blocks are marked as an API limit.
- **"Edits from the same token elsewhere — None yet" was out of date.** Since 0.15 a note synced at least once is
  checked by its content.
- **The configuration guide** now covers the 13 settings it was missing (`notion.databases`, `fullReconcileInterval`,
  `syncFiles`, `createDatabases`, `notifications`, `imageDownload`, `timeZone`, retries, media concurrency, …) and
  the retired ones. `imageDownload: "lazy"` behaves like `"skip"`.
- The roadmap in the README and `ROADMAP.md` covers v0.10 to v0.17.

---

## 한국어

### 🐛 고친 것

- **설정 파일의 `sync.autoSync` · `sync.autoSyncInterval` 이 아무것도 바꾸지 않았습니다.** `nobsi watch` 가 `--interval` 만
  봤습니다. 이제 `--interval` 이 없으면 이 둘을 따릅니다(`--interval` 이 이기고, `0` 은 끔). 플러그인은 제 설정을 씁니다.
- **`notion.databases` 의 `propertyMapping` · `titleProperty` 가 아무것도 바꾸지 않았습니다.** 스키마에서 뺐고, 기본값과
  다르게 적어 두었으면 읽을 때 알립니다.

### 📝 문서

- 지원표가 첨부 · 아이콘 · 커버 push 를 「—」 로 적고 있었습니다 — 됩니다. 버튼 · 폼 · 동기화 블록은 API 한계로 적었습니다.
- 같은 토큰을 쓰는 다른 기기의 편집 — 「None yet」 이 아니라 0.15 부터 내용으로 확인합니다.
- 설정 가이드에 빠진 키 13개와 없앤 키. `imageDownload: "lazy"` 는 `"skip"` 과 같습니다.

### 알려진 한계

- 노트가 하나도 없는 폴더(받은 그림을 두는 `attachments` 같은)의 첨부는 따로 올리지 않습니다 — 받은 것을 다시 올려 겹치지
  않게 하려는 것입니다. 노트에 붙인 첨부는 노트와 함께 올라갑니다.
- 실기기(iOS · Android)와 Business 플랜의 요청 한도는 아직 재 보지 않았습니다.

---

## Verification

- **Tests:** core 4,301 · cli 184 · plugin 503 on Linux (build, lint, format, typecheck), and CI on Linux (Node 22,
  24), macOS and Windows. Making `watch` ignore the config again fails two new tests.
- **Real CLI:** with `autoSync: true` and `autoSyncInterval: 30` in a probe vault, `nobsi watch` printed a 30-second
  full-sync period; with `--interval 0` it printed none.
- **Release regression:** the seven scripts of earlier releases, plus a new one, on the dev build against fresh
  probes in a real workspace. Output matches the 0.17.0 run except timing-dependent progress counts.
  - New: a vault pushed an emoji icon with an external cover, a Notion icon with a color, an icon and a cover from vault
    images, and an embedded PDF. Notion had each of them. A fresh vault pulled the same frontmatter, the images as
    vault files and the PDF byte for byte. Both vaults then pushed and pulled 0. An icon changed in Notion was pulled,
    an icon changed in the vault was pushed, and both sides ended at 0 again.

---

## Upgrading

No configuration changes are required. If your config sets `sync.autoSync: true`, `nobsi watch` now runs a full sync
every `autoSyncInterval` seconds — pass `--interval 0` to keep the old behaviour.

```bash
npm install -g im-nobsidian@0.17.1
npm install @im-nobsidian/core@0.17.1
```

**Obsidian plugin:** download `main.js`, `manifest.json` and `styles.css` from this release into
`<vault>/<config folder>/plugins/im-notion-sync/`, or update through BRAT.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
