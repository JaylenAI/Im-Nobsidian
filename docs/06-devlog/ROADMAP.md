# Im-Nobsidian Roadmap

> Last updated: 2026-05-22

## Current State (v0.1.9)

v0.1.9 릴리스. Obsidian 플러그인 프로덕션 레디.
sql.js WASM 어댑터, 동기화 사이드바, 양방향 변경 감지, DB 뷰 6종.
CLI 8 commands + `--full` 옵션. 523 tests.
25+ block types bidirectional, 21 property read / 15 write types.

---

## Release Strategy

```
v0.1.0  ─── ✅ 초기 릴리스 (2026-05-11)
            npm publish + GitHub Release, 355 tests

v0.1.5  ─── ✅ DB 뷰 렌더링 (2026-05-19)
            Views API, 파일 첨부, 554 tests

v0.1.8  ─── ✅ Push 버그 수정 + DB 자동발견 (2026-05-21)

v0.1.9  ─── ✅ Obsidian 플러그인 프로덕션 레디 (2026-05-22)
            sql.js WASM, 사이드바, 양방향 감지, DB 뷰 6종, 523 tests

v0.2.0  ─── Notion DB → Obsidian Bases 연동 (예정)
            .base 파일 자동 생성, 네이티브 뷰 렌더링

v1.0.0  ─── 안정 릴리스 (예정)
            커뮤니티 플러그인 등록, multi-workspace, 1000+ notes
```

---

## Completed Releases

### v0.1.9 — Obsidian Plugin Production Ready (2026-05-22)

- [x] `IStateDB` 인터페이스 분리 (Phase 1)
- [x] sql.js WASM 어댑터 구현 (Phase 2)
- [x] 커뮤니티 플러그인 심사 요건 6건 수정 (Phase 3)
- [x] 동기화 사이드바 대시보드 (Phase 4)
- [x] 리본 아이콘 (원클릭 동기화 + 사이드바 토글)
- [x] DB 뷰 6종 (Gallery/Board/Table/Calendar/List/Timeline)
- [x] 뷰 도구바 (검색/정렬/새 항목)
- [x] TableView 인라인 편집
- [x] `filterEntries()` 엔진 (8개 연산자)
- [x] 양방향 변경 감지 (incremental API)
- [x] AbortController 동기화 취소
- [x] CLI `nobsi status --full`
- [x] obsidianFetch 바이너리 다운로드 수정
- [x] `status()` incremental 최적화

### v0.1.8 — Critical Push Fix (2026-05-21)

- [x] Push → Notion 미반영 치명적 버그 수정
- [x] DB 자동발견 + 캐싱
- [x] Stat cache 최적화
- [x] 중복 제목 처리

### v0.1.7 — Beautiful CLI (2026-05-20)

- [x] chalk 기반 컬러풀 터미널 UI
- [x] CLI 데모 GIF 8종

### v0.1.5 — DB View Rendering (2026-05-19)

- [x] Notion Views API (Gallery/Board/Table/Calendar)
- [x] 파일 첨부 다운로드
- [x] 자식 페이지 탐색 확장

### v0.1.0 — MVP Release (2026-05-11)

- [x] 양방향 동기화 (push/pull/sync)
- [x] 15+ Notion 블록 타입 양방향 변환
- [x] 프론트매터 ↔ Notion 속성 매핑
- [x] 3-way 머지 충돌 해결
- [x] CLI 8개 명령어

---

## v0.2.0 — Notion DB → Obsidian Bases

### Tasks

- [ ] `NotionToBaseConverter` — Notion DB 스키마 → `.base` YAML 변환
- [ ] Pull 시 `.base` 파일 자동 생성/업데이트
- [ ] 속성 타입 매핑 (Notion → frontmatter → Bases)
- [ ] 뷰 매핑 (Gallery→cards, Table→table, List→list)
- [ ] 커스텀 Svelte 뷰 → Bases fallback 전환
- [ ] 플러그인 테스트 50+
- [ ] BRAT 베타 릴리스

---

## v1.0.0 — Stable Release

### Tasks

- [ ] Obsidian 커뮤니티 플러그인 공식 등록
- [ ] Multi-workspace 지원
- [ ] 성능: 1000+ 노트 5분 이내
- [ ] 문서 + 스크린샷/GIF 완비

---

## Market Position

### Competitive Landscape (as of 2026-05)

| Tool               | Direction              | Status                     |
| ------------------ | ---------------------- | -------------------------- |
| obsidian-to-notion | One-way (→Notion)      | ~550 stars, low activity   |
| Nobsidion          | Claims bidirectional   | Small, incomplete          |
| Obsidian Importer  | One-way (→Obsidian)    | Official, migration only   |
| **Im-Nobsidian**   | **True bidirectional** | **Library + CLI + Plugin** |

### Differentiation

1. 전세계 유일한 진정한 양방향 동기화
2. 유일한 프로그래밍 API (라이브러리)
3. 유일한 충돌 해결 내장
4. CLI + Plugin + Library 트리플 배포
5. Notion Views API 활용 DB 뷰 렌더링 (경쟁사 없음)
6. Obsidian Bases 네이티브 연동 예정 (v0.2.0)
