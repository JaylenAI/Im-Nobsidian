# Im-Nobsidian v0.18.0 — Folder Files That Round-Trip

> **Release date:** 2026-11-02
> **Focus:** phase 13 of the full-sync plan. Files kept in a folder (not embedded in a note) now travel between two
> vaults through Notion and land in the same folder, under the same name. Where files land and how they are named
> changed, so this is a minor release.

---

## English

### 🐛 Fixed

- **Folder files did not round-trip.** The receiving side read the file blocks on a folder's Notion page as a note
  body: it wrote a fake folder note (`proj/proj.md`) and saved a copy of each file under the attachments folder
  (`attachments/sheet.csv-<hash>.csv`). The vault that uploaded them did the same on its next pull. A folder page is
  now kept as a folder, and its files are written to that folder under their own names. The Notion file id is
  recorded, so a file changed on one side reaches the other.
- **Files in a folder with no notes were never uploaded.** A Notion page is now made for the folder. Files beside a
  folder note and files at the vault root are still not uploaded, but push now warns about them (before, only a debug
  log said so).
- **A changed folder file added a new block each time.** The new block replaces the old one.
- **A file uploaded with a note was uploaded again to its folder page when it changed.**
- **Embeds and icons written by name only (`![[image.png]]`, `icon: "[[icon.png]]"`) were not found in other
  folders.** If the file is not in the note's folder, the vault root or the attachments folder, it is looked up across
  the vault, the way Obsidian resolves it. Attachments kept in a subfolder under the note now upload.
- **Downloaded file names had the extension twice** (`report.pdf-<hash>.pdf` → `report-<hash>.pdf`). Files already
  downloaded under the old name are reused.

### ✨ Added

- **Deleting a folder file deletes it on the other side** when `sync.deleteSync` is on. Deleting it in the vault
  removes the Notion block. Deleting the block in Notion deletes the vault file, but only if the file is unchanged
  since the last sync; a file edited locally is kept and uploaded again.

### 🔧 Changed

- The push summary counts uploaded folder files (`N files`), `push --json` has `files` (also counted in `churn`), and
  the plugin summary shows 「파일 N」. Pull prints `N files received`.

---

## 한국어

### 🐛 고친 것

- **폴더에 둔 파일이 두 볼트 사이를 오가지 못했습니다.** 받는 쪽이 폴더 페이지의 파일 블록을 본문으로 읽어 가짜 폴더 노트
  (`proj/proj.md`)와 첨부 사본(`attachments/옆.csv-<해시>.csv`)을 만들었고, 올린 볼트도 다시 받으면 같았습니다. 이제 같은 폴더에
  같은 이름으로 받고, 한쪽에서 고친 파일이 다른 쪽에 갑니다.
- **노트 없는 폴더의 파일이 올라가지 않았습니다** — 폴더 페이지를 만들어 올립니다. 폴더 노트 옆 · 볼트 맨 위의 파일은 경고로
  알립니다.
- 바뀐 파일의 블록이 늘던 것 · 노트에 붙여 올린 파일이 폴더 페이지에 또 올라가던 것.
- **이름만 적은 임베드 · 아이콘을 다른 폴더에서 찾지 못했습니다** — 볼트 전체에서 찾습니다.
- 받은 파일 이름의 확장자가 둘이던 것(`보고서.pdf-<해시>.pdf` → `보고서-<해시>.pdf`). 예전 이름 파일은 그대로 씁니다.

### ✨ 더한 것

- **`sync.deleteSync` 를 켜면 지운 폴더 첨부를 다른 쪽에서도 지웁니다.** 볼트에서 고친 파일은 지우지 않고 다시 올립니다.

### 알려진 한계

- 폴더 노트 하나뿐인 폴더(`fn/fn.md`)는 다른 볼트에서 맨 위 노트(`fn.md`)로 받습니다 — Notion 에서 자식 페이지가 없는 페이지는
  노트입니다.
- 폴더 노트가 있는 폴더 · 볼트 맨 위의 파일은 올리지 않습니다(경고). 노트에 붙이면 함께 올라갑니다.
- 이름만 적은 임베드에 같은 이름이 여럿이면 노트에 가까운 것을 고릅니다 — Obsidian 과 다를 수 있습니다.
- 실기기(iOS · Android)와 Business 플랜의 요청 한도는 아직 재 보지 않았습니다.

---

## Verification

- **Tests:** core 4,327 · cli 184 · plugin 503 on Linux (build, lint, format, typecheck), and CI on Linux (Node 22,
  24), macOS and Windows.
- **Two vaults against real Notion** (probe `__p13_files_20261102__`): three folder files pushed from vault A landed
  in vault B in place, byte for byte, with no fake folder note and no copies. An edit in A reached B; a file added and
  a file edited in B reached A; Notion kept one block per file. A deletion in A removed the block and then the file in
  B; a block deleted in Notion removed the file in both vaults; a file edited in A and deleted in Notion was kept, warned
  about, uploaded again and received by B. Final push and pull on both sides: no changes.
- **Embeds by name:** an icon in `icons/` and an image in a subfolder `attachments/` uploaded; pulling again changed
  nothing. A vault with files downloaded under the old name kept them; pushing again changed nothing.
- **Release regression:** the eight scripts of earlier releases on the dev build against fresh probes. Output matches the 0.17.1 run except
  the intended changes — downloaded names without the doubled extension, and a folder file that now reaches the second
  vault (`files/data.csv`, byte for byte) — and the order in which Notion lists new database columns.

---

## Upgrading

No configuration changes are required.

- Folders whose files were pulled as a folder note plus copies keep those files; delete the fake folder note and the
  copies if you no longer want them. The next pull writes the files into the folder.
- With `sync.deleteSync: true`, deleting a folder file now deletes it on the other side.

```bash
npm install -g im-nobsidian@0.18.0
npm install @im-nobsidian/core@0.18.0
```

**Obsidian plugin:** download `main.js`, `manifest.json` and `styles.css` from this release into
`<vault>/<config folder>/plugins/im-notion-sync/`, or update through BRAT.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
