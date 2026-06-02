# Im-Nobsidian v0.2.0

> **Release date:** 2026-06-02
> **Focus:** "100% lossless · idempotent · convergent" sync.
> Round-trip deep-equal fidelity (I1) and an invariant safety net (drift / idempotency /
> deletion) are now permanently locked in CI; lossless push extends to blockquotes, numbered
> lists, underline/color, breadcrumb/TOC and DB sidecars; and conversion canonicalization (I3),
> incremental idempotency (I5/I10) and nested-cascade runaway guards (#72/#73) eliminate the
> remaining data-loss paths.

---

## English

### ✨ Added

- **Fidelity measurement infrastructure.** A body-link classifier plus an idempotency audit
  runner and round-trip deep-equal verification (I1) lock regressions permanently in CI (#77).
- **Invariant safety net.** Drift / idempotency / deletion invariants are enforced as
  infrastructure, and `deleteSync=false` deletion counts are now reported honestly.
- **DB sidecar `.notion.json`.** Views and metadata that have no Obsidian representation are
  preserved losslessly alongside each database (#45·#33, I4·I7).
- **Offline block round-trip lock (I2)** with lossless push of blockquotes and numbered lists.
- **Inline underline / color** now push losslessly (#47).
- **breadcrumb / TOC blocks** restored via single-line markers on push.
- **Frontmatter wikilink restoration** (I3).
- **Dead-table activation** — attachment dedup (I6) and crash-recovery WAL (I12).

### 🐛 Fixed — Conversion canonicalization (I3)

- **Mention canonical form.** Both mention paths now converge on `[[notion:<32hex>]]`.
- **PreserveMarkerInjector** restores markers at their original `startIndex` position.
- **File-hosted images** accept video/embed-promoted URLs.
- **Inline span/color markers** unified to a single canonical form.
- **rich-text conversion split out**; unhandled mentions keep their `plain_text`.
- Page-mode pull **relation/people resolver wired** (M1).
- Title **brackets no longer truncate a wikilink early** (M5).
- Labeled **mention-page breadcrumbs are wikilinked** (M6).
- Pull link-resolution fidelity (M2/M3/M4 + cover-URL + relation).

### 🐛 Fixed — Idempotency & convergence

- **Incremental deletion propagation** (I10) + **`content_hash` idempotency** (I5).
- **Multi data-source lossless merge** — rows/columns from every source are synced (I4).
- **Conflict resolution re-pushed to Notion** + `notionLastEdited` reconciled (I8).
- **Search pagination dedup** — root-fixes orphans, folder-note mis-placement and push churn.
- **Folder-note fixpoint violation** — `resolveNotionLinks` hash sync + child-page delete guard.
- **DB-row 8-char prefix collision** data loss + permanent churn eliminated (defect 11).
- Frontmatter loss when a body **starts with `---`** fixed.

### 🐛 Fixed — Cascade runaway & robustness

- **Toggle/callout code-fence cascade** stopped via asymmetric-indent dedent (#72).
- **Nested-container prefix/tab runaway** stopped via inner-first unified conversion +
  table-aware dedent (#73).
- **Large-workspace discovery performance** — deadline recursion + search fallback, scoped to
  the root subtree (#71).
- Inaccessible linked / unshared **DBs degrade gracefully** (defect 9).
- **`extractValue` non-array property values** fully hardened (defect 10).
- DB auto-discovery fidelity — `extractTitle` crash guard + new-model fetch (defects 7·8).
- Gallery cover **multivalue degrade** — array covers collapse to the first scalar URL (rank22).
- View-entry **title/icon forced to scalar** — guards a search crash on numeric/array
  frontmatter (rank22b, I9).
- DB rename now **cleans orphan `.base`/`.notion.json`** + reflects schema evolution (rank14).

### 🔧 Changed — Build / CI

- **Root vitest workspace** now spreads the plugin's two projects (node/components), recovering
  dev CI.
- E2E harness exit-code leak fixed (`scripts/e2e/run.sh`).
- `.base` view-name uniqueness + E2E harness accuracy.

### ✅ Quality

- **1038 tests passing** (core 858 + CLI 31 + plugin 149) — **+261 over v0.1.12**.
- lint / typecheck clean, CI green on node 20 & 22.

### ⚠️ Notes

- A DB sidecar `.notion.json` is now created next to each synced database (to preserve
  unrepresentable views/metadata). Existing vaults generate it on next pull.

---

## 한국어

### ✨ 추가

- **충실도 측정 인프라.** 본문 링크 분류기 + 멱등성 감사 러너 + 라운드트립 deep-equal
  검증(I1)으로 회귀를 CI에 상시 잠근다 (#77).
- **불변식 안전망.** 드리프트 / 멱등성 / 삭제 불변식을 인프라로 강제하고,
  `deleteSync=false` 삭제 카운트를 정직하게 보고한다.
- **DB 사이드카 `.notion.json`.** Obsidian으로 표현 불가능한 뷰/메타데이터를 각 DB 옆에
  무손실 보존 (#45·#33, I4·I7).
- **오프라인 블록 라운드트립 잠금(I2)** + blockquote·번호목록 무손실 push.
- **인라인 underline/color 무손실 push** (#47).
- **breadcrumb·TOC 블록** 단일라인 마커로 push 복원.
- **frontmatter wikilink 복원** (I3).
- **데드 테이블 활성화** — 첨부 dedup(I6) + 크래시 복구 WAL(I12).

### 🐛 수정 — 변환 정본화 (I3)

- **멘션 정규형 수렴.** 두 경로를 `[[notion:<32hex>]]` 정본으로 통일.
- **PreserveMarkerInjector** — 마커를 원래 `startIndex` 위치에 복원.
- **file-hosted 이미지** — video/embed 승격 URL 수용.
- **인라인 span/color 마커** — 단일 정본으로 통일.
- **rich-text 변환 분리** + 미처리 멘션 `plain_text` 보존.
- 페이지 모드 pull **relation/people resolver 배선** (M1).
- 제목 **대괄호가 위키링크를 조기 종료**하던 문제 봉합 (M5).
- 라벨 동반형 **mention-page breadcrumb 위키링크화** (M6).
- pull 링크 해소 충실도 (M2/M3/M4 + cover-URL + relation).

### 🐛 수정 — 멱등 · 수렴

- **증분 삭제 전파**(I10) + **`content_hash` 멱등**(I5).
- **다중 data source 무손실 병합** — 전 소스의 행·컬럼 동기화 (I4).
- **충돌 해소 결과 Notion 재push** + `notionLastEdited` 재조정 (I8).
- **검색 페이지네이션 디듀프** — 고아·folder-note 위치오류·push churn 근본 수정.
- **폴더노트 fixpoint 위반** — `resolveNotionLinks` 해시 동기화 + 자식 페이지 삭제 가드.
- **DB행 8자 prefix 충돌** 데이터 손실 + 영구 churn 제거 (결함11).
- 본문이 **`---`로 시작할 때 frontmatter 유실** 수정.

### 🐛 수정 — cascade 폭주 · 견고화

- **토글/콜아웃 코드펜스 cascade** — 비대칭 들여쓰기 dedent로 차단 (#72).
- **중첩 컨테이너 prefix/탭 누적 폭주** — 내부우선 통합 변환 + 테이블 인식 dedent로 차단 (#73).
- **대용량 워크스페이스 발견 성능** — deadline 재귀 + search 폴백, root 서브트리 한정 (#71).
- 접근 불가 링크드/미공유 **DB graceful degrade** (결함9).
- **`extractValue` 비배열 속성값** 전수 하드닝 (결함10).
- DB 자동발견 충실도 — `extractTitle` 크래시 가드 + 신모델 fetch (결함7·8).
- 갤러리 커버 **multivalue degrade** — 배열 커버를 첫 URL 스칼라로 (rank22).
- 뷰 엔트리 **title·icon 스칼라 강제** — 숫자/배열 프론트매터 검색 크래시 차단 (rank22b, I9).
- DB rename 시 **고아 `.base`/`.notion.json` 정리** + 스키마 진화 반영 (rank14).

### 🔧 변경 — 빌드 / CI

- **루트 vitest 워크스페이스** — plugin 2프로젝트(node/components)를 펼쳐 dev CI 복구.
- E2E 하니스 종료코드 누수 수정 (`scripts/e2e/run.sh`).
- `.base` 뷰 이름 유일성 + E2E 하니스 정확도 개선.

### ✅ 품질

- **테스트 1038개 통과** (core 858 + CLI 31 + plugin 149) — **v0.1.12 대비 +261**.
- lint / typecheck 클린, CI(node 20·22) GREEN.

### ⚠️ 참고

- 각 동기화 DB 옆에 사이드카 `.notion.json`이 새로 생성된다(표현 불가 뷰/메타 보존용).
  기존 볼트는 다음 pull 시 자동 생성.

---

## Install / Upgrade

```bash
# CLI
npm install -g nobsi@0.2.0

# Core (library)
npm install @im-nobsidian/core@0.2.0
```

Obsidian plugin: update via the plugin manager, or copy `main.js` / `manifest.json` /
`styles.css` from the `0.2.0` release into `.obsidian/plugins/im-nobsidian/`.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
