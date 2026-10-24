# Im-Nobsidian v0.9.0 — Databases on Push

> **Release date:** 2026-10-24
> **Focus:** Push now creates Notion databases. A database you pulled arrives in a new workspace
> with its schema, rows, relations, views, icon and cover, and a plain folder of notes can become a
> database too. One vault can hold several Notion connections. A first pull sends 42% fewer
> requests.
>
> **This release ships the v0.5–v0.9 scope at once.** Versions 0.5.0–0.8.0 were never published, so
> 0.4.1 upgrades straight to 0.9.0. The state DB keeps its schema, and the CLI and the plugin should
> still be upgraded together. See [Upgrading](#upgrading).

---

## English

### ✨ Added

- **Push creates Notion databases** ([ADR-036](../02-architecture/adr/036-push-creates-databases.md)).
  A database folder pushed to a new root used to arrive as plain pages, with the properties as
  YAML in the body. The sidecar (`<DB>.notion.json`, v2) now defines the schema:
  - 18 property types, option colours, number formats
  - relations (dual and single), rollups, formulas, status groups, places
  - views (table, board, list, gallery, calendar, timeline, form, chart) with their filters,
    sorts, groups, columns and quick filters
  - the database's icon, cover, description and title display

  Push always creates a new database and never writes to the one the sidecar came from.

- **Vault folders → Notion databases** ([ADR-037](../02-architecture/adr/037-vault-folder-to-database.md)).
  Run CLI `nobsi prepare-db <folder>`, or **Notion DB 로 올릴 준비** in the plugin's folder menu.
  It infers property types from frontmatter and Obsidian's property types, and views from the
  folder's `.base`. It writes the sidecar for you to review, and the next push creates the
  database. A folder with notes already in Notion is refused, because the API cannot move a page
  into a database.
- **Several Notion connections in one vault** ([ADR-038](../02-architecture/adr/038-connection-folders.md)).
  Each connection owns one vault folder and keeps its config and state in that folder's
  `.im-nobsidian/`. CLI: `cd Work && nobsi init`. Plugin: **폴더 연결 추가**. The outer connection
  never pushes or overwrites an inner connection's folder.
- **Icons and covers on pages and rows** go both ways through frontmatter `icon` and `cover`.
- **Column guides** (#74). Each Notion column gets a coloured left rule and a `열 2/3 · 40%` label in
  reading view and the editor. Column widths now survive a round trip.
- **Silent writes.** Syncing no longer notifies every person named in a person property. Set
  `sync.notifications: "default"` to get the old behaviour.
- **First pull: 42% fewer requests** (614 → 354 on the same subtree). The full-scan budget is now
  270 requests instead of 90 seconds, so sharing the rate limit no longer forces the search
  fallback.
- **Release gate.** A tag whose version differs from any of the package files, the manifest,
  `versions.json`, the release notes or the CHANGELOG publishes nothing.

### 🔴 Data safety

- **Backslashes vanished in Notion.** Notion drops `\` before a letter, so `C:\Users\me` became
  `C:Usersme`. They are now sent as `\\`. Text already sent that way stays as it is until the note
  is edited and pushed again.
- **Relations resolved to a same-titled row in another database.** Notion dropped those values
  without an error, and the next pull removed the link (91 of 1,510 relations in the E2E run).
  Relations are now looked up only among the target database's rows.
- **Rows beyond 10,000 looked deleted.** A single query stops at 10,000 rows (API 2026-04).
  Queries are now split by creation time.
- **Pull deleted or overwrote `.base` files you made yourself.** It now touches only the ones it
  wrote.

### 🐛 Fixed

- **Push**
  - New rows' relations never reached Notion when the target row did not exist yet. They were
    still recorded as sent.
  - Formulas, rollups and views went missing on created databases (view failures 28 → 0).
  - Person and file properties were empty after a copy to another root.
  - Link text containing brackets (`[a [b] c](url)`) broke the link.
  - Deep callouts and toggles inside a list moved up a level, and a callout inside a toggle in a
    list disappeared.
  - An aliased wikilink in a table cell (`[[note\|alias]]`) split the cell. The link was never
    resolved either.
  - Format characters inside an unresolved wikilink (`[[a _b_]]`) became Notion formatting and
    came back as a different link target.
  - Children of an empty list item (`-`, `1.`) fell out of the list.
  - A blocked integration's 429 (`public_api_request_blocked`, API 2026-09) was retried. It is now
    reported at once.
  - File property names over 100 characters failed the row.
- **Pull**
  - Sub-pages of database rows were skipped without a failure. They are now filed under the row's
    folder (`DB/row/`).
  - One whitespace-only line removed every blank line in a pulled note.
  - Attachments in a list came back indented by two spaces.
  - A page with only child pages became an empty `X/X.md` in a fresh vault. It is now a folder.
  - Image file names took the note title. They now keep the uploaded name.
  - Dates came back as `…T00:00:00.000Z` after relation links were rewritten.
  - Database views edited in Notion never reached the vault.
  - One `page` view made a database lose all its views.
  - Uncomputed formula and rollup values were written as `{}`.
  - Attachment names grew a hash on every copy (`x-<hash>-<hash>.png`).
- **Plugin**
  - It would have failed to start on Notion SDK 5.27+, which refuses tokens in a browser
    environment.

### ⚠️ Known limitations

See [Known Limitations](../../README.md#known-limitations). New in this release's list:

- **Formulas over related pages** and rollups of rollups cannot be created through the API. Push
  prints them so you can paste them in Notion. Button properties cannot be created either.
- **Relations to pages outside the target database** are not sent.
- **Guests in person properties** are not sent, because the API's user list has no guests.
- **External files in a file property** come back as their URL, not their display name.
- **Loose lists** (blank lines between items, including inside a callout) become tight after one
  round trip. Notion does not store the difference.
- **Attachments over `advanced.maxFileSizeBytes`** (100 MB) are not downloaded. The note keeps
  Notion's signed URL, which expires after about an hour.

---

## 한국어

### ✨ 추가

- **push 가 Notion DB 를 만듭니다**(ADR-036). 받은 DB 를 새 루트로 올리면 스키마 · 행 · relation · 롤업 · 수식 · 보기 ·
  아이콘 · 커버가 그대로 생깁니다. 사이드카가 가리키는 원래 DB 에는 쓰지 않습니다.
- **볼트 폴더 → Notion DB**(ADR-037). `nobsi prepare-db <폴더>` 또는 플러그인 폴더 메뉴 「Notion DB 로 올릴 준비」.
- **볼트 하나에 Notion 연결 여럿**(ADR-038). 연결마다 볼트 폴더 하나를 맡습니다.
- 페이지 · 행의 **아이콘 · 커버** 왕복, **컬럼 열 경계 표시**(#74)
- **알림 없는 쓰기**. 예전처럼 알리려면 `sync.notifications: "default"`.
- **첫 pull 요청 −42%**
- **릴리스 게이트**

### 🔴 데이터 안전

- 글 백슬래시가 Notion 에서 사라지던 것(`C:\Users\me` → `C:Usersme`)
- relation 이 다른 DB 의 같은 이름 행으로 풀리던 것(E2E 1,510 가운데 91)
- 10,000건 넘는 DB 의 나머지 행이 «없는 행» 이 되던 것
- 볼트에서 만든 `.base` 를 pull 이 지우거나 덮어쓰던 것

### 🐛 수정

- **올리기**
  - 새 행의 relation 이 가리키는 행이 아직 없을 때 보내지 않고 보낸 것으로 적던 것
  - 만든 DB 에 수식 · 롤업 · 보기가 빠지던 것
  - 다른 루트로 옮긴 행의 사람 · 파일 속성이 비던 것
  - 링크 글자 속 대괄호에서 링크가 끊기던 것
  - 목록 속 깊은 콜아웃 · 토글이 한 단계 올라가던 것
  - 표 칸의 별칭 위키링크가 칸을 가르던 것
  - 볼트에 없는 노트를 가리키는 위키링크 안의 서식 글자
  - 빈 목록 항목의 자식이 항목 밖으로 떨어지던 것
  - 막힌 연결의 429 를 다시 시도하던 것
- **받기**
  - DB 행의 하위 페이지가 빠지던 것
  - 공백만 든 줄 하나 때문에 빈 줄이 모두 사라지던 것
  - 목록 속 첨부의 들여쓰기
  - 자식만 있는 페이지가 빈 노트가 되던 것
  - 이미지 이름 · 날짜 표기 · 보기 갱신 · `page` 보기 · `{}` 값 · 첨부 이름 해시
- **플러그인** — SDK 5.27+ 에서 시작하지 못할 것

### ⚠️ 알려진 제한

[README 알려진 제한사항](../../README.ko.md#알려진-제한사항) 참고. 이번에 더한 것:

- 관계 페이지 값을 계산하는 수식 · 롤업의 롤업 · 버튼 속성은 API 로 만들 수 없음
- 대상 DB 밖 relation · 사람 속성의 손님은 보내지 않음
- 파일 속성의 외부 파일은 주소로 받음
- 느슨한 목록은 한 번 왕복하면 촘촘한 목록이 됨(Notion 이 구분하지 않음)
- 100MB 넘는 첨부는 내려받지 않고 약 1시간 뒤 만료되는 Notion 주소를 남김

---

## Verification

- **Tests:** 4,336 passed (build, lint, format, typecheck). Every fix began with a test that
  failed before it.
- **Database creation E2E:** a full workspace pushed to a new root created 164 databases and 1,221
  rows, then was pulled back into an empty vault.
- **Release-candidate E2E** (1,225 notes): pulled the real workspace into an empty vault, pushed
  that copy to a new root and pulled the new root back. The originals were only read. Six defects
  were found and fixed.
- **Re-round-trip** (172 notes): pushed again and pulled into an empty vault, then compared with
  the vault that pushed. Six more defects were found and fixed. After the fixes, a fresh pull of
  the same pages with the new build matched 163 of 172 notes. The other 9 differ only in the
  signed URLs of videos between 253 MB and 1.48 GB.
- **Live probes** checked each Notion behaviour the fixes rely on: empty list items, escapes inside
  wikilinks, `\|` in tables, and lists inside quotes. All probe pages were moved to the trash
  afterwards.
- **Notion API changelog** checked again on 2026-10-24. The 2026-09 blocked-429 change is handled
  in this release. Nothing newer affects the sync.

---

## Upgrading

**Coming from 0.4.1**

- Upgrade the CLI and the plugin together.
- The state DB keeps its schema. Nothing migrates.
- Sync writes are silent now. Set `sync.notifications: "default"` to notify people as before.
- **A database pulled before this release** has a v1 sidecar. Push still creates a database from
  it, but only from option names. Formulas, relations and rollups are reported, so pull it again
  (`nobsi pull --force`) before pushing it to a new root.
- Run `nobsi pull --force` once to fill `icon` and `cover` into notes you already have.

**Coming from 0.3.x:** read [v0.4.0 → Upgrading](RELEASE_NOTES_v0.4.0.md#upgrading) first.

Requires **Node.js 22.13+** and **Obsidian 1.12.4+**.

```bash
# CLI
npm install -g im-nobsidian@0.9.0

# Core (library)
npm install @im-nobsidian/core@0.9.0
```

**Obsidian plugin:**

1. Download `main.js`, `manifest.json` and `styles.css` from this release.
2. Put them in `<vault>/<config folder>/plugins/im-notion-sync/`.
3. Enable **Im-Notion Sync** under Settings → Community plugins.

BRAT installs the same three files.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
