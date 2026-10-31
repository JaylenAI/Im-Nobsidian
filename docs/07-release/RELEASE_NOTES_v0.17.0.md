# Im-Nobsidian v0.17.0 — Obsidian Mobile

> **Release date:** 2026-11-01
> **Focus:** phase 11 of the full-sync plan. The Obsidian plugin now loads and syncs in Obsidian Mobile (iOS,
> Android). Until now it was desktop-only.

---

## English

### ✨ Added

- **The plugin runs on Obsidian Mobile** ([ADR-053](../02-architecture/adr/053-mobile.md), `isDesktopOnly: false`).
  Mobile has no Node.js, and the old `main.js` loaded Node modules (`fs`, `path`, `crypto`, …) on start, so it could
  not load there at all. The build now routes those modules to small replacements: on desktop they hand over the real
  Node modules unchanged, and on mobile they use browser equivalents. On mobile the sync-state database
  (`.im-nobsidian/sync.db`) is written through Obsidian's vault API: written to a `.tmp` file next to it, then swapped
  in. A swap cut short is recovered on the next open. A file another device replaced underneath is never overwritten.
- **The state database is written as soon as Obsidian goes to the background.** It is normally written five seconds
  after a change. Mobile systems may suspend the app without unloading the plugin, and a page created in those five
  seconds would otherwise be created again by the next push.

### 🔧 Changed

- **No regular-expression lookbehind remains** in the core or the plugin. JavaScript before iOS 16.4 cannot parse
  lookbehind, and a single such pattern stops the whole plugin from loading. Every replaced pattern is compared with
  the old one on thousands of random inputs, and tests keep lookbehind out of the source and the built `main.js`.

### 🐛 Fixed

- **Attachment downloads keep their time limit where `AbortSignal.timeout` is missing** (WebViews before iOS 16).
  They used to throw as soon as they started there.

### Using it on mobile

- Enter the integration token once on each device — Obsidian's keychain is per device.
- Keep Obsidian in the foreground during a large first sync; if the system suspends it, run sync again.
- If the vault is also synced between devices (Obsidian Sync, iCloud, …), sync with Notion from one device at a
  time. All devices use the same token, so one device's Notion edits look like the other's own.

### ⚠️ Known limitations

- **Not run on a real phone or tablet.** Mobile was verified by loading the built plugin without Node in a test
  sandbox and in Obsidian 1.12.4 with mobile emulation against real Notion (below). Obsidian Mobile's own file
  adapter is assumed to behave like the desktop one for `list`, `rename`, `remove` and `stat`.
- There is no lock on mobile — the CLI does not run on a phone.
- If the app is killed without going to the background first, changes from the last five seconds can be lost, as on
  desktop.

---

## 한국어

### ✨ 더한 것

- **플러그인이 모바일(iOS · Android)에서 돕니다(ADR-053)** — 예전 main.js 는 처음에 Node 모듈을 불러 모바일에서 아예 뜨지 않았습니다.
  데스크톱은 예전과 같고, 모바일의 상태 DB 는 Obsidian 볼트 API 로 씁니다.
- **앱이 가려지면 상태 DB 를 바로 씁니다** — 모바일은 다른 앱으로 넘어가면 플러그인을 내리지 않고 멈춥니다.

### 🔧 바꾼 것

- **정규식 lookbehind 를 모두 없앴습니다** — iOS 16.4 앞에서는 그런 정규식 하나로 플러그인이 뜨지 않습니다.

### 🐛 고친 것

- **`AbortSignal.timeout` 이 없는 곳(iOS 16 앞)에서도 첨부 받기의 시간 상한이 걸립니다.**

### 알려진 한계

- **실기기(폰 · 태블릿)에서는 돌려 보지 않았습니다** — Node 없는 시험대와 Obsidian 1.12.4 의 모바일 흉내 + 실제 Notion 으로 확인했습니다.
- 볼트를 기기끼리도 동기화하면 Notion 과의 동기화는 한 번에 한 기기에서 하세요.

---

## Verification

- **Tests:** core 4,301 · cli 178 · plugin 503 on Linux (build, lint, format, typecheck), and CI on Linux (Node 22,
  24), macOS and Windows. CI found two Windows-only path bugs in the new build and test code, both fixed before
  release.
- **Without Node:** the built `main.js` is loaded in a sandbox with no `require`, `Buffer` or `process`, against an
  in-memory vault and an in-memory Notion served over Obsidian's `requestUrl`. It pushes, pulls, reloads, pushes
  again without creating pages, and writes the state database when hidden. Removing the mobile state-database path,
  the `Buffer` setup or the background write makes these tests fail. The replacements match Node on 600 SHA-256
  input lengths and 2,000 random `path` calls.
- **Real Obsidian and Notion:** Obsidian 1.12.4 in an isolated profile. On desktop the plugin takes the lock and
  writes with Node as before. With `Platform` set to mobile, `require` limited to what Obsidian Mobile provides and no
  `Buffer`, it loaded without any Node module. It then pushed 3 notes, pulled an edit made in Notion, pushed 0 after a
  reload, synced 0, took no lock, and wrote the database on hiding (one page, not two). Its screens were checked in
  `emulateMobile` at tablet and 390 px width.
- **Community directory checks** (obsidian-workflows with `isDesktopOnly: false`): no errors.
- **Release regression:** the seven 0.16 scripts on the dev build against a fresh probe. Two vaults pushed and
  pulled text, attachments, databases, formulas, deletions, moves between databases and a lost state database, and
  both sides ended with zero changes. Output matches the 0.16 run except timing-dependent progress counts and the
  property order Notion gives a new database. A fresh vault pulled 10 notes and then pushed and pulled 0, with the
  same content as the vault that wrote them.

---

## Upgrading

No configuration changes are required. Desktop behaviour is unchanged.

```bash
npm install -g im-nobsidian@0.17.0
npm install @im-nobsidian/core@0.17.0
```

**Obsidian plugin:** download `main.js`, `manifest.json` and `styles.css` from this release into
`<vault>/<config folder>/plugins/im-notion-sync/`, or update through BRAT — on mobile too.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
