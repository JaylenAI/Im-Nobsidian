# Im-Nobsidian v0.14.0 — Moving Pages and Rows Between Databases

> **Release date:** 2026-10-30
> **Focus:** phase 5 of the full-sync plan. Moving a note into or out of a database moves the same Notion
> page, from either side — its id, comments and backlinks stay.

---

## English

### ✨ Added

- **Moves in the vault move the same Notion page**
  ([ADR-047](../02-architecture/adr/047-page-database-moves.md)). Before, push refused these moves.
  - A page note moved into a database folder becomes a row of that database; its frontmatter becomes
    properties.
  - A row note moved out of its database folder becomes a page; its frontmatter stays in the vault.
  - A row note moved into another database folder becomes a row there. Notion adds the columns the target
    lacks — push names them beforehand, in `--dry-run` too.
  - A note with Notion edits that have not been pulled is not moved; push asks you to pull first.
- **A folder already pushed as pages can become a database.** `nobsi prepare-db` (plugin: «DB 로
  바꾸기») now accepts it. The next push creates the database, moves the pages in as rows and trashes the
  emptied folder page. Only folders you prepared are converted.
- **Moving or renaming a database folder in the vault moves the Notion database** under the new parent
  page, and renames it when the folder was named after it. Rows, views and the database id stay.
- **Moves made in Notion are followed by pull** — a page into a database, a row out of one, a row to
  another database (with its subpage folder), a database under another page (with its rows, `.base`,
  sidecar and links). When a page becomes a row, Notion's empty columns don't wipe the vault's
  frontmatter values; the next push sends them as row properties.
- **If both sides moved a note, the vault wins.** Pull leaves it and the next push moves Notion to the
  vault's place. `pull --dry-run` reports the same.

### 🐛 Fixed

- 🔴 **The full scan could delete live notes inside a database.** Subpages of rows, and pages moved into a
  database, looked like pages moved out of scope; with `sync.deleteSync` on they were deleted from the
  vault. Pulled databases and their rows are now in scope.
- **`.base` views listed the subpages of rows as rows.** The folder filter `file.inFolder` includes
  subfolders; it is now `file.folder ==`. `.base` files written by earlier versions are rewritten once by
  the next pull, including those Obsidian re-saved without the header comment.
- `pull --dry-run` disagreed with the real pull for notes moved on both sides, and counted folder pages
  whose only change was a moved subpage.
- After a database folder was moved, its `.base` was treated as edited in the vault, and a `.base` under
  the old name was left behind.

### 🧪 Verified against the real Notion API

A new test root, vault A pushing and a fresh vault B pulling, built from this release's code:

| Step                                                                                          | Result                                     |
| --------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 0.12 regression: formatting, attachments, long Korean title, database; both vaults push/pull  | 10 created · 4 created · no changes · same |
| 0.12 regression: read-only edit, D8, changes-only deletion, block deletion with `--rerender`  | same as 0.13                               |
| 0.13 regression: property rename in Notion, `.base` view push, sidecar property, new database | same as 0.13                               |
| 0.13 regression: select option deleted from the sidecar, formula changed in Notion            | dry-run warning · both vaults follow       |
| A moves a page note into a database folder and a row into another database folder → push      | row in each · added column `Points` named  |
| Notion moves a row out of its database → `pull --force` in both vaults                        | both follow · bodies identical             |
| Both vaults push and pull again                                                               | no changes                                 |

During development the Notion-side and both-sides moves were also run in a real Obsidian (1.12.4) with
the plugin, including a `.base` view that went from 4 results (with a row's subpage) to 3.

### Known limitations

- **A move made in Notion shows up at the next full scan** (hourly, `sync.fullReconcileInterval`) or with
  `nobsi pull --force`. Moving doesn't change Notion's edit time.
- **Renaming a database in Notion renames its `.base` and sidecar, not its folder.**
- Moving a row to another database adds the columns it lacks to that database (Notion's behaviour).
- A `.base` you wrote yourself (no header comment, no view record) keeps its folder filter.

---

## 한국어

### ✨ 더한 것

- **볼트에서 옮기면 Notion 에서도 같은 페이지째 옮깁니다(ADR-047).** 예전엔 push 가 거절했습니다.
  - 페이지 노트를 DB 폴더로 → 그 DB 의 행. frontmatter 가 속성이 됩니다.
  - 행 노트를 DB 폴더 밖으로 → 페이지. frontmatter 는 볼트에 남습니다.
  - 행 노트를 다른 DB 폴더로 → 그 DB 의 행. Notion 이 대상 DB 에 없는 열을 더합니다 — push(dry-run 포함)가 미리 알립니다.
  - Notion 에서 받지 않은 편집이 있는 노트는 옮기지 않고 pull 을 먼저 하라고 알립니다.
- **이미 페이지로 올린 폴더를 DB 로 바꿉니다.** `nobsi prepare-db`(플러그인 「DB 로 바꾸기」)가 받습니다. 다음 push 가 DB 를 만들고
  페이지를 행으로 옮기며, 비게 된 폴더 페이지는 휴지통에 넣습니다. 준비한 폴더만 바꿉니다.
- **볼트에서 DB 폴더를 옮기거나 이름을 바꾸면 Notion 의 DB 도** 새 부모 아래로 옮기고, 폴더 이름이 DB 제목을 따르던 때는 제목도
  바꿉니다. 행 · 보기 · DB id 는 그대로입니다.
- **Notion 에서 옮긴 것을 pull 이 따라갑니다** — 페이지를 DB 안으로 · 행을 DB 밖으로 · 행을 다른 DB 로(하위 페이지 폴더째) · DB 를
  다른 페이지 아래로(행 · `.base` · 사이드카 · 링크째). 페이지가 행이 될 때 Notion 의 빈 열이 볼트 frontmatter 값을 지우지 않습니다.
- **양쪽에서 옮겼으면 볼트가 먼저입니다.** pull 은 받지 않고 다음 push 가 Notion 을 볼트의 자리로 옮깁니다. `pull --dry-run` 도 같게
  보입니다.

### 🐛 고친 것

- 🔴 **전체 대조가 DB 안의 살아 있는 노트를 지울 수 있던 것** — 행의 하위 페이지와 DB 안으로 옮긴 페이지가 범위 밖으로 옮겨진 것으로
  보여 `sync.deleteSync` 를 켠 볼트에서 지워졌습니다.
- **`.base` 보기에 행의 하위 페이지가 행으로 나오던 것** — 폴더 필터를 `file.folder ==` 로 씁니다. 예전 버전이 쓴 `.base` 는 다음
  pull 이 한 번 고쳐 씁니다(Obsidian 이 머리 주석을 지운 파일 포함).
- 양쪽에서 옮긴 노트의 `pull --dry-run` 이 실제 pull 과 다르던 것 · 하위 페이지만 옮긴 폴더 페이지를 dry-run 이 세던 것
- 옮긴 DB 폴더의 `.base` 를 볼트에서 고친 것으로 보고 옛 이름 `.base` 를 남기던 것

### 알려진 한계

- Notion 에서 옮긴 것은 다음 전체 대조(한 시간마다) 또는 `nobsi pull --force` 에 보입니다 — 옮겨도 Notion 의 수정 시각이 바뀌지
  않습니다.
- Notion 에서 DB 이름을 바꾸면 `.base` · 사이드카 이름은 따라가지만 폴더 이름은 그대로입니다.
- 행을 다른 DB 로 옮기면 그 DB 에 없는 열이 더해집니다(Notion 동작).
- 직접 만든 `.base`(머리 주석 · 보기 기록 없음)의 폴더 필터는 고치지 않습니다.

---

## Verification

- **Tests:** 4,695 passed on Linux (build, lint, format, typecheck), and the full suite on Windows in CI.
- **Real Notion API:** the table above (six regression scripts, vaults A and B).

---

## Upgrading

No configuration changes are required. Moves into or out of database folders that push used to refuse
are now sent to Notion — run `nobsi push --dry-run` first if you moved notes before upgrading. The first
pull after upgrading rewrites the folder filter of `.base` files written by earlier versions.

```bash
npm install -g im-nobsidian@0.14.0
npm install @im-nobsidian/core@0.14.0
```

**Obsidian plugin:** download `main.js`, `manifest.json` and `styles.css` from this release into
`<vault>/<config folder>/plugins/im-notion-sync/`, or update through BRAT.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
