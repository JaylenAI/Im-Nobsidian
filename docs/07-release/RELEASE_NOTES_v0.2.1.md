# Im-Nobsidian v0.2.1

> **Release date:** 2026-06-03
> **Focus:** CLI `--version` accuracy & documentation refresh (patch).
> A long-standing bug where `nobsi --version` always printed a hardcoded `0.1.1`
> is root-fixed by reading the version dynamically from `package.json`, and the
> install command, test counts and roadmap across the docs are brought current.

---

## English

### 🐛 Fixed

- **`nobsi --version` now reports the real version.** It was hardcoded to `0.1.1`
  and never updated, so every release printed the wrong version. The CLI now reads
  its version dynamically from `package.json` via `createRequire` — so it is always
  correct, automatically, on every future release.
- **Install command typo corrected.** `npm install -g nobsi` (which 404s — `nobsi`
  is only a bin alias, not a package) is fixed to the real package name
  `npm install -g im-nobsidian` across the README, getting-started guide and
  user scenarios.

### 🔧 Changed

- **Docs brought current.** Root and Korean READMEs now show the real test count
  (696 → **1038**), the current plugin version (v0.1.11 → **v0.2.1**), and an
  up-to-date roadmap (v0.2.x). `ROADMAP.md` / `CURRENT_STATUS.md` version pointers
  refreshed.

### ✅ Quality

- No functional change to the sync engine; **1038 tests** still green
  (core 858 + CLI 31 + plugin 149), lint / typecheck clean.

### ⚠️ Notes

- This is a patch release. v0.2.0 stays published on npm; v0.2.1 becomes the new
  `latest`. No data migration, no behavior change.

---

## 한국어

### 🐛 수정

- **`nobsi --version`이 실제 버전을 출력한다.** 그동안 `0.1.1`로 하드코딩되어 갱신되지
  않아 모든 릴리스에서 버전이 틀리게 표시됐다. 이제 CLI가 `createRequire`로
  `package.json`에서 버전을 동적으로 읽어 — 앞으로 모든 릴리스에서 자동으로 올바른
  버전을 출력한다.
- **설치 명령 오타 교정.** `npm install -g nobsi`(404 — `nobsi`는 패키지가 아니라 bin
  별칭일 뿐)를 실제 패키지명 `npm install -g im-nobsidian`으로 README·시작 가이드·
  사용자 시나리오 전반에서 정정했다.

### 🔧 변경

- **문서 현행화.** 루트/한국어 README의 테스트 수(696 → **1038**), 현재 플러그인
  버전(v0.1.11 → **v0.2.1**), 로드맵(v0.2.x)을 최신화했다. `ROADMAP.md` /
  `CURRENT_STATUS.md` 버전 포인터도 갱신.

### ✅ 품질

- 동기화 엔진 기능 변경 없음; **1038개 테스트** 그대로 통과(core 858 + CLI 31 +
  plugin 149), lint / typecheck 클린.

### ⚠️ 참고

- 패치 릴리스다. v0.2.0은 npm에 그대로 유지되고 v0.2.1이 새 `latest`가 된다.
  데이터 마이그레이션·동작 변경 없음.

---

## Install / Upgrade

```bash
# CLI
npm install -g im-nobsidian@0.2.1

# Core (library)
npm install @im-nobsidian/core@0.2.1
```

Obsidian plugin: update via the plugin manager, or copy `main.js` / `manifest.json` /
`styles.css` from the `0.2.1` release into `.obsidian/plugins/im-nobsidian/`.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
