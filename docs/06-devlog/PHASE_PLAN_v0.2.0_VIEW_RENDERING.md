# v0.2.0 — Notion DB 뷰 렌더링 개발 계획

> 작성: 2026-05-18
> 상태: 전체 완료 (Phase 1~5)

## 목표

Notion DB의 뷰(Gallery/Board/Calendar/Table)를 Obsidian에서 네이티브처럼 렌더링.
Notion에서 설정한 필터/정렬/그룹핑/커버/아이콘이 그대로 반영되어야 한다.

## 리서치 기반

### 참고 프로젝트

| 이름                                 | 유형        | 참고 포인트                                                |
| ------------------------------------ | ----------- | ---------------------------------------------------------- |
| **obsidian-projects** (marcusolsson) | 오픈소스    | Svelte + ItemView 4종 뷰 아키텍처, 빌드 설정, 드래그앤드롭 |
| **N2O** (Notion to Obsidian)         | 유료/비공개 | UI 품질 벤치마크 (코드 참고 불가)                          |
| **Obsidian Bases** (v1.9+)           | 내장        | 향후 연동 후보 (현재 API 불안정)                           |

### 핵심 기술

| 기술                               | 선택 이유                                         |
| ---------------------------------- | ------------------------------------------------- |
| **Notion Views API** (SDK v5.21.0) | 뷰 설정 완전 조회 — 별도 설정 없이 Notion 뷰 재현 |
| **Svelte**                         | ~5KB 경량, obsidian-projects 검증, esbuild 호환   |
| **svelte-dnd-action**              | Board 뷰 드래그앤드롭                             |
| **esbuild-svelte**                 | 빌드 파이프라인 통합                              |

### Notion Views API 상세

SDK v5.21.0 (2026-04-01) 추가 엔드포인트 8개:

```
views.list(databaseId)        — DB의 모든 뷰 목록
views.retrieve(viewId)        — 단일 뷰 상세 설정 (필터/정렬/컬럼/커버/그룹핑)
views.create()                — 뷰 생성
views.update()                — 뷰 수정
views.delete()                — 뷰 삭제
views.queries.create()        — 뷰 기반 쿼리 실행
views.queries.results()       — 쿼리 결과 조회
views.queries.delete()        — 쿼리 삭제
```

지원 뷰 타입: table, board, calendar, timeline, gallery, list, form, chart, map, dashboard (10종).
뷰 설정 포함 정보: filter, sorts, properties(순서/가시성/너비), groupBy, cover(type/size/aspect), datePropertyId.

### 커버/아이콘 처리

- **커버**: `page.cover` — `file`(signed URL, 1시간 만료) 또는 `external`
  - signed URL → 로컬 다운로드 후 `properties.cover`에 로컬 경로 저장
  - external URL → 그대로 사용
- **아이콘**: `page.icon` — `emoji`, `external`, `file`, `icon`(네이티브)
  - `properties.icon`에 값 저장 (emoji 문자, URL, 또는 아이콘명)

---

## Phase 구성

### Phase 1: DB 메타데이터 + Views API 통합 ✅ 완료

**브랜치**: `feature/v0.2.0-phase1-db-views-api`

| 작업                                                                  | 파일                                      | 상태 |
| --------------------------------------------------------------------- | ----------------------------------------- | ---- |
| ViewConfig 타입 정의                                                  | `core/src/types/view.ts`                  | ✅   |
| Views API 메서드 (listDatabaseViews, getView, getDatabaseViewsConfig) | `core/src/notion/client.ts`               | ✅   |
| extractCover, extractIcon 메서드                                      | `core/src/notion/client.ts`               | ✅   |
| pullDatabaseViews → db-views.json 캐시                                | `core/src/sync/database-syncer.ts`        | ✅   |
| pullDatabasePage에 커버/아이콘 추출 추가                              | `core/src/sync/database-syncer.ts`        | ✅   |
| 타입 export                                                           | `core/src/index.ts`                       | ✅   |
| extractCover/extractIcon 테스트 8개                                   | `core/tests/notion/client-utils.test.ts`  | ✅   |
| DatabaseSyncer 테스트 수정                                            | `core/tests/sync/database-syncer.test.ts` | ✅   |

**검증**: 494 테스트 전부 통과.

### Phase 2: 뷰 렌더링 코어 엔진 (Svelte)

**브랜치**: `feature/v0.2.0-phase2-view-renderer`

#### 2A. 뷰 데이터 파이프라인

```
db-views.json → ViewDataProvider → Svelte 컴포넌트
                     ↓
              프론트매터에서 속성값 추출
              커버/아이콘 로컬 경로 해석
              필터/정렬 적용
```

- **ViewDataProvider**: `db-views.json` + 로컬 .md 파일 → 뷰 렌더링용 데이터 구조 생성
- 필터/정렬/그룹핑 로직을 core에 구현 (프레임워크 무관)

#### 2B. Gallery 뷰

obsidian-projects의 Gallery 컴포넌트 참고:

```
┌──────────┐ ┌──────────┐ ┌──────────┐
│ [커버이미지] │ │ [커버이미지] │ │ [커버이미지] │
│          │ │          │ │          │
│ 🏢 회사명  │ │ 🔬 회사명  │ │ 💡 회사명  │
│ 단계: 서류  │ │ 단계: 면접  │ │ 단계: 합격  │
│ 직무: 개발  │ │ 직무: PM   │ │ 직무: 디자인│
└──────────┘ └──────────┘ └──────────┘
```

- 카드 그리드 레이아웃 (CSS Grid)
- 커버 이미지: `properties.cover` → 로컬 파일 또는 URL
- 아이콘: `properties.icon` → 이모지 또는 이미지
- 속성 표시: ViewConfig.properties에서 visible=true인 속성만

#### 2C. Board 뷰

```
┌─ 서류전형 ──────┐ ┌─ 면접 ──────────┐ ┌─ 합격 ──────────┐
│ ┌───────────┐  │ │ ┌───────────┐  │ │ ┌───────────┐  │
│ │ 🏢 A사    │  │ │ │ 🔬 B사    │  │ │ │ 💡 C사    │  │
│ │ 개발직    │  │ │ │ PM       │  │ │ │ 디자인    │  │
│ └───────────┘  │ │ └───────────┘  │ │ └───────────┘  │
│ ┌───────────┐  │ │                │ │                │
│ │ 🏢 D사    │  │ │                │ │                │
│ │ 마케팅    │  │ │                │ │                │
│ └───────────┘  │ │                │ │                │
└────────────────┘ └────────────────┘ └────────────────┘
```

- groupBy 속성(select/status)별 컬럼 분리
- svelte-dnd-action으로 카드 이동 → 속성값 변경 → Notion API 업데이트
- hideEmptyGroups 옵션 반영

#### 2D. Table 뷰

```
┌────────┬────────┬────────┬────────┬──────────┐
│ 회사명  │ 단계   │ 직무   │ 링크   │ 날짜      │
├────────┼────────┼────────┼────────┼──────────┤
│ 🏢 A사 │ 🟢서류  │ 개발   │ 🔗     │ 2026-05  │
│ 🔬 B사 │ 🟡면접  │ PM     │ 🔗     │ 2026-04  │
│ 💡 C사 │ 🟢합격  │ 디자인  │ 🔗     │ 2026-03  │
└────────┴────────┴────────┴────────┴──────────┘
```

- ViewConfig.properties 순서/가시성/너비 반영
- select/status 속성 → 색상 배지 (Notion 색상 매핑)
- 컬럼 리사이즈, 정렬 토글

#### 2E. Calendar 뷰

```
┌───────────────────────────────────────────┐
│           2026년 5월                       │
├─────┬─────┬─────┬─────┬─────┬─────┬─────┤
│ 일  │ 월  │ 화  │ 수  │ 목  │ 금  │ 토  │
├─────┼─────┼─────┼─────┼─────┼─────┼─────┤
│     │     │     │     │  1  │  2  │  3  │
│     │     │     │     │     │     │     │
├─────┼─────┼─────┼─────┼─────┼─────┼─────┤
│  4  │  5  │  6  │  7  │  8  │  9  │ 10  │
│     │[A사]│     │     │     │[B사]│     │
└─────┴─────┴─────┴─────┴─────┴─────┴─────┘
```

- datePropertyId 기반 날짜 매핑
- 월/주 뷰 전환 (viewRange)
- 날짜 셀 클릭 → 해당 노트 열기

### Phase 3: 옵시디언 통합 레이어

**브랜치**: `feature/v0.2.0-phase3-obsidian-integration`

- Code block 프로세서: ` ```im-nobsidian-view ` → 뷰 렌더링
- ItemView: 사이드바 또는 탭에서 DB 뷰 표시
- 뷰 전환 탭 UI (Gallery | Board | Table | Calendar)
- 로컬 .md 파일 변경 감지 → 뷰 자동 갱신

### Phase 4: 양방향 상호작용

**브랜치**: `feature/v0.2.0-phase4-bidirectional`

- Board 뷰 카드 이동 → 프론트매터 속성 변경 + Notion Push
- Table 셀 인라인 편집 → 프론트매터 + Notion 업데이트
- Calendar 이벤트 드래그 → 날짜 변경
- 뷰 내 새 페이지 생성 버튼

### Phase 5: 테스트 + 릴리스

**브랜치**: `release/v0.2.0`

- ViewDataProvider 단위 테스트
- 각 뷰 컴포넌트 렌더링 테스트 (Svelte testing library)
- E2E: 실제 Notion DB → Pull → 뷰 렌더링 → 상호작용 → Push 검증
- 500+ 테스트 목표
- v0.2.0 태그 + npm 배포

---

## 데이터 흐름 (전체)

```
Notion DB
    │
    ├── Views API ──→ db-views.json (뷰 설정 캐시)
    │                      │
    ├── Pages API ──→ 로컬 .md 파일 (프론트매터 + 본문)
    │                      │
    └── Cover/Icon ──→ 로컬 이미지 + 프론트매터 필드
                           │
                    ViewDataProvider
                           │
                    ┌──────┼──────┬──────────┐
                    ▼      ▼      ▼          ▼
                Gallery  Board  Table   Calendar
                (Svelte) (Svelte)(Svelte)(Svelte)
                    │      │      │          │
                    └──────┼──────┴──────────┘
                           │
                   사용자 상호작용
                           │
                    ┌──────┼──────┐
                    ▼      ▼      ▼
               프론트매터  Notion   뷰 상태
               업데이트    Push    갱신
```

## 색상 매핑 (Notion → CSS)

Notion select/status 색상을 Obsidian CSS 변수로 매핑:

```
default → --text-muted
gray → #787774
brown → #9F6B53
orange → #D9730D
yellow → #CB912F
green → #448361
blue → #337EA9
purple → #9065B0
pink → #C14C8A
red → #D44C47
```

## 파일 구조 (예상)

```
packages/core/src/
├── types/view.ts                  ← Phase 1 ✅
├── notion/client.ts               ← Phase 1 ✅ (Views API 메서드)
├── sync/database-syncer.ts        ← Phase 1 ✅ (뷰 캐시 + 커버/아이콘)
└── view/                          ← Phase 2 (신규)
    ├── data-provider.ts           — 뷰 데이터 구성
    ├── filter-engine.ts           — 필터/정렬/그룹핑 로직
    └── color-map.ts               — Notion 색상 → CSS

packages/obsidian-plugin/src/
└── views/                         ← Phase 3 (신규)
    ├── ViewContainer.svelte       — 뷰 전환 탭 컨테이너
    ├── GalleryView.svelte         — 갤러리 카드 그리드
    ├── BoardView.svelte           — 칸반 보드
    ├── TableView.svelte           — 테이블
    ├── CalendarView.svelte        — 달력
    └── components/
        ├── Card.svelte            — 카드 (갤러리/보드 공용)
        ├── PropertyBadge.svelte   — 색상 배지
        ├── CoverImage.svelte      — 커버 이미지
        └── IconDisplay.svelte     — 아이콘 (이모지/이미지)
```

## 품질 목표

| 항목         | 목표                            |
| ------------ | ------------------------------- |
| 테스트       | 500+ (현재 494)                 |
| 뷰 타입      | Gallery, Board, Table, Calendar |
| 색상 매핑    | Notion 10색 → CSS               |
| 커버 이미지  | 로컬 캐시, signed URL 자동 갱신 |
| 드래그앤드롭 | Board 카드 이동 → 속성 변경     |
| 성능         | 100행 DB 1초 내 렌더링          |
