# Im-Nobsidian v0.22.0 — Every File Has a Place in Notion

> **Release date:** 2026-11-02
> **Focus:** files in a folder named after a database row, and files at the vault root, now travel between vaults
> through the row's page and the root page (ADR-057). Block-mode pushes keep folder files instead of uploading them
> again, a folder file moved into a toggle in Notion is no longer received as a note embed, and the preview reads every
> new page. The only files left behind are those directly in a database folder — a Notion database has no body.

---

## English

### ✨ Added

- **Files beside database rows round-trip.** A file in `DB/Row/` next to the row note `DB/Row.md` is uploaded to the end
  of the row's page with the caption `📁 name`, and the receiving vault saves it in the same folder. Pushing the row
  keeps the file blocks, and a vault that follows Notion renames moves a file-only row folder with the row.
- **Files at the vault root round-trip.** In page mode they are uploaded to the end of the root page with the caption
  `📁 name` and received by the next pull in which the root changed. A file you attached to the root page yourself is
  never received or deleted, even with the same name. Database-mode vaults still only warn: their root is a database.

### 🐛 Fixed

- **Block-mode pushes uploaded folder files again on every note edit** (`preferMarkdownApi: false`, or when the
  Markdown API fails). The folder file blocks are now kept and the new body is inserted before them.
- **A folder file moved into a toggle or callout in Notion was received as an embed of the note**, leaving a copy in
  the download folder. It is now received as the folder's file, and the next push of the note moves it back to the end
  of the page. Edits and deletions also find the old block inside the toggle.
- **The preview listed rows of a database inside a new page under `databases/`.** The count was right but the real pull
  puts them beside the new page; the preview now shows the same place.

### 🔁 Changed

- **The preview counts database rows inside any number of new pages.** 0.21 read at most 100. Like a real pull it
  falls back to the block API when the Markdown API fails; only pages that cannot be read either way produce the notice
  「Notion 에 새로 생긴 페이지 가운데 본문을 읽지 못한 것이 있어 그 안의 DB 행은 미리 세지 않았습니다 — 받으면서 찾습니다」.
- **The first push after upgrading uploads row-folder and vault-root files** that earlier versions skipped. The root
  page gains file blocks.
- **A pull in which the root page changed reads the root's body once more** (one request) to find vault-root files.

---

## 한국어

### ✨ 더한 것

- **DB 행 옆 폴더의 파일이 오갑니다.** 행 노트(`DB/행.md`) 옆 `DB/행/` 의 파일을 그 행 페이지 끝에 「📁 이름」 으로 올리고, 받는
  볼트는 같은 폴더에 받습니다. 행을 고쳐 올려도 파일 블록을 지키고, Notion 의 이름 바꾸기를 따르는 볼트는 파일만 든 행 폴더도 행과
  함께 옮깁니다.
- **볼트 맨 위의 파일이 오갑니다.** 페이지 모드에서 루트 페이지 끝에 「📁 이름」 으로 올리고, 루트가 바뀐 pull 이 받습니다. 루트에
  직접 붙인 파일은 이름이 같아도 받지도 지우지도 않습니다. DB 모드는 루트가 DB 라 여전히 경고합니다.

### 🐛 고친 것

- **블록 방식 push 가 노트를 고칠 때마다 폴더 첨부를 다시 올렸습니다** — 파일 블록을 두고 새 본문을 그 앞에 넣습니다.
- **Notion 에서 토글 · 콜아웃 안으로 옮긴 폴더 첨부를 노트의 임베드로 받았습니다** — 받은 그림 폴더에 사본이 생겼습니다. 이제 그
  폴더의 파일로 받고, 다음 노트 push 가 페이지 끝으로 되돌립니다.
- **미리 보기가 새 페이지 안 DB 의 행을 `databases/` 아래로 보였습니다** — 실제 pull 처럼 새 페이지 옆으로 보입니다.

### 🔁 바뀐 것

- **미리 보기가 새 페이지 수에 상관없이 그 안의 DB 행을 셉니다** — 0.21 은 100개까지만 읽었습니다. Markdown API 로 읽지 못하면
  실제 pull 처럼 블록으로 읽습니다.
- **올린 뒤 처음 push 가 행 폴더 · 볼트 맨 위 파일을 올립니다** — 루트 페이지에 파일 블록이 더해집니다.
- **루트가 바뀐 pull 은 루트 본문을 한 번 더 읽습니다**(요청 1회).

### 알려진 한계

- DB 폴더 바로 아래 · DB 모드 볼트 맨 위의 파일은 올리지 않고 경고합니다 — Notion 의 DB 에는 본문이 없습니다.
- 블록 방식에서 토글 안으로 옮긴 폴더 첨부는 노트를 고칠 때 한 번 다시 올립니다 — 블록 API 는 블록을 옮기지 못해 토글과 함께
  지워집니다.

---

## Verification

- **Tests:** core 4,386 · cli 185 · plugin 512 on Linux (build, lint, format, typecheck), and CI on Linux (Node 22,
  24), macOS and Windows. Every new test failed on the code before its fix.
- **Real Notion (CLI, three vaults):** block-mode push kept the folder files' Notion file ids and put the new text
  before them; a row-folder file and a vault-root file arrived byte-identical, survived edits of the row, travelled
  back from the other vault and were deleted on both sides; a file attached to the root page by hand with the same
  name was neither received nor deleted; a folder file placed inside a toggle was received as the folder's file by
  both vaults (no copy in the download folder) and moved back to the end of the page by the next push. A third vault
  that pulled from scratch matched the others byte for byte, and every second push and pull had no changes.
- **Preview:** 102 new pages with a database of two rows inside the last — preview 107 = real pull 107, no notice,
  same paths.
- **Regression:** the eight real-Notion scenarios of P12 passed on dev.

---

## Upgrading

No configuration changes are required.

```bash
npm install -g im-nobsidian@0.22.0
npm install @im-nobsidian/core@0.22.0
```

**Obsidian plugin:** download `main.js`, `manifest.json` and `styles.css` from this release into
`<vault>/<config folder>/plugins/im-notion-sync/`, or update through BRAT.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
