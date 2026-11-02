# Im-Nobsidian v0.19.0 — Heading Links in One Push, Honest Previews

> **Release date:** 2026-11-02
> **Focus:** phase 14 of the full-sync plan. Heading and block links become Notion block links in the same push even
> when the target note is new or the heading sits inside a callout or a list, and a preview of a vault that lost its
> sync state no longer counts notes it will re-link as new. Dry-run output changed, so this is a minor release.

---

## English

### 🐛 Fixed

- **Links to a heading in a note created by the same push stayed as text in Notion.** `[[B#Heading]]` from note A,
  pushed together with a new note B (or a link to a heading in the note itself), reached Notion as the text
  `[[B#Heading]]` until A was edited and pushed again. It is now a block link after one push.
- **Links to a heading or `^block` inside a callout, a list or a toggle never became links.** Only top-level blocks
  were searched. When the target is not at the top level, the whole block tree is searched.
- **A note linking to a heading that does not exist was sent again on every push.** The reason a link could not be
  resolved is now recorded, and the note is checked again only when its target note changes.
- **`pull --dry-run` and `sync --dry-run` counted notes they would re-link as new** in a vault that lost
  `.im-nobsidian/sync.db`. The preview now lists the notes and database rows it will re-link, counts them neither as
  pulled nor as pushed, and does not count an existing folder as created. `--json` reports them in `relinkedPaths`
  with `relinkPending: true`. The plugin's preview lists them under 「그 밖에」.

### 📝 Docs

- README: the plugin row of the package table shows the latest release instead of v0.12.0; the Korean row on edits
  from the same token matches the English one (checked by content since v0.15.0); a folder holding only its folder note
  is listed as a Notion model limit.

---

## 한국어

### 🐛 고친 것

- **같은 push 에서 만든 노트의 제목으로 가는 링크가 Notion 에서 글자로 남았습니다.** 새 노트 B 와 함께 올린 A 의 `[[B#제목]]`
  (또는 제 노트의 제목 링크)이 A 를 다시 고쳐 올릴 때까지 `[[B#제목]]` 글자였습니다. 이제 한 번의 push 로 블록 링크가 됩니다.
- **콜아웃 · 목록 · 토글 속 제목과 `^블록` 으로 가는 링크가 링크가 되지 않았습니다** — 맨 위 블록만 찾았습니다. 블록 나무 전체에서
  찾습니다.
- **없는 제목으로 가는 링크가 있는 노트를 push 마다 다시 보냈습니다** — 못 푼 까닭을 적어 대상 노트가 바뀔 때만 다시 봅니다.
- **상태 DB 를 잃은 볼트의 `pull --dry-run` · `sync --dry-run` 이 다시 이을 노트를 생성으로 셌습니다.** 이을 노트 · 행을 경로로
  알리고 받을 것 · 올릴 것으로 세지 않습니다. 이미 있는 폴더도 생성으로 세지 않습니다. 플러그인 미리 보기는 「그 밖에」 에 적습니다.

### 알려진 한계

- 미리 보기는 글을 받아 견주지 않아, 다시 이을 노트 가운데 글이 달라 충돌로 남을 것을 미리 말하지 못합니다.
- 폴더 노트 하나뿐인 폴더(`fn/fn.md`)는 다른 볼트에서 `fn.md` 로 받습니다 — Notion 페이지는 하위가 없으면 노트와 폴더를 가르지
  않습니다.
- 폴더 노트가 있는 폴더 · 볼트 맨 위의 파일은 올리지 않습니다(경고).
- 실기기(iOS · Android)와 Business 플랜의 요청 한도는 아직 재 보지 않았습니다.

---

## Verification

- **Tests:** core 4,338 · cli 184 · plugin 504 on Linux (build, lint, format, typecheck), and CI on Linux (Node 22,
  24), macOS and Windows.
- **Two vaults against real Notion** (probe `__p14_links_20261102__`): one push made all seven heading and block links
  (a heading and a `^block` in a note created later in the same push, a heading inside a callout, a `^block` inside a
  nested list item, an alias, and two links to the note's own headings) into Notion block links. A second push changed
  nothing; vault B pulled 3, then B's push and A's pull changed nothing.
- **Lost sync state against real Notion:** a copy of vault B with `sync.db` deleted. `pull --dry-run` and
  `sync --dry-run` listed 2 notes to re-link and nothing to create or push; the real pull re-linked the same 2 notes
  (the previous build reported 3 created).
- **Release regression:** the eight scripts of earlier releases on the dev build against fresh probes. Output
  matches the 0.18.0 run except new probe ids and the order in which Notion lists new database columns and new
  subpages.

---

## Upgrading

No configuration changes are required. Heading links that earlier releases sent to Notion as text are sent again by
the next push that has changes to send (the note itself need not change).

```bash
npm install -g im-nobsidian@0.19.0
npm install @im-nobsidian/core@0.19.0
```

**Obsidian plugin:** download `main.js`, `manifest.json` and `styles.css` from this release into
`<vault>/<config folder>/plugins/im-notion-sync/`, or update through BRAT.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
