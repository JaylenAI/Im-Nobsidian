# 현재 진행 상황

> 마지막 업데이트: 2026-06-03
> 버전: v0.2.1 (문서 최신화 패치, 태그 대기) · 마지막 정식 릴리스 v0.2.0

## 현재 미션 — 동기화 충실도 회복 (`/goal`)

**목표:** 실데이터 복잡 코퍼스에서 Notion↔Obsidian 왕복을 무손실·멱등(churn 0)·fixpoint 수렴으로 만든다. v0.1.12 롤백 대신 전진 수정 확정(ADR-007).

**6-Phase 로드맵:**

| Phase | 범위                                                           | 분기                                | 상태                           |
| ----- | -------------------------------------------------------------- | ----------------------------------- | ------------------------------ |
| 1     | Frontmatter/Relation 충실도 (M2/M3/M4 + cover-URL + relation)  | `fix/pull-resolution-fidelity`      | ✅ dev 머지 완료               |
| 2     | P0 relation 잔여 봉합 (M1 페이지모드 resolver + M5 대괄호)     | `fix/p0-relation-residual`          | ✅ dev 머지 완료               |
| 3     | 본문 컨테이너 1급화 (#74, UX/시각 트랙 — 데이터는 이미 무손실) | `feature/body-container-firstclass` | ⏸ v1.0.0 이연 (데이터 무손실)  |
| 4     | DB↔Bases 인라인 임베드 (#75)                                   | `feature/inline-db-bases`           | ⏸ v1.0.0 이연                  |
| 5     | 충실도 측정 인프라 (#77) + 라이브 전수 검증 (fresh E2E)        | `feature/fidelity-metrics`          | ✅ dev 머지 완료 (858 테스트)  |
| 6     | dev→main 릴리스 + v0.2.0 태그 (#78)                            | `docs/release-v0.2.0`               | ✅ 완료 (릴리스·태그·npm 배포) |

> **P0 추가 봉합 — M6 (`fix/mention-page-labeled`, cf08b19):** Phase 2 의 P0 relation 잔여
> 중 마지막 한 형태(라벨 동반 `<mention-page url>제목</mention-page>` breadcrumb 미변환).
> `convertPageMentions` 통합 정규식으로 self-closing·라벨형 둘 다 `[[notion:id]]` 환원.

**Phase 1 (2026-06-02):** M2(디스커버리 조기반환의 링크 후처리 누락)·M3(후처리 대상
슬라이스 추정→실측)·M4(단일/후처리 패스 위키링크 불일치)·cover-URL(원격 URL 오래핑)
봉합 + relation 후처리 배선. 회귀 테스트 15건 추가, **836 테스트 통과**.
상세: `journal/2026-06-02.md`, `adr/007-fix-forward-vs-rollback.md`.

**Phase 2 (2026-06-02):** M1(페이지 모드 pull 의 relation/people 이 resolver 미주입으로
매 pull 마다 raw UUID 로 재생성 → 후처리에만 의존하는 2-write churn) 봉합 — orchestrator 가
단일 resolver 를 `propertyMapper` 와 `notionClient` 양쪽에 주입(DB 모드는 이미 면역).
M5(제목의 대괄호 `[`/`]` 가 `[[..]]` 위키링크를 첫 `]]` 에서 조기 종료시켜 깨진 링크 생성)
봉합 — 파일명 SSOT `sanitizeFileName` 에서 대괄호를 `_` 로 치환(원본 제목은 frontmatter
`title` 에 보존되어 무손실). 회귀 테스트 7건 추가(M1 4 + M5 3), **843 테스트 통과**.
상세: `journal/2026-06-02.md`.

**M6 + Phase 4 (2026-06-02):** M6(라벨 동반형 `<mention-page url>제목</mention-page>`
breadcrumb 미변환 잔류, 실코퍼스 2건) 봉합 — `convertPageMentions` 통합 정규식으로
self-closing·라벨형을 모두 `[[notion:id]]` 환원(회귀 3건). Phase 4(#77) **충실도 측정
인프라** 정식화 — `audit/fidelity.ts` 순수 분류기(보존마커/외부/자기참조/결함) +
`scripts/audit-vault.mjs` 러너(충실도+멱등성+누락 1회 측정, 위반 시 exit 1)로 임시
스크립트 대체(회귀 12건). **858 테스트 통과.** 부수 성과: fresh pull `[N/241]` 오독에서
출발한 디스커버리 포렌식으로 subtree·search 양 경로가 동일 무손실(241 발견 + 918 DB행
side-effect = 1159)임을 확정 — 버그 아님. 백업 실측: 1159 파일 / 보존마커 414 / 외부 36 /
자기참조 1 / 결함 2 / churn-0. 상세: `journal/2026-06-02.md §8`.

---

## 전체 상태 (릴리스 이력)

**v0.2.0 릴리스 완료(npm 배포·EN/KR 노트 등록) + v0.2.1 문서 최신화 패치 진행.** 무손실·멱등·수렴 미션 봉합 — 충실도 측정 인프라(I1) + 불변식 안전망, 무손실 push 확장, 변환 정본화(I3). 1038 테스트.

| 항목                     | 상태                                          |
| ------------------------ | --------------------------------------------- |
| npm `@im-nobsidian/core` | v0.2.0 배포 완료 (→ v0.2.1 태그 시 갱신)      |
| npm `im-nobsidian` (CLI) | v0.2.0 배포 완료 (→ v0.2.1 태그 시 갱신)      |
| GitHub Release           | v0.2.0 tagged + EN/KR 노트 등록 (v0.2.1 대기) |
| Obsidian Plugin          | v0.2.1 (BRAT 설치 가능, 커뮤니티 제출 예정)   |

## Phase 진행률

| Phase   | 설명                        | 상태    | 진행률 |
| ------- | --------------------------- | ------- | ------ |
| Phase 1 | IStateDB 인터페이스 분리    | ✅ 완료 | 100%   |
| Phase 2 | sql.js WASM 어댑터          | ✅ 완료 | 100%   |
| Phase 3 | 커뮤니티 플러그인 심사 요건 | ✅ 완료 | 100%   |
| Phase 4 | 사이드바 + 리본 + UI        | ✅ 완료 | 100%   |
| Phase 5 | DB 뷰 고급 + 양방향 감지    | ✅ 완료 | 100%   |
| Phase 6 | Notion DB → .base 자동 생성 | ✅ 완료 | 100%   |
| Phase 7 | 테스트 강화 115개           | ✅ 완료 | 100%   |
| Phase 8 | 빌드 최적화 + E2E + 릴리스  | ✅ 완료 | 100%   |

## 버전별 주요 성과

### v0.1.11 — 플러그인 테스트 115개 + 빌드 최적화 + Push 버그 수정 (2026-05-23)

- **플러그인 테스트 115개** — SqlJsStateDB 30+11, VaultAdapter 18, Views 17, Settings 6, Main 7, Integration 9, ConflictModal 5
- **better-sqlite3 완전 제거** — esbuild alias로 shim 대체, main.js 620KB (네이티브 참조 0건)
- **WASM 번들링 정상화** — sql-wasm.wasm 644KB 자동 복사, pnpm 호이스팅 대응
- **push 실패 수정** — `<unknown url="..."/>` 태그 보존 마커 변환 추가, 블록 변환 실패 방지
- **styles.css 테마 호환** — 하드코딩 rgba → CSS 변수, 사이드바/DB뷰/스테이터스바 스타일 추가
- **CLI E2E 실제 데이터** — 204개 파일 init→pull→push→sync→resolve 전체 플로우 검증
- 696 테스트 (Core 550 + CLI 31 + Plugin 115)

### v0.1.10 — Obsidian Bases 갤러리 커버 이미지 동기화 (2026-05-22)

- **갤러리 커버 이미지** — `page_content`/`page_content_first` 커버를 `formulas(file.embeds[0])`로 매핑
- **위키링크 커버** — `page_cover` 프론트매터를 `[[attachments/...]]` 형식으로 변환 (Bases cards 호환)
- **`.base` 업로드 방지** — Notion File Upload API 확장자 미지원 오류 수정
- **빈 DB 제목 fallback** — `??` → `||` 수정
- 581 테스트

### v0.1.9 — Obsidian 플러그인 프로덕션 레디 (2026-05-22)

- **sql.js WASM 어댑터** — better-sqlite3 대체, Obsidian에서 플러그인 정상 로드
- **IStateDB 인터페이스** — SQLite 구현체 분리 (CLI: better-sqlite3, Plugin: sql.js)
- **동기화 사이드바** — Push/Pull/Sync 버튼, % 진행률, 완료 요약, 취소 버튼
- **양방향 변경 감지** — 로컬 + Notion 원격 변경 동시 확인 (incremental API)
- **DB 뷰 6종** — Gallery, Board, Table, Calendar, List, Timeline
- **뷰 도구바** — 검색, 정렬, 새 항목 버튼
- **인라인 편집** — TableView에서 더블클릭 셀 편집
- **obsidianFetch 수정** — 바이너리 파일 다운로드 깨짐 해결
- **CLI `--full`** — 양방향 상태 확인 옵션

### v0.1.8 — 치명적 Push 버그 수정 + DB 자동발견 (2026-05-21)

- Push → Notion 미반영 치명적 버그 수정
- DB 자동발견 + 캐싱
- Stat cache 최적화
- 554 테스트

### v0.1.7 — Beautiful CLI + 데모 GIF (2026-05-20)

- chalk 기반 컬러풀 터미널 UI
- CLI 데모 GIF 8종
- README 워크플로우 배치

### v0.1.5 — DB 뷰 렌더링 + 동기화 품질 (2026-05-17~19)

- Notion Views API 연동 (Gallery/Board/Table/Calendar)
- 파일 첨부 다운로드, 자식 페이지 탐색 확장
- 커버/아이콘 추출
- 554 테스트

## 테스트 현황

- **Core 테스트**: 858개 통과
- **CLI 테스트**: 31개 통과
- **Plugin 테스트**: 149개 통과
- **전체**: 1038개 통과 (11 skip, 0 실패)
- **TypeScript 타입 체크**: 클린 (에러 0)
- **플러그인 빌드**: 620KB (better-sqlite3 제거), sql-wasm.wasm 644KB 별도

## Obsidian 플러그인 기능

| 기능                          | 상태 |
| ----------------------------- | ---- |
| 플러그인 로드 (sql.js WASM)   | ✅   |
| 설정 탭 (토큰/루트페이지)     | ✅   |
| 사이드바 대시보드             | ✅   |
| Push/Pull/Sync 버튼           | ✅   |
| 진행률 바 (%, 파일명, 취소)   | ✅   |
| 양방향 변경 감지              | ✅   |
| 리본 아이콘 (동기화/사이드바) | ✅   |
| DB 뷰 렌더링 6종              | ✅   |
| 뷰 도구바 (검색/정렬)         | ✅   |
| 인라인 편집 (Table)           | ✅   |
| 충돌 해결 모달                | ✅   |
| Notion DB → .base 자동 생성   | ✅   |
| Bases 갤러리 커버 이미지      | ✅   |

## 다음 목표

1. **v0.2.1 릴리스** — dev→main 머지 + v0.2.1 태그 (npm publish core+CLI 자동)
2. **커뮤니티 플러그인 제출** — BRAT 베타 + `obsidianmd/obsidian-releases` PR
3. **v1.0.0** — multi-workspace 지원 + 1000+ 노트 5분 이내 성능 최적화
