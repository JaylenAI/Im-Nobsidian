---
type: report
title: "불변식 I1~I12 커버리지 매트릭스 (이원 도달성)"
created: 2026-05-30
updated: 2026-05-30
status: draft
tags: ["project/im-nobsidian", "type/coverage", "sync/fidelity"]
related: ["[[SYNC_FIDELITY_GOAL]]"]
summary: "I1~I12 + 드리프트 불변식의 자동테스트·이원 도달성(오프라인 결정론 / 라이브 Notion) 매핑과 완료조건 체크리스트. /goal 종료 전 사용자 승인용 SSOT."
---

# 불변식 커버리지 매트릭스 — 이원 도달성

> [[SYNC_FIDELITY_GOAL]] 의 **완료 조건 #4(커버리지 이원화)** 와 진척 보고 형식 #4(불변식
> 커버리지표)를 충족하기 위한 단일 표. **라이브 수치 셀은 머지 후 전체 스위트·불변식 스위트
> 재실행으로 채운다**(거짓 GREEN 방지 — 추정 기입 금지).

## A. 완료 조건 체크리스트 (SYNC_FIDELITY_GOAL §완료 조건)

| #   | 조건                                                                                | 상태         | 근거                                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 불변식 I1~I12 자동테스트가 **골든 코퍼스 전체**에서 GREEN                           | 🟢 GREEN     | B절 매핑 전부 충족 — 오프라인 907 pass / 11 skip + **라이브 13/13 GREEN**(실 Notion, 2026-05-30)                                                                                             |
| 2   | 드리프트/멱등성/삭제 스크립트 clean (diff 0·churn 0·resurrection 0)                 | 🟢 clean     | D절 — drift==empty·idempotency 수렴(churn 0)·deletion resurrection 0 + E2E repull/pushdry churn 0 (실측)                                                                                     |
| 3   | 회귀 0 (기준 777+), lint/typecheck 클린, skip baseline(11) 불증가·불변식 skip 0     | 🟢 GREEN     | **오프라인 합계 907 pass / 11 skip** (core 727+11, cli 31, plugin 149) — 기준 777+ 충족·skip baseline 동일(불변식 무력화 skip 0). typecheck 클린(3패키지)·lint 클린(2026-05-30, dev 머지 후) |
| 4   | 커버리지 이원화(도달 가능=실노트, 도달 불가=합성 픽스처) **사용자 승인 1회로 잠금** | ⏳ 승인 대기 | C절 분류표 — 사용자 승인 필요(유일 잔여 게이트)                                                                                                                                              |

## B. 불변식 → 자동테스트 → 이원 도달성

> **오프라인** = 토큰 불필요 결정론 테스트(픽스처 기반, CI 상시).
> **라이브** = `skipIf(SKIP)` 게이트, 실 Notion(TOKEN+ROOT_PAGE_ID) 필요. 격리 페이지 생성·archive.

| 불변식                               | 오프라인 결정론 테스트                                                                                                                                      | 라이브 Notion 테스트                                                                 | 비고                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------- |
| **I1** MD 라운드트립 deep-equal      | `converter/roundtrip-fidelity.test.ts`, `converter/roundtrip.test.ts`                                                                                       | `invariants/block-roundtrip.invariant.test.ts`, `invariants/drift.invariant.test.ts` | 부분문자열 금지·전체 deep-equal   |
| **I2** Notion 라운드트립             | `converter/block-converter.test.ts`, `converter/roundtrip.test.ts`                                                                                          | `invariants/block-roundtrip.invariant.test.ts`                                       | 속성/블록/순서/span 보존          |
| **I3** 무손실(블록·속성·인라인 span) | `converter/rich-text-converter.test.ts`, `converter/processors.test.ts`, `converter/preserve-marker-injector.test.ts`, `converter/callout-restorer.test.ts` | `invariants/block-roundtrip.invariant.test.ts`                                       | 개수 delta=0, 인라인 매트릭스     |
| **I4** DB 충실도·스키마 진화         | `view/sidecar-generator.test.ts`†, `view/base-file-generator.test.ts`, `view/filter-engine.test.ts`, `view/view-data-provider.test.ts`                      | E2E `analyze`/`repull`(DB 폴더 드리프트 0)                                           | 미표현 뷰 = 사이드카+degrade 로그 |
| **I5** 멱등성 non-trivial fixpoint   | `sync/compute-patches.test.ts`                                                                                                                              | `invariants/idempotency.invariant.test.ts` (3)                                       | 1회차 N>0 단언 → 2회차 0          |
| **I6** 첨부 content_hash·중복0       | `sync/image-handler.test.ts`                                                                                                                                | `invariants/attachment.invariant.test.ts`                                            | signed URL 변동 무시              |
| **I7** Bases 렌더·degrade 보존       | `view/sidecar-generator.test.ts`†, `view/base-file-generator.test.ts`, `view/color-map.test.ts`                                                             | E2E pull 산출 `.base`/`.notion.json` 검증                                            | 잃는 뷰설정 frontmatter 보존      |
| **I8** 충돌 3-way·false-conflict 0   | `conflict/merger.test.ts`, `conflict/resolver.test.ts`, `sync/conflict-detector.test.ts`, `sync/conflict-integration.test.ts`‡                              | — (3-way는 결정론, 라이브 불필요)                                                    | base 스냅샷 비-null 왕복·루프 0   |
| **I9** UIUX 뷰 충실 렌더             | `obsidian-plugin/tests/views/*.test.ts`‡ (table/gallery/list/dashboard)                                                                                     | — (happy-dom 마운트, 결정론)                                                         | 진행률/에러/충돌 일관 표시        |
| **I10** 삭제 전파·resurrection 0     | `sync/change-detector.test.ts`(삭제 감지)                                                                                                                   | `invariants/deletion.invariant.test.ts` (2)                                          | in_trash 부활 차단                |
| **I11** 구조 제약 무손실 push        | `converter/pipeline.test.ts`(평탄화)                                                                                                                        | `invariants/deep-nesting.invariant.test.ts`                                          | 100블록·2단계 한계 우회           |
| **I12** 크래시 복구·중복 append 0    | `state/`·`sync/orchestrator.test.ts`(pending_operations)                                                                                                    | `invariants/crash-resume.invariant.test.ts` (2)                                      | 429 재시도 멱등 사전조회          |
| **드리프트** fixpoint 비트동일       | —                                                                                                                                                           | `invariants/drift.invariant.test.ts`                                                 | pull→push→pull diff empty         |

† I4/I7 사이드카 테스트는 `feature/i4-i7-view-fidelity` (7c9afcf·56fe9c2) — **dev 머지 완료**(2026-05-30, --no-ff). db-fidelity 라이브 불변식 동반.
‡ I8/I9 통합·UIUX 테스트는 `feature/i8-i9-integration-tests` (412f4a5·8ec37ce) — **dev 머지 완료**(2026-05-30, --no-ff).

**라이브 불변식 스위트 합계:** 8 파일 / **13 케이스**(attachment 1·block-roundtrip 1·crash-resume 2·db-fidelity 2·deep-nesting 1·deletion 2·drift 1·idempotency 3), 전부 `skipIf(SKIP)`. **재실행 결과 13/13 GREEN**(실 Notion, 2026-05-30).

## C. 이원 도달성 타입 분류 (★ 사용자 승인 1회 필요)

> 완료 조건 #4. **도달 가능** = Notion API/플랜으로 생성 가능 → 골든 코퍼스에 실노트로 포함.
> **도달 불가** = API/현 플랜으로 생성·재현 불가 → 사유 명시 + 고정 JSON 합성 픽스처로 변환 경로만 검증.

### C-1. 도달 가능 (실노트 — 골든 코퍼스 **1,153 노트 / 90 DB / 724+ 첨부**에 포함)

- **블록:** paragraph, heading 1/2/3, bulleted/numbered/to_do, toggle, quote, callout, code,
  equation, divider, table, column_list/column, child_page, child_database, embed, bookmark,
  image, video, file, pdf, audio, mention, breadcrumb, table_of_contents.
- **속성:** title, rich_text, number, select, multi_select, status, date(범위), people, files,
  checkbox, url, email, phone_number, relation, rollup, formula, created_time, last_edited_time,
  created_by, last_edited_by, unique_id.
- **인라인:** bold/italic/strikethrough/code/underline/color/link/inline-equation/inline-mention
  (한 문장 조합·겹침).
- **엣지:** 빈 값·유니코드/이모지·초장문·깊은 중첩(토글>column>list)·100블록 초과·동명 페이지·
  특수문자 파일명·빈 DB.

### C-2. 도달 불가 (합성 픽스처 — 사유 명시)

| 타입                           | 도달 불가 사유                                           | 검증 방식                                  |
| ------------------------------ | -------------------------------------------------------- | ------------------------------------------ |
| `verification` 속성            | API로 생성/설정 불가(엔터프라이즈 워크플로 전용)         | 고정 JSON 픽스처 → 변환 경로·preserve 마커 |
| cross-workspace `synced_block` | 타 워크스페이스 원본 참조는 단일 통합 토큰으로 생성 불가 | 고정 JSON 픽스처 → 참조 보존 마커          |
| 일부 `link_preview`            | 외부 OAuth 통합 의존(임의 생성 불가)                     | 고정 JSON 픽스처 → 링크+보존 마커          |

> **이 분류(C-1/C-2)를 사용자 승인 1회로 잠근다.** 승인 후 normalize 화이트리스트·분류 변경은
> 재승인 필요(silent drop의 정규화 위장 차단).

## D. 드리프트/멱등성/삭제 스크립트 — 실행 결과 (재실행 후 기입)

| 스크립트 | 명령                                                | 기대                         | 실측                                                                                        |
| -------- | --------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------- |
| 드리프트 | `invariants/drift.invariant.test.ts`                | added/changed/removed = 0    | 🟢 drift==empty (PASS)                                                                      |
| 멱등성   | `invariants/idempotency.invariant.test.ts`          | 1회차 N>0 → 2회차 0, churn 0 | 🟢 재-push 0·1글자→정확히 1 updated·fixpoint 수렴 (3/3 PASS)                                |
| 삭제     | `invariants/deletion.invariant.test.ts`             | archive 멱등·resurrection 0  | 🟢 archive 멱등+resurrection 0·비파괴 보존 (2/2 PASS)                                       |
| E2E 풀   | `scripts/e2e/run.sh` (golden **1,165노트 / 90 DB**) | repull churn 0·analyze CLEAN | 🟢 **전체 통과**(2026-05-30): pull 1,165 / analyze CLEAN / repull 멱등(0) / pushdry 멱등(0) |

---

**다음 단계(머지·재실행 순서):**

1. E2E green 확인 → `feature/i4-i7-view-fidelity` → dev 로컬 머지(#45·#33 종료).
2. `feature/i8-i9-integration-tests` → dev 로컬 머지(#34 종료).
3. dev 에서 `pnpm typecheck && pnpm lint && pnpm exec vitest run`(전체 합산·회귀 0 확인) + 라이브
   불변식 스위트 실행 → A·B·D절 라이브 셀 확정.
4. C절 분류표 사용자 승인 → 완료 조건 #4 잠금.
5. 모든 셀 GREEN + 사용자 확인 시 /goal 종료 + 릴리스 후보 제안.
