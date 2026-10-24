# Im-Nobsidian v0.9.2 — Windows Paths and Path Patterns

> **Release date:** 2026-10-25
> **Focus:** [Issue #8](https://github.com/JaylenAI/Im-Nobsidian/issues/8). On Windows the CLI found no new
> notes and ignored `paths.include` and `paths.exclude`. Two of the causes affected every OS. CI now runs
> the whole test suite on Windows too.

---

## English

### 🐛 Fixed

- **Windows: new notes were never found, and path patterns had no effect.** The vault listing kept
  Windows separators (`00 Me\a.md`), so it matched no pattern, no state record and no `-p` scope. Vault
  paths now always use `/`. State records written by an older CLI with `\` are rewritten when the state
  DB opens on Windows. If the same note had been uploaded twice, the duplicate record stops being tracked.
- **Include patterns pruned folders (every OS).** With `00 Me/**/*.md` the folder `00 Me` itself did not
  match, so the CLI never walked into it. Include patterns now apply to files only. `**/` also matches
  zero folders (`a/**/*.md` matches `a/x.md`), regex characters in patterns are literal, and exclude or
  ignore patterns ending in `/` (such as `templates/` from the guide) now work.
- **🔴 Excluded notes were treated as deleted.** After an already-synced folder was added to `exclude`,
  `status` listed its notes as deleted and `pull` tried to restore them. With `deleteSync` on, `push`
  planned to delete their Notion pages. Excluded notes are now left alone: not pulled, not restored, not
  deleted.
- **Pull turned `->` into `-\>`.** The Notion markdown API escapes every `<` and `>` outside code. Pull
  now unescapes them, except a `\>` that would start a quote and a `\<` that would start a tag.
- **Windows: a folder at the state DB path was reported as an empty state file.** The real error is
  shown now.

### 🧪 Verified against the real Notion API (0.9.0 from npm vs. 0.9.2)

| Step                                       | 0.9.0         | 0.9.2        |
| ------------------------------------------ | ------------- | ------------ |
| `include: ["00 Me/**/*.md"]`, push dry run | no changes    | 2 notes      |
| synced folder added to `exclude`: status   | deleted 1     | nothing      |
| same: `sync --dry-run`                     | restored 1    | no changes   |
| same, `deleteSync`: push dry run           | deleted 1     | no changes   |
| `**a -> b**` after a fresh pull            | `**a -\> b**` | `**a -> b**` |

### Known limitations

- The Obsidian plugin does not apply `paths.include`, `paths.exclude` or `.im-nobsidian-ignore` yet.
- A page created in Notion is still pulled even when its folder is excluded, because its vault path is
  only known once it is pulled.
- Real Windows runs are covered by CI (`windows-latest`) only.

---

## 한국어

### 🐛 고친 것

- **Windows 에서 새 노트를 찾지 못하고 경로 패턴이 먹지 않던 것** — 볼트 목록이 `00 Me\a.md` 처럼 Windows 구분자를 그대로 써서
  패턴 · 상태 기록 · `-p` 범위 어느 것과도 맞지 않았습니다. 볼트 경로는 이제 늘 `/` 로 잇습니다. 예전 CLI 가 `\` 로 적은
  상태 기록은 Windows 에서 상태 DB 를 열 때 고쳐 적습니다. 같은 노트를 두 번 올린 경우 사본 기록은 추적만 놓습니다.
- **포함 패턴이 폴더를 걸러 내던 것(모든 OS)** — `00 Me/**/*.md` 면 폴더 `00 Me` 가 패턴에 맞지 않아 안을 걷지 않았습니다.
  포함 패턴은 파일에만 댑니다. `**/` 가 폴더 0 단계를 받고, 패턴의 정규식 글자는 글자로 보며, 가이드의 `templates/` 처럼
  끝에 `/` 를 붙인 제외 · 무시 패턴이 이제 맞습니다.
- **🔴 뺀 노트를 지운 노트로 보던 것** — 동기화하던 폴더를 `exclude` 에 넣으면 status 가 삭제로, pull 이 되살리기로 보였고,
  `deleteSync` 면 push 가 그 Notion 페이지를 지울 계획을 세웠습니다. 뺀 노트는 받지도 · 되살리지도 · 지우지도 않습니다.
- **pull 이 `->` 를 `-\>` 로 바꾸던 것** — markdown API 가 코드 밖 `<` · `>` 를 모두 이스케이프합니다. 인용을 열 `\>` 와 태그를
  열 `\<` 만 두고 풉니다.
- **Windows 에서 상태 DB 자리의 폴더를 빈 상태 파일로 진단하던 것** — 열지 못한 까닭을 그대로 보입니다.

### 알려진 한계

- 옵시디언 플러그인은 아직 `paths.include` · `paths.exclude` · `.im-nobsidian-ignore` 를 적용하지 않습니다.
- Notion 에 새로 생긴 페이지는 뺀 폴더에 놓일 것이어도 받습니다 — 받기 전에는 볼트의 자리를 모릅니다.
- 실제 Windows 는 CI(`windows-latest`)로만 확인했습니다.

---

## Verification

- **Tests:** 4,371 passed on Linux (build, lint, format, typecheck), and the full suite on Windows in CI.
- **Real Notion API:** the table above, on a probe page that was trashed afterwards.

---

## Upgrading

No configuration changes. If you use `paths.include` or `paths.exclude`, check what they select now:
`nobsi push --dry-run` lists the notes that would be uploaded. On Windows, the first run rewrites the
state DB paths and logs a warning if it changed anything.

```bash
npm install -g im-nobsidian@0.9.2
npm install @im-nobsidian/core@0.9.2
```

**Obsidian plugin:** download `main.js`, `manifest.json` and `styles.css` from this release into
`<vault>/<config folder>/plugins/im-notion-sync/`, or update through BRAT.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
