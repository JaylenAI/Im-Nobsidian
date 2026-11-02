# Im-Nobsidian v0.20.0 — Previews Count What the Sync Will Do

> **Release date:** 2026-11-02
> **Focus:** a preview of a vault that lost its state now matches the real sync: rows of databases the pull will
> discover, and notes that will be re-linked as conflicts. Two plugin network fixes found while checking that live.

---

## English

### 🐛 Fixed

- **`pull --dry-run` re-linked notes by path alone.** In a vault that lost `.im-nobsidian/sync.db`, the preview said
  every note in place would be re-linked, even when its text differed and the real pull would leave it as a conflict.
  The preview now renders the received page, compares it with the note (attachments are matched to the vault's files,
  not downloaded), and counts the conflicts. Database rows follow the same rule.
- **Re-linking a note with heading links (`[[note#heading]]`) left it as a conflict.** The vault link and the Notion
  block link were not treated as the same text.
- **The plugin could not download text attachments (`.txt`, `.html`).** It parsed every `text/*` response as JSON.
  Notes embedding such files were left as conflicts when re-linked; the CLI was not affected.
- **The plugin did not retry requests that lost the connection.** Electron's `net::ERR_NETWORK_CHANGED` and similar
  errors carry no code, so the first preview right after launching Obsidian could fall back to the block API and differ
  from the next one. Idempotent requests are now retried.

### 🔁 Changed

- **The preview counts rows of databases it will discover** — databases right under the root (a first pull, a vault
  that lost its state, a changed root) and databases inside notes it will re-link. The v0.19.1 notice now appears only
  for databases inside new pages whose body was not read, and reads 「Notion 에 새로 생긴 페이지 안의 DB 행은 미리 세지
  않았습니다 — 받으면서 찾습니다」.

---

## 한국어

### 🐛 고친 것

- **상태 DB 를 잃은 볼트의 미리 보기가 경로만 보고 «다시 잇습니다» 로 셌습니다.** 글이 달라 실제 pull 이 충돌로 남길 노트도
  그렇게 셌습니다. 이제 받은 글로 바꿔 견주고(첨부는 내려받지 않고 볼트의 것과 맞춥니다) 충돌로 남을 노트를 충돌로 셉니다. DB
  행도 같습니다.
- **제목 링크(`[[노트#제목]]`)를 가진 노트를 다시 이을 때 충돌로 남았습니다.**
- **플러그인이 글 첨부(`.txt` · `.html`)를 받지 못했습니다** — 응답을 JSON 으로 읽었습니다. CLI 는 그렇지 않았습니다.
- **플러그인이 연결이 잠깐 끊긴 요청을 다시 보내지 않았습니다** — 앱을 막 띄운 뒤 첫 미리 보기가 다음 것과 달랐습니다.

### 🔁 바뀐 것

- **미리 보기가 새로 찾을 DB 의 행을 셉니다** — 루트 바로 아래 DB 와 다시 이을 노트 안의 DB. 「미리 세지 않았습니다」 는 본문을
  아직 읽지 않은 새 페이지 안의 DB 에만 나옵니다.

### 알려진 한계

- 본문을 읽지 않은 새 페이지 안의 DB 는 여전히 받아 봐야 찾습니다 — 세려면 모든 새 페이지의 본문을 읽어야 합니다.
- Notion 에서만 제목을 고치면 볼트의 링크는 그 블록을 따라가지만 보이는 글은 옛 제목으로 남습니다 — Notion 의 링크 글자도 그대로
  남습니다(ADR-055).

---

## Verification

- **Tests:** core 4,349 · cli 185 · plugin 510 on Linux (build, lint, format, typecheck), and CI on Linux (Node 22,
  24), macOS and Windows.
- **Real Notion (CLI):** copies of two vaults with `sync.db` deleted. `pull --dry-run` listed 8 notes and rows to
  re-link and 1 conflict; the real pull re-linked 8 with 1 conflict and no new attachment copies. A note with heading
  links re-linked without a conflict; the next push and pull changed nothing.
- **Real Notion (plugin, Obsidian 1.12.4, isolated profile):** the same vault with its state deleted, three fresh
  launches. Every first preview showed 10 to re-link, 0 new and 0 to push; two launches hit `ERR_NETWORK_CHANGED` and
  retried. The real sync left 13 records, 0 conflicts and the same file set; the next previews were empty.
- **Heading renamed only in Notion:** the vault link follows the block (`[[X#new|X > old]]`), keeping the old text as
  Notion does.

---

## Upgrading

No configuration changes are required.

```bash
npm install -g im-nobsidian@0.20.0
npm install @im-nobsidian/core@0.20.0
```

**Obsidian plugin:** download `main.js`, `manifest.json` and `styles.css` from this release into
`<vault>/<config folder>/plugins/im-notion-sync/`, or update through BRAT.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
