# 현재 진행 상황

> 마지막 업데이트: 2026-07-17
> 버전: v0.3.0 릴리스 완료 (2026-07-14 태그·npm 배포) · v0.3.1 개발 완료(릴리스 대기)

## v0.3.1 — 실데이터 충실도 마감 5-Phase (개발 완료)

실 워크스페이스 감사 잔여 결함을 Phase 별 실 Notion API 라이브 검증으로 마감.

| Phase | 범위                                                         | 상태            |
| ----- | ------------------------------------------------------------ | --------------- |
| 1     | DB 완전 가시화 — linked view 원본 해소·.base 임베드 SSOT     | ✅ dev 머지     |
| 2     | 변환 견고화 — 토글×코드펜스·중첩 콜아웃·인접 블록 융합       | ✅ dev 머지     |
| 3     | 미디어 마감 — files 속성·synced 마커·20MB+ 멀티파트          | ✅ dev 머지     |
| 4     | NFM 디자인 충실도 — 컬럼·콜아웃 아이콘/색·블록 색 (ADR-008)  | ✅ 라이브 검증  |
| 5     | clean-slate 실데이터 E2E — F24·F25 churn 근절 + F26·F27 봉합 | ✅ churn-0 확정 |

Phase 5 핵심: **v0.3.0 부터 지속되던 steady churn(매 pull 66 updated) 근절** —
동명 DB 폴더 충돌(F24, 22쌍 분리)과 linked view 컨테이너 이중 등록(F25, 신 API 가
컨테이너에도 data_sources 를 채워 와 원본과 구분 불가 → 행 parent 로 판정) 수정.
push E2E 에서 HTML 주석 유출 실측 → CommentStripper 확장(F26), page mention 신형 URL
(`app.notion.com/p/`) 미해소 수정(F27). **clean-slate fresh pull 1183 파일 / 0 실패 →
audit-vault 결함 0 · 해시 불일치 0 · churn-0 PASS** + 재 pull "no changes" 로 멱등 재확정.
디스커버리 폴백(search) 무손실 규명(258=페이지 카운트, 1183=파일 수 단위 차이).

상세: `journal/2026-07-16.md`, `journal/2026-07-17.md`, `adr/008-nfm-design-fidelity.md`

## v0.3.0 — 왕복 충실도 일괄 봉합 + deps 최신화 (`fix/deps-latest-202607`)

**실코퍼스 심층 감사(F14~F27) 결함 전량 봉합 + 실데이터 E2E 실증 완료.**

- **변환 레이어**: 옵시디언 주석 push 차단(F26)·각주 왕복(F25)·하이라이트 왕복(F24)·
  표 열 정렬 왕복·블록 간격 복원(D1, `notionExportCompact` 메타데이터)·탭 정규화(D4)·
  frontmatter title/날짜(D2/D3)·보존 마커 앵커 재주입 — 신규 프로세서 7종 + md-regions 유틸
- **sync 레이어**: 캡션 이미지 다운로드(F14)·증분 워터마크 갭(F20)·child DB 재발견(F21)·
  `pull --force` CLI 노출(F22)·첨부 dedup(D6)·노트 임베드 삼킴 제거(D5)·
  접근 불가 DB denylist·ENOENT 노이즈 억제(F23)
- **deps**: Node 엔진 20 → 22.13+, CI 매트릭스 22/24, @notionhq/client v5,
  better-sqlite3 v12, chokidar v5 등
- **실증**(테스트 볼트 875페이지): 고문 노트 왕복 **바이트 delta-0**, `--force` 전체 스캔
  정상(child DB 발견 + `.base`/`.notion.json`/행 md 생성), 무변경 pull **869개 md
  churn-0**, 충돌 0
- **1151 테스트**(11 skip, 0 실패), lint/typecheck/build 클린
- 상세: `journal/2026-07-14.md`, 릴리스 노트 `../07-release/RELEASE_NOTES_v0.3.0.md`

## 이전 미션 — 동기화 충실도 회복 (`/goal`)

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

**v0.3.0 릴리스 완료(2026-07-14), v0.3.1 개발 완료 — 사용자 검수 대기.** 1285 테스트.

| 항목                     | 상태                                        |
| ------------------------ | ------------------------------------------- |
| npm `@im-nobsidian/core` | v0.3.0 배포 완료                            |
| npm `im-nobsidian` (CLI) | v0.3.0 배포 완료                            |
| GitHub Release           | v0.3.0 tagged + 노트 등록                   |
| Obsidian Plugin          | v0.3.0 (BRAT 설치 가능, 커뮤니티 제출 예정) |

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

- **전체**: 1285개 통과 (11 skip, 0 실패) — 100 테스트 파일 (3 skip)
- **TypeScript 타입 체크**: 클린 (에러 0)
- **플러그인 빌드**: 675KB, sql-wasm.wasm 644KB 별도
- **실데이터 E2E**: 1182페이지 clean-slate 볼트 — 무변경 pull churn-0("no changes"),
  push no-op, 고문 노트 v4 왕복 수렴, 충돌 0

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

1. **v0.3.1 릴리스** — Phase 5 clean-slate E2E → 사용자 검수 → dev→main 머지 + 태그
2. **커뮤니티 플러그인 제출** — BRAT 베타 + `obsidianmd/obsidian-releases` PR
3. **v1.0.0** — multi-workspace 지원 + 1000+ 노트 5분 이내 성능 최적화
