# Im-Nobsidian Roadmap

> Last updated: 2026-05-17

## Current State (v0.2.0-dev)

494 tests passing, 25+ block types, 21 property read types, 15 property write types.
다중 데이터베이스 동기화(DatabaseSyncer), Standalone 파일 동기화, 부분 업데이트 3단계 폴백.
Notion Views API 연동 완료 (Phase 1). DB 뷰 렌더링 엔진 개발 중.
동기화 커버리지 ~95% 달성.

---

## Release Timeline

```
v0.1.5  --- 완료 — Pull 변환 버그 수정 + E2E 검증 완료
v0.2.0  <-- Current — Notion DB 뷰 렌더링 엔진 (Gallery/Board/Calendar/Table)
v0.5.0  --> Next — Obsidian community plugin (sql.js WASM + 뷰 렌더링 UI)
v1.0.0  --> Multi-workspace, 1000+ notes, OAuth
```

### v0.2.0 Phase 진행 상황

| Phase   | 내용                           | 상태    |
| ------- | ------------------------------ | ------- |
| Phase 1 | DB 메타데이터 + Views API 통합 | ✅ 완료 |
| Phase 2 | 뷰 렌더링 코어 엔진 (Svelte 5) | ✅ 완료 |
| Phase 3 | 옵시디언 통합 레이어           | ✅ 완료 |
| Phase 4 | 양방향 상호작용                | ✅ 완료 |
| Phase 5 | 테스트 + v0.2.0 릴리스         | ✅ 완료 |

상세 계획: `docs/06-devlog/PHASE_PLAN_v0.2.0_VIEW_RENDERING.md`
기술 결정: `docs/02-architecture/adr/005-db-view-rendering-tech.md`

---

## Notion CLI (ntn) 활용 가능성

Notion이 2026-05 공식 CLI `ntn`을 출시함.
Im-Nobsidian과의 관계 분석:

### ntn이 제공하는 기능

| ntn 명령                    | Im-Nobsidian 대응          | 활용                      |
| --------------------------- | -------------------------- | ------------------------- |
| `ntn pages get <id>`        | `getPageMarkdown()`        | 동일 API 사용 중          |
| `ntn pages create --parent` | `createPageWithMarkdown()` | 동일 API 사용 중          |
| `ntn pages update <id>`     | `replacePageMarkdown()`    | 동일 API 사용 중          |
| `ntn files create`          | `uploadFile()`             | 동일 API 사용 중          |
| `ntn datasources query`     | `queryDatabase()`          | 동일 API 사용 중          |
| `ntn datasources resolve`   | 미사용                     | **향후 활용 검토**        |
| `ntn login` (OAuth)         | PAT 토큰만                 | **v1.0.0에서 OAuth 검토** |

### 결론

Im-Nobsidian은 이미 ntn과 동일한 Notion API를 직접 사용 중.
ntn은 Im-Nobsidian의 접근 방식이 올바름을 공식적으로 검증해줌.

**활용 가능한 새로운 것:**

1. `datasources resolve` — DB ID -> Data Source ID 변환 (DB 모드 개선)
2. `ntn login` OAuth 플로우 — v1.0.0에서 PAT 대신 OAuth 인증 검토
3. Notion Workers — 실시간 webhook 기반 동기화 (v1.0.0 이후 검토)

---

## v0.1.0 — MVP Release

### Added

- Notion Markdown API 기반 Pull/Push 핵심 경로
- File Upload API 3단계 구현 (create → send → complete)
- 위키링크 ↔ 페이지 멘션 양방향 매핑
- YAML 코드블록 프론트매터 무손실 보존
- Enhanced Markdown 변환기 (10 전처리기 + 7 후처리기)
- 콜아웃 타입/접기 상태 preserve marker 보존
- 3-way 머지 충돌 해결 (ask / local-wins / remote-wins / manual)
- CLI 8개 명령어 (init, push, pull, sync, status, diff, resolve, watch)
- SQLite WAL 상태 DB + Rate limiting (3 req/s)

---

## v0.1.1 — Pull 안정성 수정

### Fixed

- [x] `resolveParentPath()` 재귀적 경로 해석 — 깊은 중첩 폴더 구조 완벽 지원
- [x] `pullCreate()` 불필요한 폴더 레코드 제거 — UNIQUE 제약 조건 충돌 해결
- [x] `isRetryable()` 타임아웃/ECONNRESET/ETIMEDOUT 에러 자동 재시도
- [x] `detectLocalChanges()` 폴더 레코드 잘못된 삭제 감지 방지
- [x] `ensureFolderPage()` 폴더-노트 중복 생성 방지

### Verified

- [x] 180파일 GC_AI Push: 180/180 성공, 0 실패
- [x] 283파일 Pull: 283/283 성공, 0 실패, 0 UNIQUE 에러
- [x] 폴더 구조: GC_AI/Admin, CVfit, ERP_NextGen/Releases, Meetings, Projects, Study 전부 정확

---

## v0.1.2 — 변환 품질 강화

### Added

- [x] Relation Write — `[[wikilink]]` → Notion relation 속성 양방향
- [x] Relation Pull 역변환 — pageId → `[[PageName]]` 자동 변환
- [x] People Write — user ID 기반
- [x] Files Write — 외부 URL 기반
- [x] Date range — start + end 양방향
- [x] PDF 블록 Pull 커스텀 트랜스포머
- [x] Embed 블록 Pull 커스텀 트랜스포머
- [x] ISO 날짜 정규화 — `T00:00:00.000Z` → `YYYY-MM-DD`
- [x] 테스트 377 → 409

---

## v0.1.3 — Notion API 최신화 + Enhanced MD 확대

### Added

- [x] `update_content` 부분 업데이트 — search-and-replace (≤20 패치)
- [x] Move page API — 파일 이동 시 Notion 페이지 위치 이동 (히스토리 보존)
- [x] 충돌 시 remoteContent 실제 조회 — 빈 문자열 대신 Notion 내용 비교
- [x] 미디어 태그 양방향 — `<audio>/<video>/<pdf>/<file>` ↔ 이모지 링크
- [x] Tab 블록 양방향 — `<tab>` ↔ `> [!tab]` 콜아웃
- [x] 색상/밑줄 보존 마커 — `<span color>/<underline>` → 라운드트립 유지
- [x] Unknown 블록 보존 마커 — `<unknown>` → 삭제 대신 보존
- [x] 읽기전용 속성 8종 스킵 — Push 시 API 에러 방지
- [x] 타임존 정규화 확대 — `+09:00` 등 오프셋 포함 자정 시각 처리
- [x] 빈 배열 속성 프론트매터 제외
- [x] 테스트 409 → 434, 픽스처 14 → 17개

---

## v0.1.4 — 다중 DB 동기화 + 테스트 확대

### Added

- [x] DatabaseSyncer — 다중 Notion 데이터베이스 양방향 Pull/Push
- [x] Standalone 파일 동기화 — 비-md 파일 업로드/다운로드
- [x] pushUpdatePage 폴백 체인 개선 — 부분 업데이트 → replace → blocks API
- [x] 테스트 434 → 486 (52개 추가)
- [x] 라운드트립 픽스처 17 → 20개

### Verified (실전 E2E — 2026-05-16)

- [x] 13종 형식 종합 Push→Pull 라운드트립 — 완전 동일
- [x] 3단계 폴더 구조 + 위키링크 교차 참조 — 완벽 보존
- [x] 246페이지 + 249이미지 Pull — 전체 성공 (192초)
- [x] 색상/밑줄/unknown 보존 마커 라운드트립 — 완전 보존
- [x] 한국어/특수문자 콘텐츠 — 완벽 처리
- [x] 이미지 Push — File Upload API 상태 전환 버그 수정 완료

---

## v0.1.5 — Pull 변환 버그 수정

### Fixed

- [x] Notion `<callout>` 태그 → Obsidian 콜아웃 변환 지원
- [x] 미디어 태그 앞 탭/공백 허용 (리스트 내 미디어 처리)
- [x] 이스케이프된 인라인 수식/첨자 문자 복원 (`\$`, `\^`, `\~`)
- [x] 테이블 정렬 행 중복 필터링
- [x] `gray-matter` Date 객체 프론트매터 정규화 처리

### Verified (E2E — 2026-05-17)

- [x] 7개 파일 13종 포맷 Push→Pull 라운드트립 — 11/13 완벽 동일
- [x] 실전형 3파일 (회의록/기술사양/학습노트) 라운드트립 — 완벽
- [x] 콜아웃 8종 (note/tip/warning/danger/info/example/quote/bug) — 전체 복원
- [x] 수학 수식 인라인 6개 + 블록 3개 — 전체 복원
- [x] 첨자 5개 (H~2~O, CO~2~, X^2^, a^n^, Fe~2~O~3~) — 전체 복원
- [x] 대형 테이블 10행 7열 — 정렬 행 중복 없음
- [x] 4단계 중첩 리스트 — 완벽 보존

---

## v0.2.0 — Notion DB 뷰 렌더링 엔진 (N2O 수준 달성)

> **목표**: Obsidian 안에서 Notion DB를 갤러리/보드/캘린더/테이블 뷰로 시각적으로 렌더링.
> N2O 플러그인과 동등 이상의 UIUX 구현. 플러그인 개발 전 코어 엔진에 뷰 렌더링 기반 구축.

### Phase 2A: DB 메타데이터 확장 (2~3일)

- [ ] `getDatabaseCoverAndIcon()` — DB 행의 커버 이미지 URL + 아이콘(이모지/이미지) 추출
- [ ] 커버/아이콘을 프론트매터에 저장 (`cover:`, `icon:` 필드)
- [ ] `getDatabaseViewConfig()` — DB의 뷰 설정 조회 (Notion API 지원 범위 내)
- [ ] DB 스키마에 뷰 타입 힌트 저장 (`.im-nobsidian/db-views.json`)
- [ ] PropertyMapper에 커버/아이콘 역매핑 추가

### Phase 2B: 뷰 렌더링 코어 엔진 (1~2주)

- [ ] `ViewRenderer` 인터페이스 설계
  ```typescript
  interface ViewRenderer {
    render(entries: DBEntry[], viewConfig: ViewConfig): string | HTMLElement;
  }
  ```
- [ ] `GalleryViewRenderer` — 커버 이미지 카드 그리드
  - CSS Grid 레이아웃 (3~5열 반응형)
  - 커버 이미지 + 아이콘 + 제목 + 태그 배지
  - 카드 클릭 → 해당 .md 파일 열기
  - 카드 사이즈: small/medium/large
- [ ] `TableViewRenderer` — 정렬/필터 가능한 테이블
  - 헤더 클릭 정렬 (ASC/DESC)
  - 속성 타입별 셀 렌더링 (체크박스, 태그, 날짜 등)
  - 필터 드롭다운 (select/multi_select/status 기반)
- [ ] `BoardViewRenderer` — 칸반 보드
  - select/status 속성 기준 컬럼 자동 그룹핑
  - 카드 드래그앤드롭 → 속성 변경 → Notion Push
  - 컬럼별 카드 수 표시
- [ ] `CalendarViewRenderer` — 월간 캘린더
  - date 속성 기준 날짜 셀 배치
  - 월/주 전환
  - 날짜 셀 클릭 → 해당 노트 열기/생성

### Phase 2C: 뷰 데이터 파이프라인 (3~5일)

- [ ] `DBEntryCollector` — 프론트매터에서 뷰 렌더링에 필요한 데이터 수집
  - 로컬 .md 파일 스캔 → 프론트매터 파싱 → DBEntry 배열 생성
  - 커버 이미지 로컬 캐싱 (attachments 폴더)
  - 이모지 아이콘 파싱
- [ ] `ViewConfigManager` — 뷰 설정 CRUD
  - 사용자가 뷰 타입 선택 (gallery/board/table/calendar)
  - 표시할 속성 선택
  - 그룹핑/정렬/필터 기본값 설정
- [ ] 뷰 렌더링 결과 → Obsidian `MarkdownRenderChild` 또는 `ItemView`로 표시

### Phase 2D: 양방향 인터랙션 (1~2주)

- [ ] 뷰에서 속성 변경 → 프론트매터 업데이트 → Notion Push 트리거
- [ ] 보드 드래그앤드롭 → status/select 속성 변경
- [ ] 갤러리 카드 클릭 → `workspace.openFile()` 연동
- [ ] 테이블 셀 인라인 편집 → 속성 즉시 업데이트
- [ ] "+ 새 페이지" 버튼 → 새 .md 파일 생성 + Notion Push

### Phase 2E: 테스트 + 검증 (3~5일)

- [ ] ViewRenderer 단위 테스트 (각 뷰 타입별 렌더링 출력 검증)
- [ ] DBEntryCollector 프론트매터 파싱 테스트
- [ ] 실전 DB 동기화 E2E: Notion DB Pull → 뷰 렌더링 → 속성 변경 → Push → Notion 반영 확인
- [ ] 성능 테스트: 100+ 행 DB 뷰 렌더링 속도

### 검증 기준

> **스크린샷 비교 가능 수준**: 동일한 Notion DB를 N2O와 Im-Nobsidian으로 각각 렌더링했을 때
> 갤러리 카드 레이아웃, 커버 이미지, 태그 배지, 카드 클릭 동작이 동등해야 함.

---

## v0.5.0 — Obsidian Plugin Release

### Tasks

- [ ] sql.js (WASM) DB adapter (replace better-sqlite3)
- [ ] DBAdapter 인터페이스 분리 + better-sqlite-adapter + sql-js-adapter
- [ ] Plugin UI 완성 (사이드바 Sync/Pull/Push 버튼, Settings 탭, 상태바, 진행률)
- [ ] Auto-sync / Real-time 토글 (코어 watch 엔진 연동)
- [ ] Preview Changes / Scan Vault UI
- [ ] v0.2.0 뷰 렌더링 엔진 플러그인 통합 (Gallery/Board/Calendar/Table 뷰)
- [ ] Obsidian 실전 검증 (10+ notes vault)
- [ ] obsidianmd/obsidian-releases PR submission
- [ ] BRAT beta channel pre-release

---

## v1.0.0 — Stable Release

### Tasks

- [ ] Notion OAuth 인증 (ntn login 방식 참고)
- [ ] Multi-workspace support
- [ ] Performance: 1000+ notes within 5 minutes
- [ ] Notion Workers webhook 연동 검토
- [ ] Obsidian community plugin official registration
- [ ] 타임라인 뷰 (간트 차트 형태)
