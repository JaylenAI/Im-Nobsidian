# Im-Nobsidian Roadmap

> Last updated: 2026-07-17

## Current State (v0.3.1 — 릴리스 대기)

v0.3.1 — 정상상태 churn 근절 + push 왕복 잔여 누수 봉합 (무손실 패치, 공개 API/deps 무변경).
동명 형제 인라인 DB 폴더 충돌(22쌍 분리)·linked view 컨테이너 이중 등록(행 parent 판정)
제거로 무변경 pull **churn-0** 달성. push 시 HTML 주석 차단(F26 확장)·page mention 신형
`app.notion.com/p/` URL 해소(F27). clean-slate **887 파일**(258 페이지+629 DB 행) 실데이터 재구성: audit 결함 0·
해시 불일치 0·churn-0, 재 pull "no changes", 충돌 0. **1285 tests.**

직전 v0.3.0 — 왕복 충실도 일괄 봉합(주석/각주/하이라이트/표정렬/블록간격) + 증분 pull 누락
수정 + deps 최신화(Node 22+). 25+ block types bidirectional, 21 property read / 15 write types.

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

v0.1.10 ─── ✅ Bases 갤러리 커버 이미지 동기화 (2026-05-22)
            .base formulas 자동 생성, 커버 위키링크, 581 tests

v0.1.11 ─── ✅ 플러그인 테스트 + 빌드 최적화 (2026-05-23)
            115 플러그인 테스트, better-sqlite3 제거, push 버그 수정, 696 tests

v0.1.12 ─── ✅ Pull 충실도 + 동기화 안정성 (2026-05-29)
            중첩 DB→Bases, 갤러리 커버 렌더, 데이터 손실 경로 다수 제거, 777 tests

v0.2.0  ─── ✅ 무손실·멱등·수렴 (2026-06-02)
            충실도 측정 인프라(I1) + 불변식 안전망, 무손실 push 확장, 변환 정본화(I3), 1038 tests

v0.2.1  ─── ✅ --version 정정 + 문서 현행화 (2026-06-03)
            CLI 버전 동적 읽기(createRequire), 설치 명령 교정, README/로드맵 현행화

v0.3.0  ─── ✅ 왕복 충실도 일괄 봉합 (2026-07-14)
            주석/각주/하이라이트/표정렬/블록간격 왕복, F20/F21 증분 누락 수정,
            pull --force, 첨부 dedup, Node 22+, 1151 tests

v0.3.1  ─── ⏳ 정상상태 churn 근절 (릴리스 대기)
            동명 인라인 DB 폴더 분리·linked view 중복 제거(churn-0),
            HTML 주석 왕복·mention URL 봉합, clean-slate 887 실데이터, 1285 tests

v1.0.0  ─── 커뮤니티 등록 + 안정 릴리스 (예정)
            obsidian-releases PR, BRAT 베타, multi-workspace, 1000+ notes
```

---

## Completed Releases

### v0.1.10 — Bases Gallery Cover Image Sync (2026-05-22)

- [x] `page_content`/`page_content_first` 커버 → Bases `formulas(file.embeds[0])` 매핑
- [x] `page_cover` 프론트매터 위키링크 형식 변환
- [x] `.base` 파일 Notion 업로드 방지
- [x] 빈 DB 제목 fallback 수정
- [x] 단위 테스트 4건 추가 (base-file-generator 23건)

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

## v0.2.0 — 무손실·멱등·수렴 (✅ 2026-06-02)

### Done

- [x] 충실도 측정 인프라 — 본문 링크 분류기 + 멱등성 감사 러너 + 라운드트립 deep-equal(I1) (#77)
- [x] 불변식 안전망 — 드리프트/멱등성/삭제 상시 잠금
- [x] 무손실 push 확장 — blockquote·번호목록·underline/color·breadcrumb/TOC·DB 사이드카(`.notion.json`)
- [x] 변환 정본화(I3) — 멘션 정규형 수렴, 마커 원위치 복원, span/color 통일
- [x] 멱등·수렴 — 증분 삭제 전파(I10)·content_hash 멱등(I5)·다중 소스 무손실(I4)
- [x] cascade 폭주 차단(#72/#73) + 대용량 발견 성능(#71)
- [x] 1038 tests (core 858 + CLI 31 + plugin 149)

### 다음 (→ v1.0.0)

- [ ] BRAT 베타 릴리스
- [ ] Obsidian 커뮤니티 플러그인 공식 제출
- [ ] 라이브 push 왕복 E2E (#68, 쓰기 게이트)

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
6. Obsidian Bases 네이티브 연동 — `.base` 자동 생성 + 갤러리 커버 (v0.1.10)
