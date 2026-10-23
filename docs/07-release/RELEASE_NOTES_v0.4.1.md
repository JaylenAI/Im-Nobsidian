# Im-Nobsidian v0.4.1 — Real-Data Round Trip

> **Release date:** 2026-10-23
> **Focus:** Pull a real Notion workspace into an empty vault, push that copy (1,492 notes) to a
> new root, and pull it back again, then fix what breaks along the way. Pushing the copy to a new
> root used to create 346 pages and fail 1,146. It now creates all 1,492. Pushing a note with a
> synced-block reference no longer rewrites the original block on another page.
>
> **v0.4.0 never reached npm or the GitHub releases** (the publish token failed), so this release
> is the first one after 0.3.2. The CLI and the plugin must be upgraded together, the plugin needs
> Obsidian 1.12.4+, and the token moves to the Obsidian keychain. See
> [v0.4.0](RELEASE_NOTES_v0.4.0.md) and [Upgrading](#upgrading).

---

## English

### 🔴 Synced blocks

- **Pushing a note with a synced-block reference rewrote the original block on another page.**
  This happened when the reference went through Notion's Markdown API (create or body replace).
  Notion rebuilt the original's children from what was sent. Identical text still got new block
  ids, attachments became placeholder text, and an empty reference emptied the original.
  The reference is now sent as a placeholder paragraph and attached with the block API
  (`synced_from`) after the body is written. The original keeps its block ids and edit time.
  Text inside a reference belongs to the original. Editing it in the vault does not reach Notion.
- **Notes with a synced-block reference could not be created at all.** Notion refused the
  page (`Block not found in record map`), and every note under that folder note failed with
  it. In the real-data copy, 13 such notes made 1,146 notes fail.

### 🐛 Fixed

- **Push**
  - Code blocks whose every line is indented lost that indentation in Notion. They are now
    filled through the block API.
  - Inline math glued to text (`w$^9$가`) arrived in Notion as plain text. Notion does not read
    `$…$` next to a letter as math, so math that Obsidian renders there is sent as ``$`…`$``.
  - An italic span containing a literal `\*` broke in Notion. It is now sent as `_…_`.
  - Child page titles such as `__c1__` came back bold. Underscores in returned child tags are
    now escaped.
- **Pull**
  - Every pull failed 2 pages. Inline databases nested in a database came back in the row query
    and were fetched as rows.
  - Pulling a large tree right after creating it could miss pages, with 0 failures reported
    (40 of 1,614). Children that discovery missed are now taken from the child-page tags in the
    parent's body, at no extra request cost.
  - Attachment and `.base` placeholders broke: a path with `__folder__` turned bold, and a file
    name such as `9.23.13.mov` became an autolink.
  - A child page whose title cannot be a file name (`a / b` → `a _ b.md`) was linked as
    `[[a / b]]`, a broken link. It is now `[[a _ b|a / b]]`, and push still keeps the child in
    its place.
  - A mention of a page outside the vault showed the page id. It now shows the page title.
- **Round trip**
  - Pulling right after a push rewrote notes whose content Notion stores identically (13 of
    1,492). Examples: a child-page line at the end of a folder note, a link that differs only in
    its title slug, or an autolink Notion added. The local spelling is now kept.

### ⚠️ Known limitations

See [Known Limitations](../../README.md#known-limitations). New in this release's list:

- **Push does not create Notion databases.** A database folder pushed to a new root arrives as
  plain pages (planned for v0.5.0).
- **Uploads above Notion's per-file limit** (5 MB on the Free plan) stay in the vault as a
  placeholder.
- **Notion autolinks** domain-like text.
- **Custom emoji and link previews** are not recreated on push.

---

## 한국어

### 🔴 동기화 블록

- **동기화 블록 참조가 든 노트를 올리면 다른 페이지의 원본이 다시 쓰이던 것을 고쳤습니다.**
  참조를 Markdown API(만들기 · 본문 교체)로 보내면 Notion 이 보낸 내용으로 원본의 자식을 새로 만들었습니다.
  이제 참조 자리에는 자리표시 문단만 보내고, 본문을 쓴 뒤 블록 API(`synced_from`)로 붙입니다.
  원본은 블록 id · 수정 시각까지 그대로입니다.
  참조 안의 글은 원본이 주인이라, 볼트에서 고쳐도 Notion 에 보내지 않습니다.
- **참조가 든 노트를 새로 만들지 못하던 것을 고쳤습니다.**
  그 폴더 노트 아래가 줄줄이 실패해, 실데이터 사본에서는 13 노트가 1,146 실패로 번졌습니다.

### 🐛 수정

- **올리기**
  - 모든 줄이 들여쓰인 코드가 들여쓰기를 잃던 것
  - 글자에 붙은 인라인 수식(`w$^9$가`)이 글이 되던 것
  - `\*` 가 든 기울임이 깨지던 것
  - 자식 제목 `__c1__` 이 굵게 돌아오던 것
- **받기**
  - pull 마다 실패 2 가 남던 것
  - 큰 트리를 만든 직후 받으면 실패 0 으로 일부(1,614 가운데 40)가 빠지던 것
  - `__폴더__` 경로 · `9.23.13.mov` 같은 이름의 첨부 자리표시자가 깨지던 것
  - 파일 이름이 될 수 없는 자식 제목의 링크(`[[a / b]]`)가 끊기던 것
  - 볼트 밖 페이지 멘션이 id 로 보이던 것
- **왕복**
  - 올린 직후 같은 볼트로 받으면 Notion 에서 같은 글인 노트를 다시 쓰던 것(1,492 가운데 13)

### ⚠️ 알려진 제한

[README 알려진 제한사항](../../README.ko.md#알려진-제한사항) 참고. 이번에 더한 것:

- push 는 Notion DB 를 만들지 않음(v0.5.0 예정)
- 파일 하나의 업로드 상한(무료 플랜 5MB)
- Notion 자동 링크
- 커스텀 이모지 · 링크 미리보기

---

## Verification

- **Tests:** 4,047 passed (build, lint, format, typecheck, coverage). Every fix began with a test
  that failed before it.
- **Full real-data round trip** (fixes 1–4 of the first round): pulled a real workspace into an
  empty vault, then pushed the 1,492-note copy to a new root.
  - Created: 346 → 1,492. Failed: 1,146 → 0.
  - Pulled into another empty vault: 1,574 written, 0 failed, dry run empty.
- **Targeted real-data run on the final build** (16 notes: 9 synced references, 4 indented code
  blocks, 3 placeholder markers; 39 attachments, 107 MB):

  | Step                      | Result                                             |
  | ------------------------- | -------------------------------------------------- |
  | Push                      | 16 created, 0 failed, 328 s                        |
  | Push dry run              | 0                                                  |
  | Pull into an empty vault  | 19 written (16 notes + 3 parent folders), 0 failed |
  | Dry run after the pull    | 0                                                  |
  | Repeat `pull --force`     | 0 written, 0 hash changes                          |
  | Pull in the pushing vault | 0 written                                          |
  - Indented code: 16/16 kept.
  - Embeds: 33/34 kept, 0 broken.
  - Synced references: 4/4 kept.
  - The 5 real originals on the user's pages, read before and after: block ids and edit times
    unchanged.

- **Live probes** checked each fix against a real Notion page: inline math, italics, mention title,
  child link, and a self-pull right after push.

---

## Upgrading

**Coming from 0.3.x**

Everything in [v0.4.0 → Upgrading](RELEASE_NOTES_v0.4.0.md#upgrading) applies:

- Upgrade the CLI and the plugin together.
- The plugin needs Obsidian 1.12.4+.
- The token moves to the keychain.
- The state DB migrates to schema 4.

**Notes pulled before this release** keep their old spelling until the page changes in Notion.
Run `nobsi pull --rerender` to redraw them now.

Requires **Node.js 22.13+**.

```bash
# CLI
npm install -g im-nobsidian@0.4.1

# Core (library)
npm install @im-nobsidian/core@0.4.1
```

**Obsidian plugin:**

1. Download `main.js`, `manifest.json` and `styles.css` from this release.
2. Put them in `<vault>/<config folder>/plugins/im-notion-sync/`.
3. Enable **Im-Notion Sync** under Settings → Community plugins.

BRAT installs the same three files.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
