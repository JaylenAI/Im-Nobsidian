# Im-Nobsidian v0.4.0 — Incremental Sync & Data Safety

> **Release date:** 2026-10-21
> **Focus:** Sync like Obsidian Git — see only what changed, and push, pull or discard one note at
> a time. Underneath, the 23 defects a 2026-09-27 deep QA found (data loss, duplicate pages,
> missed changes) and everything found after them are sealed, block-mode pull and push now go
> through the same NFM converter as the Markdown API, and the plugin installs from three files.
> Checked end to end on a copy of a real 3,235-file vault: a full pull created 367 notes and
> updated 150 with no failures, repeat pulls changed nothing, and every push dry-run was empty.
>
> **Minor release — the contract changed.** The CLI and the plugin must be upgraded together,
> the plugin needs Obsidian 1.12.4+, and the token moves to the Obsidian keychain. Read
> [Upgrading](#upgrading) before you update.

---

## English

### ✨ Added

- **Per-note push · pull · discard in the changes panel**, with a line diff for each change.
  The CLI gains `nobsi discard`.
- **Incremental pull with a periodic full reconcile (ADR-027).** Pull queries only databases that
  changed; remote deletions are reconciled every `sync.fullReconcileInterval` (default 3600 s).
  "Pull from Notion (전체 확인)" / `pull --force` reconciles now.
- **`pull --rerender`** — redraw already-pulled notes with the current converter, without waiting
  for the page to change in Notion. Notes you edited locally are left alone.
- **`--json` output** for `pull`, `push` and `sync`.
- **Design-marker renderer** — Notion text colour, underline, mentions, block colour and table
  properties carried as markers are now painted in reading and editing views.
- **Token in the Obsidian keychain**, a **time-zone setting** for date-times, **user names** in
  user mentions, renames · folder moves · database rows in the change list and progress, and an
  end-date column for date ranges in `.base` views.

### 🔁 Changed

- **Remote changes are judged by edit time, editor and body fingerprint (ADR-017)** — Notion's
  edit time is minute-granular, so an edit inside the same minute was never pulled and the next
  push overwrote it. A push to a note whose remote body changed is now refused.
- **One sync at a time (ADR-024)**, and **one tool per state DB (ADR-026)** — overlapping manual,
  automatic and watch syncs, or the CLI and the plugin writing the same state DB, overwrote each
  other's records.
- **Block-mode pull and push use the NFM converter (ADR-034 · ADR-035)** — notes pulled through the
  block API lost toggles, callout children, colours, tables and column ratios, and pushing them
  deleted those blocks in Notion.
- **Row properties in Obsidian's shape (F-08)** — wall-clock date-times, `<name>_end` for ranges,
  and only changed text is patched so formatting, links and mentions survive.
- **Plugin distribution (ADR-031 · ADR-032)** — the SQLite engine ships inside `main.js`; the
  manifest lives at the repository root.

### 🐛 Fixed (highlights)

- **Data loss:** a new Notion row overwrote an unpushed local file of the same name; a second
  "duplicate" conflict resolution overwrote the first copy; an unreadable `db-views.json` wiped
  other databases' view settings; an unreadable or truncated state DB was opened as empty;
  edits were lost when an edit and a deletion crossed.
- **Duplicates and misses:** ambiguous failures re-sent writes and created pages twice; incremental
  pull missed changes forever; same-minute remote edits were overwritten; a transient parent lookup
  error pulled a note to the vault root.
- **Things that silently did nothing:** renames and moves never reached Notion; the body of a page
  with child pages was never pushed; conflict resolutions in the plugin never reached Notion;
  database row properties ended up as YAML in the body.
- **Conversion fidelity:** code inside lists, callouts and quotes; `$` and `$$`; tables with cell
  properties and `\|`; comments; bookmarks; mentions; underlines; empty blocks; code-fence
  languages (Dataview queries no longer become JavaScript).
- **Media:** uploaded media are identified by Notion's stored file id, not the caption; unchanged
  media are not re-uploaded; PDFs, videos and audio upload as their own block types.
- **Found by the real-vault E2E:** embeds with a caption stayed as raw `<embed>` tags; text inside
  tab blocks showed as code blocks; `pull --rerender` kept those broken lines from earlier pulls.
- **Plugin and CLI:** a Notion page URL in the root-page field; buttons the sync direction blocks;
  failure reasons that disappeared; `watch` arguments that were not numbers.

The full list, with defect IDs, is in the [changelog](../06-devlog/CHANGELOG.md).

### ⚠️ Known limitations

See [Known Limitations](../../README.md#known-limitations). New in this release's list: bot
mentions are not exported by the Markdown API; callout aliases and fold state have no place in
Notion; a block-colour marker on a heading shows in Obsidian's outline; a `|` inside table-cell
code shows its backslash in Obsidian.

---

## 한국어

### ✨ 추가

- **변경 패널에서 노트마다 올리기 · 받기 · 되돌리기**와 변경마다 줄 비교. CLI 에 `nobsi discard`.
- **바뀐 것만 받는 pull 과 주기 전체 대조 (ADR-027)** — 바뀐 DB 만 조회하고, 원격 삭제는
  `sync.fullReconcileInterval`(기본 3600초)마다 대조한다. 「Pull from Notion (전체 확인)」 · `pull --force` 는 지금 대조한다.
- **`pull --rerender`** — 받아 둔 노트를 지금 변환기로 다시 그린다. 볼트에서 고친 노트는 건드리지 않는다.
- **`pull` · `push` · `sync` 의 `--json` 출력**.
- **디자인 마커 렌더러** — 마커로 실은 글자색 · 밑줄 · 멘션 · 블록 색 · 표 속성을 읽기 · 편집 화면에서 칠한다.
- **토큰 키체인 보관 · 날짜시각 시간대 설정 · 사용자 멘션의 이름** · 변경 목록의 옮김 · 폴더 이동 · DB 행 · `.base` 기간 끝 열.

### 🔁 바뀜

- **원격 변경을 수정 시각 · 편집자 · 본문 지문으로 판정 (ADR-017)** — 같은 분 안의 Notion 편집을 받지 못하고 다음 push 가
  덮었다. 원격 본문이 바뀐 노트의 push 는 거절한다.
- **동기화는 한 번에 하나 (ADR-024) · 상태 DB 는 한 도구만 (ADR-026)** — 겹친 sync, CLI 와 플러그인이 서로의 기록을 덮었다.
- **블록 방식 받기 · 올리기를 NFM 변환 경로로 (ADR-034 · ADR-035)** — 블록 API 로 받은 노트가 토글 · 콜아웃 자식 · 색 · 표를
  잃고, 그 노트를 push 하면 Notion 에서 그 블록이 지워졌다.
- **행 속성을 Obsidian 모양으로 (F-08)** · **플러그인 배포 파일 세 개 (ADR-031 · ADR-032)**.

### 🐛 수정 (요점)

- **데이터 손실:** 새 Notion 행이 같은 이름의 올리지 않은 로컬 파일을 덮음 · 「복제」 두 번째가 앞 사본을 덮음 · 읽지 못한
  보기 설정 파일이 다른 DB 설정을 지움 · 읽지 못했거나 잘린 상태 DB 를 빈 DB 로 엶 · 수정과 삭제가 겹치면 편집이 사라짐.
- **중복 · 누락:** 모호한 실패 뒤 재전송으로 페이지가 두 벌 · 증분 pull 이 변경을 영영 빠뜨림 · 같은 분 원격 편집을 덮음 ·
  부모 조회 일시 오류로 노트를 볼트 맨 위에 받음.
- **조용히 아무것도 안 하던 것:** 이름 변경 · 이동 · 자식 있는 페이지의 본문 · 플러그인 충돌 해결이 Notion 에 가지 않음 ·
  행 속성이 본문 YAML 로 낌.
- **변환 충실도:** 목록 · 콜아웃 · 인용 안 코드, `$` · `$$`, 표 속성 · `\|`, 주석, 북마크, 멘션, 밑줄, 빈 블록, 코드 언어.
- **미디어:** 올린 미디어를 Notion 의 파일 id 로 알아봄 · 바뀌지 않은 미디어를 다시 올리지 않음 · PDF · 동영상 · 소리는 제 블록으로.
- **실볼트 E2E 가 찾은 것:** 캡션 있는 임베드가 원시 `<embed>` 태그로 남음 · 탭 블록 안 글이 코드블록 · `pull --rerender` 가 옛 pull 의 깨진 줄을 지킴.
- **플러그인 · CLI:** 루트 칸의 Notion 주소 · 방향이 막는 단추 · 사라지던 실패 이유 · 숫자가 아닌 `watch` 인자.

결함 ID 가 붙은 전체 목록은 [CHANGELOG](../06-devlog/CHANGELOG.md) 에 있다.

### ⚠️ 알려진 제한

[README 알려진 제한사항](../../README.ko.md#알려진-제한사항) 참고. 이번에 더한 것: 봇 멘션은 Markdown API 가 내보내지 않음 ·
콜아웃 별칭 · 접힘은 Notion 에 자리가 없음 · 제목의 블록 색 마커가 Obsidian 개요에 보임 · 표 칸 코드 속 `|` 의 백슬래시가 보임.

---

## Upgrading

- **Upgrade the CLI and the plugin together (ADR-026).** Close Obsidian (or disable the plugin for
  that vault) before running the CLI on the same vault.
- **The plugin needs Obsidian 1.12.4+.** Install with three files — no `sql-wasm.wasm`.
- **The token moves to the keychain** on first load, per vault. Enter it again in other vaults.
- **The state DB migrates to schema 4** on first open. Pull before pushing a note whose remote body
  changed.
- **Notes pulled by v0.3.x keep the old shape** until the page changes in Notion — run
  `nobsi pull --rerender` (or "Pull from Notion (받아 둔 노트 다시 그리기)").
- The public API drops `BlockConverter` and the `notion-to-md` dependency.

Requires **Node.js 22.13+**.

```bash
# CLI
npm install -g im-nobsidian@0.4.0

# Core (library)
npm install @im-nobsidian/core@0.4.0
```

Obsidian plugin: download `main.js`, `manifest.json` and `styles.css` from this release into
`<vault>/<config folder>/plugins/im-notion-sync/`, then enable **Im-Notion Sync** under
Settings → Community plugins. BRAT installs the same three files.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
