# Im-Nobsidian Roadmap

> Last updated: 2026-05-19

## Current State (v0.1.5 — Dev)

v0.1.5 개발 완료. CLI 8 commands. 554 tests (core 524 + CLI 30).
25+ block types bidirectional, 21 property read / 15 write types.
DB view rendering engine (Gallery/Board/Table/Calendar), file attachment download, expanded child page discovery.

---

## Release Strategy

```
v0.1.0  ─── ✅ 초기 릴리스 완료 (2026-05-11)
            npm publish + GitHub Release
            355 tests, 15+ block types

v0.1.5  ─── ✅ 개발 완료 (2026-05-19)
            DB 뷰 렌더링, 파일 첨부, 자식 페이지 탐색 확장
            554 tests, 25+ block types, 21/15 속성

v0.5.0  ─── Obsidian 커뮤니티 플러그인 등록 (예정)
            sql.js 어댑터, 사이드바 UI, 플러그인 테스트, BRAT 베타

v1.0.0  ─── 안정 릴리스 (예정)
            Database view sync, multi-workspace, 1000+ notes
```

---

## Completed Releases

### v0.1.0 — MVP Release (2026-05-11)

- [x] 양방향 동기화 (push/pull/sync)
- [x] 15+ Notion 블록 타입 양방향 변환
- [x] 프론트매터 ↔ Notion 속성 매핑 (15+ 타입)
- [x] Database 부모 모드 (PropertyMapper)
- [x] 토글/컬럼/구분선/비디오/임베드 양방향
- [x] 색상/밑줄/멘션 보존
- [x] 보존 마커 시스템 (라운드트립 보장)
- [x] 3-way 머지 충돌 해결 (4가지 전략)
- [x] CLI 8개 명령어
- [x] 355 테스트, 82.7% 커버리지

### v0.1.2 — 속성 매핑 강화 (2026-05-14)

- [x] 속성 Write 15개 타입 + 프론트매터 정규화
- [x] Enhanced MD 변환기 확대 (미디어/탭/색상/밑줄)
- [x] Notion API 최신화 (부분 업데이트, 페이지 이동)

### v0.1.3 — DB 동기화 (2026-05-15)

- [x] DatabaseSyncer 구현 (DB 페이지 양방향)
- [x] Standalone 파일 동기화 (비-md 파일)
- [x] 486 테스트 도달

### v0.1.4 — E2E 검증 (2026-05-16)

- [x] File Upload API 상태 전환 버그 수정
- [x] Pull 변환 버그 5건 수정
- [x] 테스트 확대 (부분 업데이트, Enhanced MD 라운드트립)

### v0.1.5 — DB 뷰 + 동기화 품질 (2026-05-17~19)

- [x] Notion Views API 연동 (Gallery/Board/Table/Calendar)
- [x] Board DnD + 캘린더 이벤트 생성 + EntryEditor
- [x] 파일 첨부 다운로드 (file:// → 로컬)
- [x] 자식 페이지 탐색 확장 (모든 has_children 블록)
- [x] 링크 해결 범위 확대 (전체 synced 파일)
- [x] 커버/아이콘 추출
- [x] 554 테스트

---

## v0.5.0 — Obsidian Plugin Release

### Tasks

- [ ] `IStateDB` 인터페이스 분리 (better-sqlite3 ↔ sql.js 어댑터)
- [ ] sql.js(WASM) DB 어댑터 구현
- [ ] 사이드바 대시보드 (Push/Pull/진행률/충돌 표시)
- [ ] 리본 아이콘 (원클릭 동기화)
- [ ] 커뮤니티 플러그인 심사 요건 충족
- [ ] 플러그인 테스트 50+
- [ ] BRAT 베타 → obsidianmd/obsidian-releases PR 제출

---

## v1.0.0 — Stable Release

### Tasks

- [ ] Database view sync (필터/정렬/릴레이션)
- [ ] 뷰 고급 기능 (Filter/Sort/Search 도구바, 인라인 편집)
- [ ] List/Timeline 뷰 추가
- [ ] Multi-workspace 지원
- [ ] 성능: 1000+ 노트 5분 이내
- [ ] Obsidian 커뮤니티 플러그인 공식 등록 완료

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

---

## Risk Register

| Risk                            | Impact                          | Mitigation                         |
| ------------------------------- | ------------------------------- | ---------------------------------- |
| Notion API rate limit (3 req/s) | Slow for large vaults           | Incremental sync + batching        |
| martian library abandoned       | Security CVEs, stale conversion | Fork planned                       |
| Obsidian plugin review delay    | Plugin release delayed          | BRAT + GitHub direct install       |
| Notion API breaking changes     | Conversion breaks               | Pin SDK version, monitor changelog |
