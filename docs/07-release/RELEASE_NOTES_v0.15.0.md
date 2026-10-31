# Im-Nobsidian v0.15.0 — Merging, Resuming and Relinking

> **Release date:** 2026-10-31
> **Focus:** phases 6 and 7 of the full-sync plan. Links to headings and blocks work in Notion, linked views and
> `.base` views follow both ways, edits on different lines merge, interrupted writes finish on the next run, and a
> vault that lost its sync-state database relinks instead of duplicating.

---

## English

### ✨ Added

- **Heading and block links open in Notion**
  ([ADR-048](../02-architecture/adr/048-other-structure.md)). `[[Note#Heading]]`, `[[Note#^block]]` and
  `[[#Heading]]` are sent as links to that block and come back as the same wikilinks. Block links made in Notion
  are pulled with their text as the alias. Only top-level blocks of a page are found; otherwise the link stays
  text, as before.
- **Each linked view gets its own `.base`.** A linked view placed on another page is pulled into the source
  database folder as «Source - View» `.base`, with that view's name, filter and sort. Push turns the embed back into
  the same linked view; a linked view deleted in Notion removes its `.base` and embed.
- **Views added or deleted in a `.base` are created or deleted in Notion** — table, gallery (cards) and list views.
  Views edited in Notion in the meantime are not deleted.
- **Renaming a database in Notion renames its folder** (`sync.renameOnTitleChange`) when the folder was named
  after it. Embeds of a renamed `.base` are updated.
- **Renaming a select option in the sidecar keeps row values.** The API cannot rename options, so a new option is
  added, rows are moved to it and the old option is deleted. Before, those rows lost their value.
- **Folder filters in your own `.base` files are offered for fixing** when a sync moved the folder: the CLI asks at
  the end of pull, push and sync (`--yes` fixes without asking), the plugin asks in a dialog afterwards.
- **Links are fixed in notes outside the connection** — other connection folders and unsynced notes.
- **The CLI matches a note that was renamed and edited** to its page when the folder or file name is the same and
  the bodies overlap enough, instead of creating a new page.
- **Conflict strategy `merge`.** When the vault and Notion changed different lines, pull merges them into the note
  and the next push sends the result. Same lines, or no earlier copy, stay a conflict as with `manual`. The plugin
  has a toggle for it.
- **A vault that lost `.im-nobsidian/sync.db` is relinked**
  ([ADR-049](../02-architecture/adr/049-lost-state-relink.md)). Pull relinks every note that sits where its page
  belongs instead of downloading `Name (id).md` copies. Notes whose text differs become conflicts. Push in that state
  stops when Notion already has the same name and asks you to pull first — before, it created a second copy of
  every page.
- **`push --dry-run` shows what the real push would refuse** (pages edited or deleted in Notion), and
  **`pull --dry-run` lists the notes that would conflict or be merged**.
- `status` and `pull --dry-run` show rows that would be renamed after a title change in Notion.

### 🐛 Fixed

- **Interrupted writes finish on the next run.** When the response to a body update, a move or a delete was lost,
  or the process died, the next push refused («pull first») and that pull reported the tool's own write as a
  conflict. Now the next run completes it. If a person edited the page in Notion afterwards, it is still not
  overwritten.
- **Another device using the same token, writing in the same minute, could be missed** — pull skipped it and push
  overwrote it. When a fingerprint of the last body exists, the content is checked.
- A note that embeds a moved `.base` went back to the old path on the next pull.

### 🧪 Verified against the real Notion API

Two vaults (A, B) against one probe page, CLI built from `dev`. Every scenario ends with push and pull on both
sides reporting no changes.

| Scenario                                                                                                | Result                                                                                   |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A pushes notes, attachments, a database and a 200-byte title; B pulls; A pulls back                     | ✅ 10 created on B · notes identical on both sides                                       |
| Formula edited locally · note deleted with `deleteSync` off · page trashed in Notion                    | ✅ formula not sent · note restored · trashed page removed · `verify` complete           |
| Block deleted in Notion without changing the page's edit time                                           | ✅ now picked up by a plain pull (0.14 needed `--rerender`)                              |
| Property renamed in Notion · `.base` view edited · sidecar property added · new database under the root | ✅ followed on both vaults                                                               |
| Select option renamed in the sidecar                                                                    | ✅ rows keep the value under the new name (0.14 left them empty)                         |
| Notes moved into, out of and between databases                                                          | ✅ columns added to the target · both vaults identical after `pull --force`              |
| `merge`: B and Notion change different lines                                                            | ✅ `push --dry-run` shows the refusal · pull merges · push sends · A gets both lines     |
| B's state database deleted                                                                              | ✅ push stops (`UnlinkedVaultError`) · pull relinks 8 notes · no file created or changed |

### Known limitations

- **Relinking after a lost state database cannot restore** the last synced copy (so `merge` cannot merge those
  notes), preserve markers or the attachment registry. Notes renamed in the meantime are downloaded again.
  `--dry-run` counts notes it will relink as created.
- Block links find top-level blocks only. A link to a heading created in the same push becomes a link on the next
  edit.
- Linked-view edits are picked up when the source database is pulled or at the full scan.
- Option renames in the sidecar go through add, move and delete — the option's id changes.
- Text on the same line as a file embed (`![[file.pdf]]text`) comes back on its own line: Notion files are blocks.

---

## 한국어

### ✨ 더한 것

- **제목 · 블록 링크가 Notion 에서 눌립니다(ADR-048).** `[[노트#제목]]` · `[[노트#^블록]]` · `[[#제목]]` 을 그 블록으로 가는 링크로
  올리고, 받으면 같은 위키링크로 돌아옵니다. 페이지의 맨 위 블록만 찾습니다 — 못 찾으면 예전처럼 글로 둡니다.
- **링크드 뷰마다 자기 `.base`** — 원본 DB 폴더에 「원본 - 보기 이름」 `.base` 로 받고, push 는 같은 링크드 뷰로 되돌립니다.
- **볼트에서 더하고 지운 `.base` 보기를 Notion 에도** 만들고 지웁니다(표 · 카드 · 목록).
- **Notion 에서 바꾼 DB 이름으로 폴더 이름도**(`sync.renameOnTitleChange`) — 폴더 이름이 DB 이름을 따를 때만.
- **사이드카에서 선택 옵션 이름을 바꾸면 행 값이 따라갑니다** — 예전엔 그 값의 행이 비었습니다.
- **직접 만든 `.base` 의 폴더 필터를 묻고 고칩니다** · **다른 연결의 노트 링크도 고칩니다** · **CLI 가 이름과 내용을 함께 바꾼 노트를
  같은 페이지로 짝짓습니다**.
- **충돌 전략 `merge`** — 서로 다른 줄을 고쳤으면 합쳐 쓰고 이어지는 push 가 올립니다. 플러그인에서도 켭니다.
- **상태 DB 를 잃은 볼트를 다시 잇습니다(ADR-049).** pull 이 같은 자리의 노트를 그 페이지와 잇고(글이 다르면 충돌), 그 상태의 push 는
  Notion 에 같은 이름이 있으면 멈춥니다 — 예전엔 볼트와 Notion 에 한 벌씩 더 생겼습니다.
- **`push --dry-run` 이 실제 push 가 거절할 노트를, `pull --dry-run` 이 충돌 · 합침이 될 노트를 보입니다.**

### 🐛 고친 것

- **쓰다 끊긴 갱신 · 이동 · 지우기를 다음 실행이 마저 합니다** — 예전엔 push 가 거절하고 pull 이 이 도구가 쓴 글을 충돌로 올렸습니다.
- **같은 토큰을 쓰는 다른 기기의 같은 분 쓰기를 놓치던 것** — 지난 지문이 있으면 내용으로 확인합니다.
- 옮긴 `.base` 를 넣은 노트가 다시 받으면 옛 경로로 돌아가던 것

### 알려진 한계

- 상태 DB 를 잃은 뒤에는 지난 사본(merge) · 보존 마커 · 첨부 기록을 다시 세우지 못합니다. 그 사이 이름을 바꾼 노트는 새로 받습니다.
- 블록 링크는 맨 위 블록만 · 링크드 뷰 편집은 원본 DB 를 받을 때나 전체 대조에서 보입니다.

---

## Verification

- **Tests:** 4,843 passed on Linux (build, lint, format, typecheck), and the full suite on Windows in CI.
- **Real Notion API:** the table above (regression scripts, vaults A and B), plus during development a vault whose
  state database was deleted: push stopped, pull relinked 8 notes with 0 created and 1 conflict (the note edited
  meanwhile), no new files, and resolve sent the local text.

---

## Upgrading

No configuration changes are required. `merge` is opt-in (`sync.conflictStrategy`). If a vault lost its state
database, pull (or sync) before you push.

```bash
npm install -g im-nobsidian@0.15.0
npm install @im-nobsidian/core@0.15.0
```

**Obsidian plugin:** download `main.js`, `manifest.json` and `styles.css` from this release into
`<vault>/<config folder>/plugins/im-notion-sync/`, or update through BRAT.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
