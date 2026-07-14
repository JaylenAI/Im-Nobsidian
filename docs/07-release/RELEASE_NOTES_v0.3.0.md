# Im-Nobsidian v0.3.0 — Round-trip Fidelity Sweep

> **Release date:** 2026-07-14
> **Focus:** Round-trip fidelity (comments / footnotes / highlights / table alignment /
> block spacing), incremental-pull gap fixes, `--force` full scan, Node 22+.
> Every defect found in a deep real-corpus audit (F14–F27) is sealed, and the result is
> proven on real data: **byte-identical round trip (delta-0)** and **zero churn across an
> 869-file vault**.

---

## English

### ✨ Added

- **`nobsi pull --force`** — skip incremental detection and run a full scan. This is the
  user-facing recovery path for pages and child databases that Notion's search indexing
  delay would otherwise permanently hide (F20/F21/F22).
- **Obsidian comments stay private.** Plain `%%comment%%` used to be pushed into Notion
  verbatim — a privacy leak. Comments are now stripped before push and restored on pull
  via preserve markers, so they round-trip losslessly without ever appearing in Notion (F26).
- **Highlight round-trip.** `==mark==` now converts to a Notion background color on push
  and back to `==mark==` on pull (F24).
- **Footnote round-trip.** `[^1]` references and definitions survive push→pull as real
  footnote syntax instead of degrading to plain text (F25).
- **Table column alignment round-trip.** `:---:` / `---:` alignments are restored on pull.
- **Block spacing restoration.** Compact Notion exports are detected at the raw-export
  stage (`notionExportCompact` metadata), so blank lines between paragraphs, headings and
  lists are restored reliably — including pages containing explicit empty paragraphs that
  previously fooled the heuristic. Same-kind blocks separated by a blank line are no
  longer re-merged (D1).
- **Attachment dedup on pull.** An embedded image represented both in place
  (quote + marker) and as a page-end image block is now detected via SHA-256 + basename
  match — no duplicate download, no duplicate line (D6).

### 🐛 Fixed

- **Captioned images now download.** They used to remain as expiring Notion URLs (F14).
- **Incremental pull watermark gap** — new subpages created inside the search-indexing
  window were permanently missed (F20).
- **New child databases were never discovered** after the first full pull due to the
  discovery cache gate; `pull --force` now rescans (F21).
- **Inaccessible-DB denylist** — linked/unshared/deleted databases are no longer retried
  with a doomed 404 (and a stack trace) on every pull, and no longer pollute the vault
  with empty folders / `.base` files.
- **Note embeds (`![[note]]`) are no longer swallowed** by attachment resolution (D5).
- **Frontmatter fixes on pull** — missing `title` injection and date quoting (D2/D3).
- **Tab-indented nesting normalized to 4 spaces** — no more accidental code-block
  parsing of nested lists from Notion exports (D4).
- **ENOENT stack-trace noise suppressed** when attachment resolution succeeds via
  fallback (F23).
- **Preserve markers re-injected at their original anchor positions.**

### 🔧 Changed

- **Node.js engine 20 → 22.13+** (⚠️ Node 20 users must upgrade). CI matrix 22/24.
- **Dependencies refreshed** — `@notionhq/client` v5, `better-sqlite3` v12, `chokidar` v5,
  `lint-staged` v17, `typescript-eslint` v8.64, and more.

### ✅ Quality

- **1151 tests passing** (11 skipped, 0 failed); lint / typecheck / build clean.
- **Proven on real data:** torture-note push→pull returns the original **byte-for-byte
  (delta-0)**; full `--force` scan over 875 pages; a no-change pull leaves all 869
  markdown files **hash-identical (churn-0)** with zero conflicts.

### ⚠️ Known limitations (by design)

- A **soft break** (single newline) becomes a separate paragraph block in Notion — use a
  blank line for intentional splits.
- **Consecutive empty paragraphs** collapse to a single blank line (Notion has no
  "N empty paragraphs" concept); block spacing itself is restored on pull.
- **Note embeds** (`![[note]]`) appear as page links in Notion (no transclusion concept)
  and are restored as embeds on pull.

---

## 한국어

### ✨ 추가

- **`nobsi pull --force`** — 증분 감지를 건너뛰고 전체 스캔. Notion search 인덱싱 지연으로
  영구 누락되던 신규 하위 페이지·신규 child DB의 사용자 복구 수단 (F20/F21/F22).
- **옵시디언 주석 비노출.** 일반 `%%주석%%`이 Notion에 그대로 올라가던 정보 유출을 봉합 —
  push 전 제거하고 보존 마커로 pull 시 복원해, Notion에 노출 없이 무손실 왕복한다 (F26).
- **하이라이트 왕복.** `==마크==`가 push 시 노션 배경색으로, pull 시 다시 `==마크==`로 (F24).
- **각주 왕복.** `[^1]` 참조/정의가 평문으로 열화되지 않고 각주 문법 그대로 생존 (F25).
- **표 열 정렬 왕복.** `:---:` / `---:` 정렬이 pull 후 복원.
- **블록 간격 복원.** 압축형 Notion export를 원시 export 시점에 판정(`notionExportCompact`
  메타데이터)해 문단/제목/리스트 간 빈 줄을 신뢰성 있게 재간격 — 명시적 빈 문단이 섞인
  페이지에서 휴리스틱이 오판하던 문제 제거, 같은 종류 블록의 재병합도 방지 (D1).
- **첨부 중복 제거(pull).** 제자리(quote+마커)와 페이지 끝 image block의 이중 표현을
  SHA-256 + 파일명 대조로 감지 — 재다운로드·중복 라인 없음 (D6).

### 🐛 수정

- **캡션 이미지 다운로드** — 만료되는 Notion URL로 잔존하던 문제 (F14).
- **증분 pull 워터마크 갭** — search 인덱싱 창 안에서 생성된 신규 하위 페이지 영구 누락 (F20).
- **신규 child DB 영구 미발견** — 발견 캐시 게이트 탓에 최초 full pull 이후 생긴 child DB에
  복구 경로가 없던 문제. `pull --force`가 재스캔 (F21).
- **접근 불가 DB denylist** — 링크드/미공유/삭제 DB를 매 pull마다 404 재시도하며
  스택트레이스를 쏟고 빈 폴더/`.base`를 오염시키던 문제 차단.
- **노트 임베드(`![[노트]]`) 삼킴 제거** — 첨부 해석이 노트를 첨부로 오분류하던 문제 (D5).
- **pull frontmatter 정합성** — `title` 미주입·날짜 따옴표 (D2/D3).
- **탭 들여쓰기 4-space 정규화** — 중첩 리스트가 코드블록으로 오파싱되던 문제 (D4).
- **첨부 폴백 성공 시 ENOENT 스택트레이스 노이즈 억제** (F23).
- **보존 마커를 원문 앵커 위치에 재주입.**

### 🔧 변경

- **Node.js 엔진 20 → 22.13+** (⚠️ Node 20 사용자는 업그레이드 필요). CI 매트릭스 22/24.
- **의존성 최신화** — `@notionhq/client` v5, `better-sqlite3` v12, `chokidar` v5,
  `lint-staged` v17, `typescript-eslint` v8.64 등.

### ✅ 품질

- **1151개 테스트 통과**(11 skip, 0 실패); lint / typecheck / build 클린.
- **실데이터 실증:** 고문 노트 push→pull **바이트 단위 원본 일치(delta-0)**;
  875페이지 `--force` 전체 스캔 정상; 무변경 pull에서 869개 md **해시 완전 동일(churn-0)**,
  충돌 0.

### ⚠️ 알려진 제한 (설계상)

- **Soft break**(단일 개행)는 Notion에서 별도 문단 블록이 된다 — 의도적 분리는 빈 줄로.
- **연속 빈 문단**은 1개로 정규화된다(Notion에 "빈 문단 N개" 개념 없음); 블록 간격 자체는
  pull 시 복원된다.
- **노트 임베드**(`![[노트]]`)는 Notion에서 페이지 링크로 표현되고(트랜스클루전 개념 없음)
  pull 시 임베드로 복원된다.

---

## Install / Upgrade

Requires **Node.js 22.13+**.

```bash
# CLI
npm install -g im-nobsidian@0.3.0

# Core (library)
npm install @im-nobsidian/core@0.3.0
```

Obsidian plugin: update via BRAT, or copy `main.js` / `manifest.json` / `styles.css`
from the `0.3.0` release into `.obsidian/plugins/im-nobsidian/`.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
