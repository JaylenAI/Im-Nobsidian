# Im-Nobsidian v0.12.0 — Nothing Lost Quietly, Deletions Seen on Every Pull

> **Release date:** 2026-10-28
> **Focus:** the first three phases of the full-sync plan. Notion HTML blocks round-trip, long titles
> and edited `.base` files no longer break or vanish, read-only property edits are reported and undone,
> and a changes-only pull now notices pages deleted in Notion.

---

## English

### ✨ Added

- **Notion HTML blocks ↔ `.html` attachments**
  ([ADR-043](../02-architecture/adr/043-html-block.md)). Pull used to leave only a signed link that
  stopped working after an hour. It now downloads the file as an `.html` attachment (`![[…html]]`), and
  push uploads a vault `.html` attachment as an HTML block. Pushing again keeps the same block.
- **`nobsi verify` reports nested folder pages** left by old v0.3.x / v0.4 development builds
  (`F/F.md` next to `F/F (id).md`). It reads only the local state, prints both paths and how to clean
  up, and changes nothing (`--json` `nestedFolderPages`).

### 🔁 Changed

- **Notion deletions are noticed by every pull**
  ([ADR-044](../02-architecture/adr/044-incremental-deletion-sweep.md)). Notion's search skips trashed
  pages, so only the hourly full scan used to see them. Each pull now asks Notion about 15 tracked pages
  and rows in turn (all of them in a small vault). Deleting a page in Notion removes the notes under it
  in the same pull. Trashed rows of a filtered database are removed too.
- `@notionhq/client` 5.23 → 5.28. Trash checks use `in_trash` in one place.
- A workspace-wide rate limit (429) is waited out for up to 5 minutes; a Free-plan block limit (403)
  is reported with Notion's reason ([ADR-042](../02-architecture/adr/042-workspace-request-limits.md)).
- **New file-name rule:** names are cut at 200 UTF-8 bytes (notes) or 255 bytes (attachments,
  database folders), and `#` `^` in a title become `_`. Notes already in your vault keep their names.

### 🐛 Fixed

- **Long Korean (or other multi-byte) titles could not be pulled** (`ENAMETOOLONG`).
- **`#` and `^` in a title made links to that note point somewhere else** (`[[C# notes]]` is a heading
  link).
- **Coloured and toggle headings showed marker text in Obsidian's outline and heading links.** The
  marker now sits on the line below the heading; the plugin still colours the heading.
- **Read-only properties edited in the vault (formula, rollup, ID) silently stayed different from
  Notion.** Push now warns (CLI summary, `--json` `readOnlySkipped`, plugin notice, also with
  `--dry-run`), and the next pull restores Notion's value — even when nothing else in that database
  changed.
- **An edited `.base` file was overwritten by the next pull.** Pull remembers what it wrote and leaves a
  file you changed alone, with a warning. Delete the file to get Notion's views again.
- **Files over the size limit (100 MB) became dead links after an hour.** A permanent
  `↗ Notion 에서 열기 · N MB` link to the page (or block) is added next to them.
- **Renaming a note wiped the bold, colour and links in the Notion page title.** Only the changed text
  is sent.
- **With `sync.deleteSync` off, a note deleted in the vault came back on the next pull without a
  word.** Push lists the notes it did not delete in Notion, and pull lists the notes it restored
  (D8).
- **A folder page deleted in Notion left an empty folder in the vault.** The pull removes it once it is
  completely empty (the plugin uses Obsidian's trash).
- **A paragraph deleted in Notion left a hidden wikilink marker line**, and deleting a block while
  editing its neighbour added a blank line.

### 🧪 Verified against the real Notion API

A new test root, vault A pushing and a fresh vault B pulling, built from this release's code:

| Step                                                                                            | Result                                                              |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| A pushes formatting, lists, callout, table, code, math, image, text and `.html` attachments     | 4 created                                                           |
| Notion adds a 102-character Korean title, `C# 노트 ^1` with a red heading, a database (formula) | —                                                                   |
| B pulls; B pushes right after; A pulls; A pushes right after                                    | 10 created · no changes · 4 created · no changes                    |
| Note bodies A vs B                                                                              | identical                                                           |
| File names in B                                                                                 | `긴제목…` at 201 bytes · `C_ 노트 _1.md` · marker below the heading |
| A edits only the formula and pushes, then a changes-only pull                                   | warning; value back to 42                                           |
| A deletes a note with `deleteSync` off → push → pull                                            | "not deleted in Notion" · "restored" · file back                    |
| Page trashed and another edited in Notion → B changes-only pull                                 | 1 deleted · 1 updated                                               |
| Both vaults pull and push again; `verify`                                                       | no changes · all remote pages present                               |

The plugin was checked during development in an isolated Obsidian (pull, deleted folder page
removed in one pull).

### Known limitations

- **A block deleted alone in Notion is not seen.** Deleting a block does not change the page's edit
  time (measured through the API), so neither the changes-only pull nor the full scan notices it. The
  note catches up when the page is next edited, or now with `nobsi pull --rerender`.
- A large vault catches up with Notion deletions over several pulls (15 pages per pull), or at once with
  `nobsi pull --force`.
- Marker lines and extra blank lines that older versions already wrote are not cleaned up.
- A push that only changed read-only properties still counts the note as `updated`, though nothing is
  sent.
- Edits made **with the same integration token** in the same minute as a sync are taken as the sync's
  own write.

---

## 한국어

### ✨ 더한 것

- **Notion HTML 블록 ↔ 볼트 `.html` 첨부(ADR-043)** — 예전 pull 은 한 시간 뒤 끊기는 링크만 남겼습니다. 이제 `.html`
  첨부로 받아 `![[…html]]` 로 두고, push 는 볼트의 `.html` 첨부를 HTML 블록으로 올립니다. 다시 올려도 같은 블록입니다.
- **`nobsi verify` 가 예전 개발 빌드의 두 겹 폴더 페이지(`F/F.md` 옆 `F/F (id).md`)를 알립니다** — 고치지는 않습니다.

### 🔁 바꾼 것

- **pull 마다 Notion 삭제를 확인합니다(ADR-044)** — 검색이 휴지통을 돌려주지 않아 예전에는 한 시간마다의 전체 대조만
  알았습니다. 이제 pull 마다 추적 중인 페이지 · 행을 15개씩 차례로 Notion 에 묻습니다(작은 볼트는 모두). 지운 페이지 아래
  노트도 같은 pull 이 지우고, 필터 DB 의 휴지통 행도 지웁니다.
- `@notionhq/client` 5.23 → 5.28 · 워크스페이스 공용 rate limit 은 5분까지 기다리고, 블록 한도(403)는 Notion 의 사유로
  알립니다(ADR-042).
- **새 파일 이름 규칙** — 노트는 UTF-8 200 바이트, 첨부 · DB 폴더는 255 바이트에서 자르고 제목의 `#` `^` 는 `_` 로
  바꿉니다. 이미 볼트에 있는 노트의 이름은 그대로입니다.

### 🐛 고친 것

- 긴 한글 제목을 받지 못하던 것(`ENAMETOOLONG`) · 제목의 `#` `^` 로 링크가 다른 곳을 가리키던 것
- 색 · 토글 제목이 Obsidian 개요 · 제목 링크에 마커 글자로 보이던 것 — 마커를 제목 아래 줄로
- **볼트에서 고친 읽기 전용 속성(수식 · 롤업 · ID)이 말없이 Notion 과 달랐던 것** — push(dry-run 포함)가 알리고 다음 pull 이
  Notion 값으로 되돌립니다. 그 DB 의 다른 것이 그대로여도 되돌립니다
- 고친 `.base` 를 다음 pull 이 덮던 것 · 상한(100MB)을 넘은 파일이 한 시간 뒤 열리지 않던 것(끊기지 않는 Notion 링크를 붙임)
- 노트 이름을 바꾸면 Notion 제목의 굵게 · 색 · 링크가 지워지던 것
- **`deleteSync` 가 꺼진 볼트에서 지운 노트가 말없이 돌아오던 것** — push 는 지우지 않은 노트를, pull 은 되살린 노트를
  경로로 알립니다(D8)
- Notion 에서 지운 폴더 페이지의 빈 폴더가 남던 것 · 지운 문단의 숨은 위키링크 마커 줄 · 지운 블록 옆을 고치면 늘던 빈 줄

### 알려진 한계

- **Notion 에서 블록만 지운 것은 보이지 않습니다** — 블록을 지워도 페이지 수정 시각이 바뀌지 않습니다(API 실측). 그 페이지를
  다시 고칠 때 함께 받고, 지금 받으려면 `nobsi pull --rerender`.
- 큰 볼트는 Notion 삭제를 몇 번의 pull 에 걸쳐(한 번에 15개) 따라잡습니다 — 한 번에는 `nobsi pull --force`.
- 예전 버전이 이미 쓴 마커 줄 · 빈 줄은 지우지 않습니다.
- 읽기 전용 속성만 고친 push 는 보낸 것이 없어도 `updated` 로 셉니다.

---

## Verification

- **Tests:** 4,528 passed on Linux (build, lint, format, typecheck), and the full suite on Windows in CI.
- **Real Notion API:** the table above.

---

## Upgrading

No configuration changes are required. Notes pulled before keep their file names; only new notes follow
the byte-based name rule.

```bash
npm install -g im-nobsidian@0.12.0
npm install @im-nobsidian/core@0.12.0
```

**Obsidian plugin:** download `main.js`, `manifest.json` and `styles.css` from this release into
`<vault>/<config folder>/plugins/im-notion-sync/`, or update through BRAT.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
