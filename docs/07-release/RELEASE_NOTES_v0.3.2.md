# Im-Nobsidian v0.3.2 — Render Fidelity & Sync Resilience

> **Release date:** 2026-07-28
> **Focus:** Make the markdown that lands in your vault look the way Notion looks. Toggles that
> were parsed as code blocks, tables that collapsed into pipe fragments, callouts that rendered
> as red errors — 15 render defects (P1–P7) plus a document-swallowing code-fence bug (P11) are
> sealed, and the render rules now ship inside `@im-nobsidian/core` so the same gate guards
> both the test corpus and a real vault.
> Alongside that, a robustness track (R0–R13): pull no longer stalls under rate limiting,
> every network path has a deadline, four classes of unresolved links now resolve, the CLI
> reports real exit codes, and a database row you delete locally comes back on the next pull.
> Proven on a **clean-slate 1,268-note real vault** (343 pages + 925 database rows) with
> **churn-0** across re-pull / push / bidirectional sync and **0 render defects**.
>
> Patch release — **additive config only**, fully compatible with v0.3.1.

---

## English

### 🐛 Fixed

- **Rendered markdown no longer breaks in Obsidian (P1–P7, 15 defect classes).** Reported from
  real vaults: toggles displayed as grey code blocks, tables broken into raw pipe fragments,
  callouts rendered as red "unknown callout" errors. Root causes were in how Notion's NFM
  containers (`<details>`, `<callout>`, `<columns>`, toggle headings) were unwrapped —
  4-space-indented callout bodies became indented code, container tags leaked as literal text,
  `{toggle="true"}` heading attributes leaked into the title, table separator rows were orphaned
  from their headers, and code fences could end up odd-numbered. The real workspace's **120 NFM
  originals** are now a regression oracle.
- **Code content no longer swallows the document (P11).** A fenced block whose _content_ contained
  a backtick run at least as long as its boundary fence terminated the block early, so everything
  after it was re-parsed as code — in the worst observed case **8,200 lines of prose** became one
  grey box. Boundary fences are now widened one tick beyond the longest run inside the content,
  which is what CommonMark requires.
- **A database row you delete locally now comes back (R13).** The row loop skipped any page whose
  remote `last_edited_time` was unchanged **without ever asking whether the local file still
  existed**, and the orchestrator's restore path deliberately excluded database rows on the
  assumption that the row loop already handled it. Both sides believed the other was doing it.
  Restores are now counted separately from updates (`DatabaseSyncResult.restored`) so idempotency
  and dry-run gates do not mistake a restore for a remote change.
- **Pull no longer stalls under rate limiting (R9c).** Retry backoff slept **while holding the
  rate-limit slot**, so one throttled request froze the whole queue. Backoff now happens outside
  the slot, and each retry logs, so a slow pull is distinguishable from a hung one.
- **`Retry-After` is finally honored (R9d).** The header was read off the wrong object and never
  applied.
- **Every network path has a deadline (R9a, R9e, R9f).** Attachment downloads had no timeout at
  all; database rows and attachments were missing the per-item cap that pages already had.
- **Four classes of links now resolve (R10-A–D).** Aliased `[[notion:<id>|alias]]` links stayed
  permanently unresolved; Notion links to pages outside the vault were left as broken wikilinks;
  URL-form page links produced self-aliasing `[[X|X]]`; and relative `/p/<id>` links were dropped
  entirely. Out-of-vault targets are now kept as clickable `notion.so` links that become real
  wikilinks once the page enters the vault.
- **The CLI no longer swallows failures as exit 0 (R11-C).** Automation could not tell a failed
  sync from a successful one.
- **DB-mode change detection scanned only the first data source (R11-A).** Databases with multiple
  data sources silently missed remote edits.
- **Discovery is deterministic again (R12-A, R12-B).** A shared stopwatch made the discovered page
  set vary between runs, and the search fallback swallowed parent-resolution failures.
- **Column width ratios survive push (P10)**, instead of resetting to an even split every time.
- **Same-title pages no longer overwrite each other during pull (P9).**
- **Empty columns are preserved (R8)** — a 3-column layout with a blank middle stays 3 columns.

### ✨ Added

- **`lintRenderedMarkdown`** is exported from `@im-nobsidian/core` (new `audit/` module). The
  render rules that used to live only in the test tree now ship in the product, so the E2E harness
  lints an entire vault with the same rules the corpus gate uses. The test tree re-exports rather
  than redeclares — one rule, one place.
- **`nobsi verify`** cross-checks pages as well as database rows (R12-C), and gained a DB
  completeness gate with `--json` output for CI (R11-B).
- **`advanced.mediaDownloadTimeoutMs`** and **`advanced.itemTimeoutMs`** config knobs.
- **Live invariant I13** plus new drift metrics for code-block boundaries (P11) and column ratios
  (P10).

### ✅ Quality

- **1,662 unit tests** passing (11 skipped) and **15 live invariant cases** across 10 files against
  a real Notion workspace; lint / typecheck / format / build clean.
- **Clean-slate full E2E on a 1,268-note real vault.** The vault was deleted and rebuilt from
  `init`: full pull produced **1,268 notes / 0 failures** (343 pages + 925 database rows, 166
  `.base` files, 1,338 attachments, 836 images, 530 resolved links). Integrity **CLEAN**; verify
  matched **925 = 925** rows and **343 = 343** pages; re-pull, push and bidirectional sync all
  reported **churn-0**; round-trip lossless.
- **Render audit on the produced vault: 1,268 notes scanned, 0 defects.** Toggle-specific audit:
  **910 toggle callouts across 115 notes**, 512 toggle headings, **794 code blocks and 373 table
  rows nested inside toggles**, and **zero** raw `<details>` / `<summary>` / `{toggle="true"}` /
  NFM container-tag leaks. Every candidate "empty toggle" was probed against its Notion original
  and confirmed empty upstream — **content loss: 0**.
- **120 / 120 NFM originals** compared 1:1 against the pulled notes with **0 code-block boundary
  drift**.

### ⚠️ Known limitations (unchanged from v0.3.1)

- A **soft break** (single newline) becomes a separate paragraph block in Notion — use a blank
  line for intentional splits.
- **Consecutive empty paragraphs** collapse to a single blank line; block spacing itself is
  restored on pull.
- **Note embeds** (`![[note]]`) are kept verbatim as text, so they still render in Obsidian after a
  sync, but Notion has no transclusion concept to map them to.

---

## 한국어

### 🐛 수정

- **볼트에 쓰인 마크다운이 옵시디언에서 깨져 보이던 결함 15종 (P1–P7).** 실사용 볼트 제보에서
  출발했다 — 토글이 회색 코드블록으로, 표가 파이프 조각으로, 콜아웃이 적색 "알 수 없는
  콜아웃" 오류로 보이던 문제. 원인은 Notion NFM 컨테이너(`<details>`, `<callout>`,
  `<columns>`, 토글 헤딩)를 푸는 방식에 있었다 — 콜아웃 본문 4칸 들여쓰기가 들여쓴 코드로
  잡히고, 컨테이너 태그가 그대로 글자로 새고, `{toggle="true"}` 헤딩 속성이 제목에 노출되고,
  표 구분행이 헤더와 분리돼 고아가 되고, 코드펜스가 홀수로 남을 수 있었다. 실 워크스페이스
  **NFM 원본 120건**을 회귀 오라클로 세웠다.
- **코드 내용이 문서를 통째로 삼키던 문제 (P11).** 펜스 블록의 _내용_ 안에 경계 펜스와 같은
  길이 이상의 백틱 런이 있으면 블록이 거기서 끝나 버려 이후 본문 전체가 코드로 재파싱됐다 —
  최악 사례는 **본문 8,200행**이 회색 상자 하나가 된 것이다. 이제 내용 속 최장 런보다 한 틱
  넓은 경계 펜스를 쓴다(CommonMark 규정).
- **볼트에서 지운 DB 행이 되살아난다 (R13).** 행 루프는 원격 `last_edited_time` 이 그대로면
  **로컬 파일이 있는지 묻지도 않고** 건너뛰었고, 오케스트레이터의 복원 경로는 "행은
  database-syncer 가 이미 판정한다"는 전제로 db-row 를 일부러 제외했다. 양쪽 다 상대가 한다고
  믿어 아무도 안 했다. 복원은 이제 갱신과 따로 센다(`DatabaseSyncResult.restored`) — 합쳐 세면
  멱등성·dry-run 게이트가 "원격이 바뀌었다"고 거짓말한다.
- **rate limit 아래에서 pull 이 멈추던 문제 (R9c).** 재시도 백오프가 **rate limit 슬롯을 쥔
  채** 잠들어 스로틀 하나가 큐 전체를 얼렸다. 이제 슬롯 밖에서 대기하고 재시도마다 로그를
  남겨 느린 pull 과 멈춘 pull 을 구분할 수 있다.
- **`Retry-After` 반영 (R9d).** 헤더를 엉뚱한 객체에서 읽어 한 번도 적용된 적이 없었다.
- **모든 네트워크 경로에 시간 상한 (R9a·R9e·R9f).** 첨부 다운로드는 타임아웃이 아예 없었고,
  DB 행과 첨부에는 페이지에만 있던 항목별 상한이 빠져 있었다.
- **링크 미해소 4종 봉합 (R10-A–D).** 별칭 달린 `[[notion:<id>|별칭]]` 이 영영 미해소로
  남던 문제, 볼트 밖 Notion 페이지 링크가 끊긴 위키링크가 되던 문제, url 형 페이지 링크가
  `[[X|X]]` 자기별칭을 만들던 문제, 상대 `/p/<id>` 링크가 통째로 사라지던 문제. 볼트 밖 대상은
  클릭 가능한 `notion.so` 링크로 남아, 그 페이지가 볼트에 들어오면 진짜 위키링크가 된다.
- **CLI 가 모든 실패를 종료코드 0 으로 삼키던 문제 (R11-C).** 자동화가 실패한 동기화를 성공과
  구분할 수 없었다.
- **DB 모드 원격 변경 감지가 1차 data source 만 훑던 문제 (R11-A).** data source 가 여럿인
  DB 는 원격 수정을 조용히 놓쳤다.
- **디스커버리가 다시 결정론적이다 (R12-A·R12-B).** 스톱워치 하나를 공유해 실행마다 발견되는
  페이지 집합이 달라지던 문제, search 폴백이 부모 해소 실패를 침묵으로 삼키던 문제.
- **칼럼 너비 비율이 push 마다 균등 분할로 리셋되던 문제 (P10).**
- **동명 페이지 pull 이 서로를 덮어쓰던 경합 (P9).**
- **빈 칼럼 보존 (R8)** — 가운데가 빈 3열 레이아웃이 왕복해도 3열로 남는다.

### ✨ 추가

- **`lintRenderedMarkdown`** 을 `@im-nobsidian/core` 에서 export(신설 `audit/` 모듈). 테스트
  트리에만 있던 렌더 규칙을 출하 코드로 옮겨, E2E 하니스가 코퍼스 게이트와 **같은 잣대**로
  볼트 전량을 린트한다. 테스트 쪽은 재선언이 아니라 재수출한다 — 규칙 하나에 자리 하나.
- **`nobsi verify`** 가 DB 행뿐 아니라 페이지까지 대조하고(R12-C), CI 용 `--json` 출력이 있는
  DB 완결성 게이트를 갖췄다(R11-B).
- **`advanced.mediaDownloadTimeoutMs`**, **`advanced.itemTimeoutMs`** 설정 추가.
- **라이브 불변식 I13** 및 코드블록 경계 드리프트(P11)·칼럼 비율 드리프트(P10) 지표 신설.

### ✅ 품질

- **단위 테스트 1,662개 통과**(11 skip), 실 Notion 워크스페이스 대상 **라이브 불변식 10파일
  15케이스** 통과; lint / typecheck / format / build 클린.
- **1,268노트 실볼트 clean-slate 전량 E2E.** 볼트를 완전히 지우고 `init` 부터 재구성 — full
  pull 이 **1,268노트 / 실패 0**(페이지 343 + DB 행 925, `.base` 166, 첨부 1,338, 이미지 836,
  링크 해소 530) 생성. 무결성 **CLEAN**, verify 행 **925 = 925**·페이지 **343 = 343** 일치,
  re-pull·push·양방향 sync 전부 **churn-0**, 왕복 무손실.
- **산출 볼트 렌더 감사: 1,268노트 스캔 · 결함 0건.** 토글 전용 실측 — **115노트에 토글 콜아웃
  910개**, 토글 헤딩 512개, **토글 안에 중첩된 코드블록 794개·표 행 373개**, 원시 `<details>` /
  `<summary>` / `{toggle="true"}` / NFM 컨테이너 태그 누수 **0**. "빈 토글" 후보는 전건 Notion
  원본과 대조해 원본에서도 비어 있음을 확인 — **내용 소실 0**.
- **NFM 원본 120 / 120** 을 pull 결과와 1:1 대조, 코드블록 경계 드리프트 **0**.

### ⚠️ 알려진 제한 (v0.3.1과 동일)

- **Soft break**(단일 개행)는 Notion에서 별도 문단 블록이 된다 — 의도적 분리는 빈 줄로.
- **연속 빈 문단**은 1개로 정규화된다; 블록 간격 자체는 pull 시 복원된다.
- **노트 임베드**(`![[노트]]`)는 글자 그대로 보존돼 동기화 후에도 옵시디언에서 렌더되지만,
  Notion 에는 대응하는 transclusion 개념이 없다.

---

## Install / Upgrade

Requires **Node.js 22.13+**. API-compatible with v0.3.1 — no config or workflow changes needed;
the two new `advanced.*` timeouts have safe defaults.

```bash
# CLI
npm install -g im-nobsidian@0.3.2

# Core (library)
npm install @im-nobsidian/core@0.3.2
```

Obsidian plugin: update via BRAT, or copy `main.js` / `manifest.json` / `styles.css` from the
`0.3.2` release into `.obsidian/plugins/im-nobsidian/`.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
