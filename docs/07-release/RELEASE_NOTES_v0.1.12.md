# Im-Nobsidian v0.1.12

> **Release date:** 2026-05-29
> **Focus:** Notion → Obsidian pull fidelity & sync stability.
> Nested databases now reproduce faithfully as Obsidian Bases, gallery cover images
> actually render, and many data-loss paths in push/pull convergence, conflict merge,
> and watch-mode incremental sync are eliminated.

---

## English

### ✨ Added

- **Nested DB → folder + `.base` auto-generation.** Database references found in page
  bodies (`<database>` markers) are now recursively materialized as a child folder, an
  Obsidian Bases view (`.base`), and per-row frontmatter — with markdown-tag-based
  discovery merged in.
- **Pull pipeline worker pool.** Backpressure + parallel retry stabilizes pulling large
  vaults.
- **Config / constants SSOT.** Scattered settings unified into a single source of truth;
  un-wired options cleaned up (Phase 1).

### 🐛 Fixed — Pull fidelity

- **Gallery cover images now render.** Root cause: Notion `views.retrieve` returns _raw_
  property ids (e.g. `[jiM`) while `databases.retrieve` returns _URL-encoded_ ids
  (e.g. `%5BjiM`). The id mismatch made every non-`title` property (cover / visible
  columns / sort / group) fail to resolve, so gallery cards came up blank. Fixes:
  - Decode both sides before matching property ids.
  - Serialize `files` properties as a **scalar URL string** (the only form Obsidian Bases
    `image:` will render — it ignores `[{name,url}]` object arrays).
  - Drop the empty `title` column from view order.
  - Add `file.ext == "md"` filter so the `.base` file itself no longer shows as a blank
    card.
- **Inline page links resolved.** `/p/<id>?pvs=` page mentions are converted to wikilinks.
- **embed / bookmark round-trip.** URL-based unknown blocks are preserved losslessly as
  clickable links plus a preserve marker.

### 🐛 Fixed — Sync stability

- Wikilink push data-loss fixed; push ↔ pull convergence guaranteed.
- DB pull now **preserves local edits** instead of blind-overwriting (Phase 2-A).
- DB push **partial-failure recovery** — no more false `synced` state when body push fails
  (Phase 2-B).
- DB file **rename no longer creates a duplicate** Notion page (Phase 2-C).
- 3-way merge accuracy — LCS-based diff3 rewrite removes false conflicts (Phase 3).
- Property-mapper round-trip fidelity — stops sending wrong values (Phase 2b).
- 4 watch-mode incremental-sync consistency fixes.
- Push-path atomicity / partial-failure recovery hardened.
- Trash & archived pages excluded from sync; broken subtrees skipped gracefully.
- Bases sort key corrected (`column` → `property`); property-reference YAML quoting made
  robust.
- `wikilink_map` freshness guaranteed.

### ⚡ Performance

- **~21× faster first full pull** — block traversal replaced with the Notion search API.

### 🔧 Changed

- Sync logic extracted into `SyncController` for UI-independence.

### ✅ Quality

- 777 tests passing (core 615 + CLI 31 + plugin 131).
- lint / typecheck clean.
- Real-data E2E — Im-Nobsidian-Test vault: fresh pull of 138 notes / 449 attachments,
  gallery cover-image render verified across 12 rows.

### ⚠️ Notes

- DB `files` properties used for gallery covers are now stored as **URL strings** instead
  of `[{name,url}]` object arrays (round-trip compatible). Existing vaults auto-update on
  next pull.

---

## 한국어

### ✨ 추가

- **중첩 DB → 폴더 + `.base` 자동 생성.** 페이지 본문의 데이터베이스 참조(`<database>`
  마커)를 발견해 하위 폴더 + Obsidian Bases 뷰(`.base`) + row별 프론트매터로 재귀
  생성한다. 마크다운 태그 기반 발견도 함께 병합.
- **Pull 파이프라인 워커 풀.** 백프레셔 + 병렬 재시도로 대용량 볼트 pull 안정화.
- **설정 / 상수 SSOT 중앙화.** 흩어진 설정을 단일 소스로 통합, 미배선 옵션 정리 (Phase 1).

### 🐛 수정 — Pull 충실도

- **갤러리 커버 이미지가 실제로 렌더된다.** 근본 원인: Notion `views.retrieve`는 _raw_
  속성 id(예: `[jiM`)를, `databases.retrieve`는 _URL-인코딩_ id(예: `%5BjiM`)를 준다.
  이 불일치로 `title` 외 모든 속성(커버 / 표시 컬럼 / 정렬 / 그룹)이 매칭에 실패해 갤러리
  카드가 통째로 비어 있었다. 수정 내용:
  - 속성 id 비교 전 양쪽 모두 디코드.
  - `files` 속성을 **스칼라 URL 문자열**로 직렬화 (Obsidian Bases `image:`가 렌더하는
    유일한 형태 — `[{name,url}]` 객체 배열은 무시된다).
  - 뷰 순서에서 빈 `title` 컬럼 제거.
  - `file.ext == "md"` 필터 추가 — `.base` 파일 자신이 빈 카드로 표시되던 문제 해결.
- **인라인 페이지 링크 해결.** `/p/<id>?pvs=` 페이지 멘션을 위키링크로 변환.
- **embed / bookmark 라운드트립.** URL 기반 unknown 블록을 클릭 가능한 링크 + 보존
  마커로 무손실 보존.

### 🐛 수정 — 동기화 안정성

- 위키링크 push 데이터 손실 수정 + push ↔ pull 수렴 보장.
- DB pull 시 무조건 덮어쓰기 대신 **로컬 수정 보존** (Phase 2-A).
- DB push **부분 실패 복구** — 본문 push 실패 시 거짓 `synced` 상태 제거 (Phase 2-B).
- DB 파일 **rename 시 중복 Notion 페이지 생성 차단** (Phase 2-C).
- 3-way 병합 정확도 — LCS 기반 diff3 재작성으로 거짓 충돌 제거 (Phase 3).
- 속성 매퍼 라운드트립 충실도 — 잘못된 값 전송 방지 (Phase 2b).
- watch 증분 동기화 정합성 4건 수정.
- Push 경로 원자성 / 부분 실패 복구 강화.
- 휴지통·보관 페이지 동기화 제외; 깨진 서브트리 graceful skip.
- Bases 정렬 키 교정(`column` → `property`); 속성 참조 YAML 인용 견고화.
- `wikilink_map` 최신성 보장.

### ⚡ 성능

- **첫 pull 전체 스캔 ~21배 가속** — 블록 순회 → Notion search API 기반으로 교체.

### 🔧 변경

- 동기화 로직을 `SyncController`로 분리해 UI 비종속화.

### ✅ 품질

- 테스트 777개 통과 (core 615 + CLI 31 + plugin 131).
- lint / typecheck 클린.
- 실데이터 E2E — Im-Nobsidian-Test 볼트: 138 노트 / 449 첨부 fresh pull,
  갤러리 12 row 커버 이미지 렌더 검증.

### ⚠️ 참고

- 갤러리 커버용 DB `files` 속성은 이제 `[{name,url}]` 객체 배열이 아닌 **URL 문자열**로
  저장된다(라운드트립 호환). 기존 볼트는 다음 pull 시 자동 갱신.

---

## Install / Upgrade

```bash
# CLI
npm install -g im-nobsidian@0.1.12

# Core (library)
npm install @im-nobsidian/core@0.1.12
```

Obsidian plugin: update via the plugin manager, or copy `main.js` / `manifest.json` /
`styles.css` from the `0.1.12` release into `.obsidian/plugins/im-nobsidian/`.

**Full changelog:** [`docs/06-devlog/CHANGELOG.md`](../06-devlog/CHANGELOG.md)
