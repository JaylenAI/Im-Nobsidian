# ADR-005: Notion DB 뷰 렌더링 기술 선택

## 상태

결정됨 (2026-05-18)

## 컨텍스트

Im-Nobsidian v0.2.0에서 Notion DB의 Gallery/Board/Calendar/Table 뷰를 Obsidian 안에서 렌더링해야 한다.
경쟁 도구 N2O(Notion to Obsidian)는 유료/비공개 소스이므로 참고 불가.
오픈소스 참고 대상과 기술 스택을 결정해야 한다.

## 리서치 결과

### 1. Notion Views API (2026-04-01 공개)

Notion SDK v5.21.0에 추가된 8개 엔드포인트:

| 엔드포인트                | 용도              |
| ------------------------- | ----------------- |
| `views.list(databaseId)`  | DB의 모든 뷰 목록 |
| `views.retrieve(viewId)`  | 단일 뷰 상세 설정 |
| `views.create()`          | 뷰 생성           |
| `views.update()`          | 뷰 수정           |
| `views.delete()`          | 뷰 삭제           |
| `views.queries.create()`  | 뷰 기반 쿼리 실행 |
| `views.queries.results()` | 쿼리 결과 조회    |
| `views.queries.delete()`  | 쿼리 삭제         |

지원 뷰 타입 10종: table, board, calendar, timeline, gallery, list, form, chart, map, dashboard.
뷰 설정 포함: filter, sort, column order/visibility/width, cover settings, group_by config.

**핵심**: Notion에서 사용자가 설정한 뷰 구성(필터, 정렬, 그룹핑, 커버 설정 등)을 API로 완전히 조회 가능.
별도 설정 없이 Notion 뷰를 그대로 Obsidian에 재현할 수 있다.

### 2. 오픈소스 참고: obsidian-projects (marcusolsson)

GitHub: `marcusolsson/obsidian-projects`

- **UI 프레임워크**: Svelte (~5KB, 빌드 후 경량)
- **뷰 종류**: Table, Board, Gallery, Calendar
- **아키텍처**: `ItemView` 확장 + code block 프로세서
- **드래그앤드롭**: `svelte-dnd-action`
- **빌드**: esbuild + esbuild-svelte

코드 구조가 Im-Nobsidian의 뷰 렌더링과 거의 동일한 요구사항을 충족하여 1차 참고 대상으로 선정.

### 3. N2O (Notion to Obsidian)

- 유료 플러그인, 비공개 소스
- 공개 GitHub 레포 없음 — 코드 참고 불가
- 기능 스크린샷에서 Gallery/Board 뷰 렌더링 품질 확인 → 목표 수준 설정

### 4. Obsidian Bases (v1.9+)

- Obsidian 내장 데이터베이스 뷰 시스템
- `BasesView` 확장 API 존재
- 아직 생태계가 초기 단계 — 안정성 검증 부족
- **결정**: v0.5.0에서 Bases 연동 검토, 현재는 독립 ItemView로 구현

## 대안

### A: Svelte + ItemView (obsidian-projects 참고)

- Svelte 컴포넌트로 4종 뷰(Gallery/Board/Calendar/Table) 렌더링
- esbuild-svelte로 빌드 → main.js에 번들
- 장점: 경량(~5KB), 반응형, 검증된 패턴(obsidian-projects)
- 단점: Svelte 의존성 추가

### B: Vanilla JS + DOM API

- 프레임워크 없이 순수 JS로 뷰 렌더링
- 장점: 의존성 0개
- 단점: 코드량 폭증, 상태 관리 복잡, 유지보수 어려움

### C: React

- React로 뷰 컴포넌트 구현
- 장점: 생태계 거대
- 단점: 번들 크기 대폭 증가(~40KB+), Obsidian 기본 환경과 불일치

### D: Obsidian Bases API 직접 사용

- 내장 BasesView 확장
- 장점: 네이티브 통합
- 단점: API 불안정, 문서 부족, 커스터마이징 제약

## 결정

**A안: Svelte + ItemView** 채택.

이유:

1. obsidian-projects가 동일 패턴으로 검증됨 — 4종 뷰 모두 구현 실적
2. Svelte 번들 크기가 ~5KB로 경량 (React 대비 ~8x 작음)
3. esbuild 빌드 파이프라인에 자연스럽게 통합
4. Notion Views API로 조회한 설정을 Svelte 컴포넌트에 바인딩하는 구조가 깔끔

## 결과

- **뷰 데이터 흐름**: Notion Views API → `db-views.json` 캐시 → Svelte 렌더러
- **커버 이미지**: Notion signed URL(1시간 만료) → 로컬 다운로드 + 캐시
- **아이콘**: emoji/external/file/native → 프론트매터 `icon` 필드
- **드래그앤드롭**: Board 뷰에서 `svelte-dnd-action` 사용
- **Bases 연동**: v0.5.0 이후 검토
