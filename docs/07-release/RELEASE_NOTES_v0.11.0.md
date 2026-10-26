# Im-Nobsidian v0.11.0 — Path Filters in the Plugin, Renames and Folder Moves from Notion

> **Release date:** 2026-10-26
> **Focus:** the plugin now honours `include` / `exclude` patterns, a title changed in Notion can rename
> the note (with its links), `status` shows what the next pull will move, and folders holding databases
> follow moves in either direction.

---

## English

### ✨ Added

- **The plugin applies path patterns.** Before, the plugin ignored `paths.include`, `paths.exclude` and
  `.im-nobsidian-ignore` and pushed every note in the vault. **Settings → 동기화 범위** now takes include and
  exclude patterns, one per line, for the vault connection and each folder connection, and the plugin
  reads `.im-nobsidian-ignore`. The rules are the same as the CLI's. Excluding a synced note does not
  delete its Notion page.
- **Rename notes when the title changes in Notion** (`sync.renameOnTitleChange`, off by default,
  [ADR-040](../02-architecture/adr/040-rename-on-title-change.md)). When on, pull renames the file, along
  with its child folder, a folder note's folder, or a database row's sub-page folder. When off, the new
  title goes into frontmatter `title:` as before. Plugin: **Settings → Notion 에서 바꾼 제목으로 이름 바꾸기**.
- **Links follow notes that sync moved or renamed.** Links written as a path (`[[A/c]]`,
  `[x](A/c.md)`) used to break after a move from Notion. Sync moves files without Obsidian's "update
  links" hook, so it now rewrites links itself:
  - wiki links, embeds and markdown links, each kept in its original style (name, path or relative)
  - code blocks are left alone
  - a synced note's snapshot is updated, so the next push does not upload the link fix again

  The CLI prints `links updated in N notes` (JSON `relinked`); the plugin notice shows `링크 고침 N`.

### 🔁 Changed

- **`status --full` shows what the next pull will move or rename.** Moves and renames from Notion are not
  in the remote change list, so you could not see them before pulling. They are now listed under
  `Moved in Notion (next pull)` as `(will move)`, `(will rename)` or `(won't move: reason)`. In the
  plugin, a refresh that checks Notion shows them in a notice.
- **Folders that hold databases follow moves from Notion**
  ([ADR-041](../02-architecture/adr/041-follow-db-folder-moves.md)). The pull rewrites:
  - the found database's folder
  - the recorded `.base` path
  - the `file.inFolder("…")` filter in the `.base` files sync generated

  Your own `.base` files are left alone. A folder that holds a database listed in `notion.databases`, or
  another connection folder, is still not moved, and the reason is printed.

### 🐛 Fixed

- **Moving a database folder in the vault left its `.base` view empty.** Only the found database's folder
  was updated. Since only changed databases are queried (ADR-027), an unchanged database's `.base` kept
  filtering the old folder, and inline-database embeds kept the old path. The view and the recorded path
  now follow the move.
- **New Notion pages under an excluded path were pulled.** A page created in Notion under an excluded
  folder, or outside the include patterns, was written into the vault. That note was then outside the
  sync list and never pushed back. These pages are now skipped and listed: CLI `pull` and
  `status --full` (JSON `excluded`), plugin notice `받지 않음 N`.

### 🧪 Verified against the real Notion API

Probe pages under a test root, with the CLI and with the plugin in an isolated Obsidian 1.12.4:

| Step                                                              | CLI                                                                        | Plugin                                                          |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------- |
| push with `exclude: ["Private/**", "B/Secret*"]`                  | excluded notes not pushed                                                  | 4 created, `Private/s.md` not pushed                            |
| new page under an excluded path in Notion                         | not pulled, listed (`1 new in Notion not pulled`)                          | notice `받지 않음 1(동기화 범위 밖)`                            |
| title changed + folder with a database moved in Notion → `status` | `→ A → B/b/A (will move)`, `(will rename)`                                 | notice `옮긴 노트 1 · 제목을 바꾼 노트 1`                       |
| pull                                                              | folder, rows and `.base` moved, `file.inFolder("B/b/A/Tasks-DB")`, 2 links | `이동 1 / 이름 변경 1 / 링크 고침 2`; `.base` view shows 2 rows |
| row renamed in Notion → pull                                      | `Row one.md → Row first.md (renamed)`, link updated                        | —                                                               |
| database folder moved in the vault → push                         | `.base` filter and recorded paths point to the new folder                  | —                                                               |
| pull --force / push --dry-run afterwards                          | no changes                                                                 | no changes                                                      |

### Known limitations

- Notion's `last_edited_time` has minute precision. An edit made **with the same integration token** in
  the same minute as a sync is treated as the sync's own write. Edits by people are not affected, because
  the editor changes.
- `status` lists page renames, but not database row renames; pull still renames the rows.
- A page that was only moved (not edited) is followed by the full scan, once an hour by default or with
  `pull --force`.
- Moving a database itself to another page in Notion is not followed.

---

## 한국어

### ✨ 더한 것

- **플러그인이 경로 패턴을 적용합니다** — 예전 플러그인은 `paths.include` · `paths.exclude` · `.im-nobsidian-ignore` 를 무시하고
  모든 노트를 올렸습니다. 설정의 「동기화 범위」 에 포함 · 제외 패턴을 한 줄에 하나 적습니다(볼트 연결 · 폴더 연결마다). 규칙은
  CLI 와 같습니다. 동기화하던 노트를 빼도 Notion 페이지는 지우지 않습니다.
- **Notion 에서 바꾼 제목으로 노트 이름 바꾸기(`sync.renameOnTitleChange`, 기본 꺼짐 · ADR-040)** — 켜면 pull 이 파일
  이름(자식 폴더 · 폴더 노트의 폴더 · DB 행의 하위 페이지 폴더도)을 바꿉니다. 끄면 예전처럼 frontmatter `title:` 로 받습니다.
- **동기화가 옮기거나 이름을 바꾼 노트를 가리키던 링크를 고칩니다**:
  - 위키링크 · 임베드 · 마크다운 링크를 원래 꼴(이름 · 경로 · 상대 경로) 그대로 고칩니다
  - 코드 안은 둡니다
  - 동기화된 노트는 다음 push 가 다시 올리지 않습니다

### 🔁 바꾼 것

- **`status --full` 이 다음 pull 이 옮기거나 이름을 바꿀 노트를 보입니다** — 플러그인은 원격까지 본 새로고침 뒤 알림으로
  알립니다.
- **DB 가 든 폴더도 Notion 에서 옮기면 따라갑니다(ADR-041)** — 새 자리로 함께 고치는 것:
  - 발견한 DB 의 폴더
  - 기록한 `.base` 경로
  - 동기화가 만든 `.base` 의 폴더 필터

  설정 파일로 정한 DB(`notion.databases`)나 다른 연결이 든 폴더는 옮기지 않고 까닭을 보입니다.

### 🐛 고친 것

- **볼트에서 DB 폴더를 옮기면 `.base` 보기가 빈 표가 되던 것** — 바뀐 DB 만 조회하므로 그대로인 DB 의 `.base` 가 옛 폴더를
  걸렀습니다. 보기와 기록한 경로를 새 자리로 고칩니다.
- **뺀 자리에 놓일 Notion 의 새 페이지를 받던 것** — 받지 않고 경로를 알립니다(CLI `pull` · `status --full`, 플러그인
  「받지 않음 N」).

### 알려진 한계

- Notion 의 수정 시각은 분 단위입니다. **같은 통합 토큰**으로 동기화와 같은 분에 고친 것은 동기화가 쓴 것으로 봅니다(사람의
  편집은 편집자가 바뀌어 보입니다).
- `status` 는 페이지 이름 바꾸기는 보이지만 DB 행의 이름 바꾸기는 보이지 않습니다(pull 은 바꿉니다).
- Notion 에서 DB 자체를 다른 페이지로 옮긴 것은 따라가지 않습니다.

---

## Verification

- **Tests:** 4,430 passed on Linux (build, lint, format, typecheck), and the full suite on Windows in CI.
- **Real Notion API:** the table above.

---

## Upgrading

No configuration changes are required. Two behaviour changes to check:

- **Plugin users:** an `.im-nobsidian-ignore` file at the top of the vault (or of a connection folder) is
  now honoured, so the notes it lists stop being pushed. Their Notion pages stay.
- **`sync.renameOnTitleChange`** is off by default; turn it on to rename files.

```bash
npm install -g im-nobsidian@0.11.0
npm install @im-nobsidian/core@0.11.0
```

**Obsidian plugin:** download `main.js`, `manifest.json` and `styles.css` from this release into
`<vault>/<config folder>/plugins/im-notion-sync/`, or update through BRAT.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
