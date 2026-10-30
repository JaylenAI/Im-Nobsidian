# Im-Nobsidian v0.14.1 — Starts Again with Notion SDK 5.30

> **Release date:** 2026-10-30
> **Focus:** a patch. A fresh install of 0.13.0 or 0.14.0 picks up `@notionhq/client` 5.30.0, released the
> same day, and the CLI could not start.

---

## English

### 🐛 Fixed

- **The CLI failed at start with `SyntaxError: Named export 'Client' not found`.** `@notionhq/client`
  5.30.0 exports `Client` in a form Node's ES module loader cannot read by name, and the dependency range
  (`^5.28.0`) accepted it. Im-Nobsidian now takes `Client` from the package's CommonJS exports when the
  named export is missing. The dependency is raised to 5.30, and CI starts the built CLI on every run.
  Found by the npm smoke test of 0.14.0.

Everything else is as in [v0.14.0](RELEASE_NOTES_v0.14.0.md).

---

## 한국어

### 🐛 고친 것

- **CLI 가 `SyntaxError: Named export 'Client' not found` 로 시작하지 못하던 것** — 같은 날 나온 `@notionhq/client` 5.30.0 이
  `Client` 를 Node ESM 이 이름으로 읽지 못하는 꼴로 내보내고, 의존성 범위(`^5.28.0`)가 그 버전을 받았습니다. 이름에 없으면 CommonJS
  내보내기에서 꺼냅니다. 의존성을 5.30 으로 올리고 CI 가 빌드한 CLI 를 띄워 봅니다. 0.14.0 의 npm 스모크에서 찾았습니다.

나머지는 [v0.14.0](RELEASE_NOTES_v0.14.0.md) 과 같습니다.

---

## Verification

- **Tests:** 4,695 passed on Linux with `@notionhq/client` 5.30.0 (build, lint, format, typecheck), the full
  suite on Windows in CI, and the new CI step that starts the built CLI on Node 22 and 24. The step fails
  on the 0.14.0 code.
- **Real Notion API, SDK 5.30.0:** a fresh vault pulled the regression test root (10 created, bodies
  identical); a body edit, a new note and a row property pushed from it reached a second vault; both
  vaults then had no changes.

---

## Upgrading

```bash
npm install -g im-nobsidian@0.14.1
npm install @im-nobsidian/core@0.14.1
```

**Obsidian plugin:** the plugin bundles the SDK and was not affected. This release bundles SDK 5.30.0
with the same fix. Download `main.js`, `manifest.json` and `styles.css` from this release, or update
through BRAT.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
