# Im-Nobsidian v0.16.0 — Plugin Parity, Platform Names and Large Vaults

> **Release date:** 2026-10-31
> **Focus:** phases 8 to 10 of the full-sync plan. The plugin has the CLI's settings and commands, macOS Korean
> (NFD) names and names that differ only in case sync correctly, Obsidian-only files stay out of Notion by default,
> and a large vault's first push finishes without rate-limit stalls.

---

## English

### ✨ Added

- **Check Notion from the plugin settings.** It asks Notion whether the token works and whether this integration can
  read the root page (or database), and says what to fix: wrong token, page not shared, no access, or in the trash.
  Each folder connection has the same check. Before, you found out when the first sync failed.
- **Plugin commands match the CLI** — **Sync preview** (`sync --dry-run`: what would be pulled, pushed, left in
  conflict or not processed), **Check everything was pulled** (`verify`), and **Resolve remaining conflicts the same
  way** in the conflict dialog (`resolve --strategy`). Checks don't overlap a running sync.
- **Plugin settings match the CLI** — all five conflict strategies, deleting on the other side (on by default in the
  plugin; before, it could not be turned off), uploading attachments, creating databases from definition folders,
  page notifications, the full-check interval, the attachments folder, image download, the Markdown API, database
  mode, and extra databases outside the root page. Extra databases could be written to the settings file before, but
  were never passed to the engine.
- **Sync log command in the plugin** — each sync this session with its summary, notes and the notes it could not
  process, with reasons. Notices fade and auto-sync stayed silent, so there was nowhere to look again.
- **Canvas, Excalidraw and template folders are not synced by default**
  ([ADR-051](../02-architecture/adr/051-obsidian-only-excludes.md), `paths.excludeObsidianOnly`, plugin setting
  «Obsidian 에서만 쓰는 것은 빼기»). JSON drawings became thousands of lines of text or unopenable file blocks in
  Notion, and templates (`{{date}}`, Templater) only cluttered the page list. Template folders are read from the
  Obsidian «Templates» and Templater settings. Pages already pushed are **not** deleted from Notion, even with
  `deleteSync` on (measured).

### 🐛 Fixed

- **macOS NFD Korean names** ([ADR-050](../02-architecture/adr/050-platform-paths.md), CLI). Finder stores Korean
  names in NFD. The CLI used them as they were, so `[[회의록]]` did not find the note and Notion titles were NFD; on
  Linux, new notes pulled into such a folder landed in a separate NFC-named folder. Vault paths, titles and links are
  now NFC (as in Obsidian, measured on 1.12.4), while reads and writes use the name on disk. State written in NFD by
  older versions is rewritten to NFC once, without deleting or creating pages (measured on a vault written by 0.15.0).
- **Two pages whose names differ only in case overwrote one file** on macOS and Windows. The second one is now pulled
  under a name with its id. Links fall back to a case-insensitive match, as in Obsidian.
- **Requests went out faster than the rate-limit interval**
  ([ADR-052](../02-architecture/adr/052-large-vault.md)). Every concurrent slot read the same «last request» time,
  slept together and fired together, so the default ~171 requests/min was really about 8 per second. A 1,000-note
  first push hit 429 repeatedly and paused up to 40 seconds each time. The same push now finishes in 18 minutes with
  no 429. Speed is set by `advanced.rateLimitIntervalMs`; Business and Enterprise workspaces can lower it.
- **Large first pushes slowed down with the square of the vault size** — the case-insensitive link lookup had no
  index. Local work for 5,000 notes fell from 15.7 s to 9 s and now grows linearly.
- **Rows where only read-only properties changed were listed as «updated»** in push progress while the summary said
  no changes. They are no longer listed (also in `--dry-run`).
- Renaming in Notion a database created by push now renames its folder too; names a person ended with «(hex)» are no
  longer mistaken for pull's id suffix; rows where only read-only properties changed are no longer counted as
  updated.
- **The plugin uploads images and attachments.** Its HTTP adapter sent file uploads with an empty multipart body,
  which Notion rejected (`body.file should be defined`) — nothing was ever uploaded from the plugin (the CLI was not
  affected). New attachments are also uploaded when no note changed.
- **Warnings that had gone silent are shown again** — unsupported or oversized attachments, unreachable databases,
  properties missing from the database, placeholder blocks. Attachments that could not be uploaded count as not
  processed. The plugin shows failures with their reasons, also for auto-sync. CLI `--verbose` and `--quiet` work,
  and user errors no longer print a Node stack trace.

### 🗑 Removed

- Three settings that never changed anything: `notion.workspaceId`, `conversion.preserveMarkers` and
  `conversion.frontmatterMapping`. Old settings files still load; a value written to change something is reported as
  a warning.

### ⚠️ Known limitations

- Notion decides «today» in UTC through the API, so relative-date filters can differ from Bases by a day between
  00:00 and 09:00 KST.
- The first pull after the first push (and `pull --force`) asks every page once for inline databases — about
  10 minutes per 1,000 pages with no output.
- Not measured: the Obsidian app on a real Mac with an NFD vault (CI runs the unit tests on macOS), a lower interval
  on a Business workspace, and 5,000 notes against real Notion.

---

## 한국어

### ✨ 더한 것

- **플러그인 설정의 「Notion 확인」** — 토큰과 루트 페이지(DB)를 읽을 수 있는지 Notion 에 물어 고칠 곳을 말합니다. 폴더 연결마다
  있습니다.
- **플러그인 명령이 CLI 와 같습니다** — Sync 미리 보기 · 빠짐없이 받았는지 확인 · 남은 충돌도 같은 것으로 · 동기화 기록.
- **플러그인 설정이 CLI 와 같습니다** — 충돌 전략 다섯 · 반대쪽에서도 지우기 · 첨부 올리기 · DB 정의 폴더를 DB 로 · 알림 · 전체 확인
  주기 · 루트 밖에서 더 받는 DB 등.
- **Canvas · Excalidraw · 템플릿 폴더를 기본으로 빼고 올립니다(ADR-051)** — 이미 올린 것은 Notion 에서 지우지 않습니다.

### 🐛 고친 것

- **macOS 의 NFD 한글 이름(ADR-050)** — 링크가 노트를 못 찾고 Notion 제목이 NFD 로 올라가던 것. 예전 기록은 한 번 NFC 로 옮겨 적습니다.
- **대소문자만 다른 두 페이지가 한 파일을 덮던 것**(macOS · Windows).
- **요청이 요청 간격보다 빨리 나가 큰 볼트의 첫 push 가 429 로 멈추던 것(ADR-052)** — 1,000 노트가 429 없이 18분.
- **큰 볼트의 첫 push 가 노트 수의 제곱으로 느려지던 것** — 상태 DB 스키마 6(색인 둘).
- **플러그인이 그림 · 첨부를 올리지 못하던 것** · 숨은 경고 · 실패 까닭 · CLI `--verbose`/`--quiet`.

### 알려진 한계

- Notion API 의 「오늘」은 UTC 의 날입니다(KST 00~09시는 Bases 와 하루 어긋남).
- 처음 올린 뒤 첫 pull 과 `pull --force` 는 페이지마다 인라인 DB 를 묻습니다 — 1,000 페이지에 10분쯤, 출력 없이.

---

## Verification

- **Tests:** core 4,278 · cli 178 · plugin 481 on Linux (build, lint, format, typecheck), and CI on Linux (Node 22,
  24), macOS and Windows.
- **Release regression:** seven scripts on the dev build against a fresh probe — two vaults pushing and pulling text,
  attachments, databases, formulas, deletions, moves between databases and a lost state database — all ending with
  zero changes on both sides. One defect found and fixed (the progress line above); the run was repeated with the fix.
- **Real Notion API:** NFD vaults written by the new CLI and by 0.15.0, the Obsidian-only excludes in the CLI and in
  the plugin (isolated Obsidian), Notion's «today», and a 1,000-note vault — first push 17.9 min with no 429, peak
  138 MB, status 0.3 s, `verify` 1,020 / 1,020.

---

## Upgrading

No configuration changes are required. Canvas, Excalidraw and template folders stop syncing; set
`paths.excludeObsidianOnly: false` (or turn off the plugin setting) to keep syncing them. The state database moves to
schema 6 on first open; older versions still open it.

```bash
npm install -g im-nobsidian@0.16.0
npm install @im-nobsidian/core@0.16.0
```

**Obsidian plugin:** download `main.js`, `manifest.json` and `styles.css` from this release into
`<vault>/<config folder>/plugins/im-notion-sync/`, or update through BRAT.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
