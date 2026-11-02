# Im-Nobsidian v0.21.0 — Files Beside Folder Notes Sync Too

> **Release date:** 2026-11-02
> **Focus:** files in a folder that has a folder note, or in a folder named after a note, now travel between vaults
> through that note's Notion page (ADR-056). Two vaults editing, renaming or deleting the same attachment no longer
> leave duplicate blocks or lose an edit. The preview now reads new pages to count the database rows inside them.

---

## English

### ✨ Added

- **Files beside folder notes round-trip.** A file in `X/` where `X/X.md` is the folder note, or in `N/` next to
  `N.md`, is uploaded to the end of that note's Notion page with the caption `📁 name`. The receiving vault takes it
  off the note and saves it in the same folder. Text written below it in Notion stays in the note, and pushing the note
  keeps the file blocks. Until 0.20 these files only produced a warning.

### 🐛 Fixed

- **An attachment edited to the same size was not uploaded.** Changes such as one digit in a CSV never reached Notion
  (since 0.18.0). Size and modification time are now recorded, and the content is compared when they differ.
- **Two vaults editing the same attachment left two blocks.** Only the later upload remains.
- **Renaming a folder or a note uploaded its attachments again.** Each file's record now moves with it, and an
  unchanged file is not uploaded. A folder that holds only files is now recognised as renamed instead of getting a new
  folder page. A vault that follows Notion renames (`renameOnTitleChange`) now moves the note's file folder with the
  note.
- **Deleting an attachment could discard another vault's edit of it.** A vault that deleted the file before pulling
  removed every block with that name. It now removes only the block it uploaded or received; the next pull brings the
  newer edit back. This applies to folder pages too.
- **The plugin's pull and sync notices did not mention received images and files.** A pull that only received
  attachments edited in another vault read 「생성 0 / 수정 0 / 삭제 0」. It now adds 「받은 그림 N / 받은 파일 N」, as the
  CLI already did.

### 🔁 Changed

- **The preview counts database rows inside new pages.** It reads the bodies of up to 100 new pages. The notice now
  appears only when there are more, or some could not be read, and reads 「Notion 에 새로 생긴 페이지가 많거나 읽지 못해
  그 일부 안의 DB 행은 미리 세지 않았습니다 — 받으면서 찾습니다」.
- **The first push after upgrading uploads the files beside folder notes** that earlier versions skipped, adding file
  blocks to those notes' pages.

---

## 한국어

### ✨ 더한 것

- **폴더 노트 옆 파일이 오갑니다.** 폴더 노트(`X/X.md`)가 있는 폴더 · 노트 이름의 폴더(`N.md` 옆 `N/`)의 파일을 그 노트의 Notion
  페이지 끝에 「📁 이름」 으로 올리고, 받는 볼트는 노트에서 떼어 같은 폴더에 받습니다. Notion 에서 그 아래에 글을 써도 노트에
  남고, 노트를 고쳐 올려도 파일 블록을 지킵니다. 0.20 까지는 경고만 냈습니다.

### 🐛 고친 것

- **같은 크기로 고친 첨부를 올리지 않았습니다**(0.18.0 부터) — 크기 · 수정 시각을 적어 두고, 다르면 내용으로 견줍니다.
- **두 볼트가 같은 첨부를 고쳐 올리면 블록이 둘 남았습니다** — 나중에 올린 것 하나만 남습니다.
- **폴더 · 노트의 이름을 바꾸면 첨부를 다시 올렸습니다** — 기록이 파일을 따라가고, 같은 파일은 올리지 않습니다. 파일만 든 폴더도
  이름 바꾸기로 알아봅니다. Notion 의 이름 바꾸기를 따르는 볼트는 노트와 함께 그 파일 폴더도 옮깁니다.
- **첨부를 지운 볼트가 다른 볼트의 고침까지 지웠습니다** — 제가 올리거나 받은 블록만 지우고, 고친 것은 다음 pull 이 다시
  받습니다. 폴더 페이지도 같습니다.
- **플러그인의 pull · sync 알림이 받은 그림 · 파일을 적지 않았습니다** — 이제 「받은 그림 N / 받은 파일 N」 을 적습니다.

### 🔁 바뀐 것

- **미리 보기가 새 페이지 안의 DB 행도 셉니다** — 새 페이지의 본문을 100개까지 읽습니다. 알림은 그보다 많거나 읽지 못한 때에만
  나옵니다.
- **올린 뒤 처음 push 가 폴더 노트 옆 파일을 올립니다** — 그 노트 페이지에 파일 블록이 더해집니다.

### 알려진 한계

- 블록 방식으로 올리는 볼트(`preferMarkdownApi: false` · Markdown API 실패)는 노트를 고칠 때마다 폴더 첨부를 다시 올립니다.
- Notion 에서 폴더 첨부 블록을 토글 안으로 옮기면 그 노트의 임베드로 받습니다.
- DB 행 · DB 폴더 · 볼트 맨 위에 둔 파일은 여전히 올리지 않고 경고합니다 — 그 자리에 실을 Notion 페이지가 없습니다.

---

## Verification

- **Tests:** core 4,373 · cli 185 · plugin 512 on Linux (build, lint, format, typecheck), and CI on Linux (Node 22,
  24), macOS and Windows. Every new test failed on the code before its fix.
- **Real Notion (CLI, two vaults):** files beside a folder note and a note-named folder arrived byte-identical; a
  same-size edit, text written below them in Notion, deletion, renaming `X→W`, `N→K` and a file-only `P→Q` (one block
  each, second push 0, the other vault following the renames received only the new paths), and an edit racing a
  deletion (the block stayed and the deleting vault received the edit). Both vaults ended with no changes and the same
  files.
- **Real Notion (plugin, Obsidian 1.12.4, isolated profile):** the plugin vault uploaded the three files, renamed
  the folders and notes through Obsidian's file manager (push: moved 4, one block each, second push 0), and edited an
  attachment while a CLI vault deleted it (the block stayed and the CLI vault received the edit). A CLI edit of the
  attachment then reached the plugin with the notice 「받은 파일 1」. Both vaults ended with no changes and the same
  files.
- **Preview:** a new page with an inline database — preview 3 = real pull 3, no notice.
- **Large vault (5,000 notes, 200 files, no Notion writes):** `status` 0.5 s, `push --dry-run` 1.1 s, 131 MB peak memory.
- **Regression:** the eight real-Notion scenarios of P12 passed on dev.

---

## Upgrading

No configuration changes are required.

```bash
npm install -g im-nobsidian@0.21.0
npm install @im-nobsidian/core@0.21.0
```

**Obsidian plugin:** download `main.js`, `manifest.json` and `styles.css` from this release into
`<vault>/<config folder>/plugins/im-notion-sync/`, or update through BRAT.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
