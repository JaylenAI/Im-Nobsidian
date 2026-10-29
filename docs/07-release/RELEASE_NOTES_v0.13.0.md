# Im-Nobsidian v0.13.0 — Database Properties and Views, Both Ways

> **Release date:** 2026-10-29
> **Focus:** phases 3 and 4 of the full-sync plan. A database's properties and views now travel in both
> directions: renames made in Notion follow into row notes, and property and view edits made in the
> vault reach Notion.

---

## English

### ✨ Added

- **Database properties both ways**
  ([ADR-045](../02-architecture/adr/045-schema-bidirectional.md)).
  - A property renamed or deleted in Notion is followed by its property id: pull renames or removes the
    key in every row note. Before, the old key stayed and a new key was added next to it.
  - A property added in Notion, or one whose type changed, is pulled into rows even when the rows
    themselves did not change.
  - Renaming a key across a database's row notes and pushing renames the Notion property. Before, the
    new key was never sent and the old column kept its values.
  - In the sidecar (`<db>.notion.json`) of a database this vault pulled, you can add, delete, rename and
    retype properties and edit formulas, number formats and select options. Push applies them to Notion,
    and until then pull does not overwrite the edited sidecar. A sidecar brought from another vault still
    creates a new database (ADR-036).
- **`.base` view edits reach Notion**
  ([ADR-046](../02-architecture/adr/046-base-view-push.md)). Change a view's name, column order, hidden
  columns, sort or filter in Obsidian and push: the matching Notion view changes.
  - Filters are translated only when every condition has a Notion equivalent. If one does not, the filter
    is not sent at all, because sending part of it would pick different rows.
  - A view also edited in Notion in the meantime is refused and reported. So is a sort on created or
    edited time, which Notion does not accept.
  - Once everything is sent, the next pull rewrites the `.base`. Until then pull keeps the file and says
    so.

### 🐛 Fixed

- **New rows could not be created in a database with several data sources** (Notion answered 400). New
  rows go to the first source, and an edited row sends only its own source's properties.
- **A `.base` re-saved by Obsidian was treated as the user's own file.** Obsidian drops the header
  comment when a view is edited, after which pull never wrote that file again. A `.base` with a view
  record from pull is now recognised without the comment.
- **A push that only sent views or sidecar properties said `no changes`.** The summary line now counts
  database changes (`N DB changes`).
- **A changes-only pull did not find a database newly created directly under the root page.** Only
  `pull --force` did. When the root itself changed, pull now scans the root's children once.
- **Select options deleted, or formulas and rollups changed, in Notion left old values in the vault.**
  Notion changes the row values but not the rows' edit time, so pull skipped those rows. Pull now
  remembers a fingerprint of the option names, formula and rollup settings, and rewrites just that
  column when it changes. Deleting an option in use from a sidecar is announced by push, and by
  `--dry-run`, before Notion empties it. Found by the release regression run.

### 🧪 Verified against the real Notion API

A new test root, vault A pushing and a fresh vault B pulling, built from this release's code:

| Step                                                                                         | Result                                          |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 0.12 regression: formatting, attachments, long Korean title, database; both vaults push/pull | 10 created · 4 created · no changes · identical |
| 0.12 regression: read-only edit, D8, changes-only deletion, block deletion with `--rerender` | same as 0.12                                    |
| Property renamed in Notion (`Score` → `Points`) → changes-only pull in B and A               | 2 row notes re-keyed in each                    |
| B edits the `.base` view (name, columns, sort) → push                                        | `1 DB changes` · Notion view matches            |
| B adds a property in the sidecar → push                                                      | Notion has the new `rich_text` property         |
| Database created directly under the root in Notion → changes-only pull                       | created in both vaults                          |
| B deletes a select option in use from the sidecar; Notion changes a formula                  | dry-run warning · both vaults follow the values |
| Both vaults push and pull again                                                              | no changes                                      |

Views were edited in a real Obsidian (1.13.7) during development, which also covered board columns,
card filters (`containsAny`), conflicting edits and refused sorts.

### Known limitations

- **A Notion linked view's own name, filter and sort are not in the `.base`.** The linked view embeds
  the original database's `.base`.
- **Views added or deleted in the vault are not created or deleted in Notion.** Pull keeps that `.base`
  until it matches.
- Renaming a select option in the sidecar is a delete plus an add: rows with that value are emptied in
  Notion (push warns). Rename options in Notion instead.
- **`today()` filters:** Obsidian counts in the vault's local time, Notion in the workspace time zone.
  The two may differ by a day around midnight; this has not been measured.
- A `.base` pulled before 0.12 has no view record. If Obsidian has re-saved it, run `nobsi pull --force`
  once to get one.
- Rows that already differed because of an option or formula change before 0.13 are not compared
  (there is no earlier fingerprint). Run `nobsi pull --rerender` once to align them.
- Sidecar edits are refused for databases with several data sources.

---

## 한국어

### ✨ 더한 것

- **DB 속성을 양쪽에서 고칩니다(ADR-045).**
  - Notion 에서 바꾸거나 지운 속성을 pull 이 속성 id 로 따라가, 행 노트의 키 이름을 바꾸거나 키를 지웁니다.
  - Notion 에서 더한 속성과 타입을 바꾼 속성은 행이 그대로여도 받습니다.
  - 볼트에서 행 노트들의 키 이름을 바꿔 push 하면 Notion 속성 이름이 바뀝니다.
  - 이 볼트가 받아 온 DB 의 사이드카(`<db>.notion.json`)에서 다음을 고치면 push 가 Notion 에 올립니다.
    - 속성: 더하기 · 지우기 · 이름 · 타입
    - 설정: 수식 · 숫자 형식 · 선택 옵션
- **Obsidian 에서 고친 `.base` 보기를 Notion 보기에 올립니다(ADR-046).** 올리는 것은 이름 · 열 차례 · 숨긴 열 · 정렬 · 필터입니다.
  - 필터는 모든 조건을 Notion 으로 옮길 수 있을 때만 보냅니다.
  - 그 사이 Notion 에서도 고친 보기, 만든 · 고친 시각 정렬은 거절하고 알립니다.

### 🐛 고친 것

- 데이터 소스가 여럿인 DB 에 새 행을 만들지 못하던 것(400)
- Obsidian 이 다시 저장한 `.base` 를 사용자 파일로 보고 pull 이 다시 쓰지 않던 것
- 보기 · 사이드카만 올린 push 의 요약 줄이 `no changes` 이던 것 — 이제 `N DB changes`
- 증분 pull 이 루트 바로 아래 새 DB 를 찾지 못하던 것
- **Notion 에서 선택 옵션을 지우거나 수식 · 롤업을 바꾸면 볼트 행에 옛 값이 남던 것**
  - 원인: 행 수정 시각이 그대로라 pull 이 그 행을 받지 않았습니다.
  - 이제: pull 이 그 설정의 지문을 기억했다가, 바뀌면 그 열만 다시 씁니다.
  - 사이드카로 쓰는 옵션을 지우면 push(dry-run 포함)가 미리 알립니다.
  - 릴리스 전 회귀에서 찾았습니다.

### 알려진 한계

- Notion linked view 자체의 이름 · 필터 · 정렬은 `.base` 에 없습니다.
- 볼트에서 더하거나 지운 보기는 Notion 에 만들거나 지우지 않습니다.
- 사이드카에서 선택 옵션 이름을 바꾸면 지우고 새로 만드는 것이라, 그 값을 가진 행이 Notion 에서 빈 값이 됩니다(push 가 알림). 옵션
  이름은 Notion 에서 바꾸세요.
- `today()` 필터는 Obsidian 이 볼트 지역 시각, Notion 이 워크스페이스 시각대로 셉니다. 자정 근처에 하루 차이가 날 수 있는지 실측하지
  않았습니다.
- 0.12 이전에 받은 `.base` 를 Obsidian 이 다시 저장했으면 `nobsi pull --force` 를 한 번 하세요.
- 0.13 이전에 옵션 · 수식 변경으로 이미 갈라진 행은 견줄 지문이 없습니다. `nobsi pull --rerender` 를 한 번 하세요.
- 데이터 소스가 여럿인 DB 의 사이드카 편집은 거절합니다.

---

## Verification

- **Tests:** 4,652 passed on Linux (build, lint, format, typecheck), and the full suite on Windows in CI.
- **Real Notion API:** the table above (six regression scripts, vaults A and B).

---

## Upgrading

No configuration changes are required. Edits you make to row keys, sidecars and `.base` views are now
sent to Notion on push — run `nobsi push --dry-run` first if you edited them before upgrading.

```bash
npm install -g im-nobsidian@0.13.0
npm install @im-nobsidian/core@0.13.0
```

**Obsidian plugin:** download `main.js`, `manifest.json` and `styles.css` from this release into
`<vault>/<config folder>/plugins/im-notion-sync/`, or update through BRAT.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
