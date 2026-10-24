# Im-Nobsidian v0.10.0 — Follow Pages Moved in Notion

> **Release date:** 2026-10-25
> **Focus:** a page you move to another parent in Notion now moves in your vault too. Before, the note
> stayed in its old folder forever, because moving a page in Notion does not change its edit time.

---

## English

### ✨ Added

- **Pull follows pages moved in Notion** ([ADR-039](../02-architecture/adr/039-follow-remote-moves.md)).
  The full scan compares each page's parent with the one recorded at the last sync and moves the note
  into the new parent's folder:
  - a note moves alone, or together with its child folder (`X.md` and `X/`)
  - a folder note (`X/X.md`) or a folder page moves as a whole folder
  - the file name stays the same, so `[[links]]` from other notes keep working
- A move is **left alone, with the reason printed**, when:
  - the target name is already taken
  - the note was moved in the vault and that move has not been pushed yet (the vault wins: the next push
    moves the Notion page)
  - the new parent is not in the vault, or the target is excluded from sync
  - the folder holds a database (its `.base` view filters by folder path) or another connection folder
- CLI: each move is printed as `from → to (moved)`, the summary counts it, and `--json` reports `moved`
  and `moveSkipped`. `--dry-run` shows what would move. The plugin's notice shows `이동 N`.

### 🧪 Verified against the real Notion API

Three pages moved in Notion with `pages.move` (a note to another folder, a folder note with its child,
a note to the root page), then `pull`:

| Step                 | 0.9.2 (last run)           | 0.10.0 CLI                    | 0.10.0 plugin (Obsidian 1.12.4) |
| -------------------- | -------------------------- | ----------------------------- | ------------------------------- |
| pull after the moves | no changes, notes stay put | 3 moved, vault matches Notion | notice `이동 3`, same tree      |
| pull --force again   | —                          | no changes (`churn` 0)        | no changes                      |
| push / status after  | —                          | nothing to push, all synced   | nothing to push                 |

### Known limitations

- A page that was only moved (not edited) is followed by the **full scan** — once an hour by default,
  or `pull --force`. `status` does not run a full scan, so it does not show these moves.
- Renaming a page in Notion still does not rename the note file; the new title goes into frontmatter
  `title:`.
- Database rows are not moved (the API cannot move a page into a database), and folders that hold a
  database are not followed.

---

## 한국어

### ✨ 더한 것

- **Notion 에서 옮긴 페이지를 볼트에서도 옮깁니다** — 예전에는 Notion 에서 옮겨도 수정 시각이 바뀌지 않아 노트가 옛 폴더에
  남았습니다. 전체 대조가 페이지의 부모를 지난 동기화 때의 부모와 견주어 새 부모의 폴더로 옮깁니다. 노트는 혼자 또는 옆의
  자식 폴더와 함께, 폴더 노트와 폴더 페이지는 폴더째 옮깁니다. 이름은 그대로라 다른 노트의 `[[링크]]` 는 끊기지 않습니다.
- 옮길 자리에 같은 이름이 있거나, 볼트에서 옮긴 것을 아직 올리지 않았거나(볼트가 먼저 — 다음 push 가 Notion 을 옮깁니다),
  새 부모가 볼트에 없거나, 폴더에 DB 나 다른 연결이 있으면 **옮기지 않고 까닭을 보입니다**.
- CLI 는 `from → to (moved)` 줄과 요약의 `N moved`, `--json` 의 `moved` · `moveSkipped` 를 냅니다. `--dry-run` 은 옮길 것만
  보입니다. 플러그인은 알림에 「이동 N」 을 보입니다.

### 알려진 한계

- 옮기기만 하고 고치지 않은 페이지는 **전체 대조**(기본 한 시간에 한 번 · `pull --force`)에서 따라갑니다. `status` 는 전체
  대조를 하지 않아 이 이동을 보이지 않습니다.
- Notion 에서 제목을 바꿔도 노트 파일 이름은 그대로입니다(frontmatter `title:` 로 받습니다).
- DB 행은 옮기지 않습니다(API 가 DB 안으로 옮기지 못합니다). DB 를 품은 폴더도 따라가지 않습니다.

---

## Verification

- **Tests:** 4,386 passed on Linux (build, lint, format, typecheck), and the full suite on Windows in CI.
- **Real Notion API:** the table above, on probe pages under a test root, with the CLI and with the plugin
  in an isolated Obsidian 1.12.4.

---

## Upgrading

No configuration changes. The first full scan after upgrading moves notes whose pages were moved in
Notion earlier. Run `nobsi pull --force --dry-run` first to see what would move.

```bash
npm install -g im-nobsidian@0.10.0
npm install @im-nobsidian/core@0.10.0
```

**Obsidian plugin:** download `main.js`, `manifest.json` and `styles.css` from this release into
`<vault>/<config folder>/plugins/im-notion-sync/`, or update through BRAT.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
