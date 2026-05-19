# Im-Nobsidian Roadmap

> Last updated: 2026-05-12

## Current State (v0.1.0 — Released)

v0.1.0 npm 배포 완료. CLI 8 commands. 355 tests.
Bidirectional sync with 15+ block types, database mode, conflict resolution.
All competitors are one-way only — Im-Nobsidian is the only true bidirectional tool.

---

## Release Strategy

```
v0.1.0  ─── 즉시 배포 (현재)
            npm publish + GitHub Release
            Reddit r/ObsidianMD + Obsidian Discord 공유

v0.1.1  ─── 위키링크 → Notion 페이지 멘션 연결 (1주 내)
            가장 눈에 보이는 품질 개선

v0.2.0  ─── martian 포크 + CVE 해소 + Myers diff (2주 내)
            기술 부채 정리, 보안 이슈 해결

v0.3.0  ─── 성능 최적화 (3-4주)
            Incremental sync, block-level diff
            대규모 볼트(1000+ 노트) 지원

v0.5.0  ─── Obsidian 커뮤니티 플러그인 등록 (1-2개월)
            sql.js 어댑터, 플러그인 테스트, BRAT 베타

v1.0.0  ─── 안정 릴리스 (3-4개월)
            Database view sync, relation 속성
            Notion API 파일 업로드 지원 시 이미지 Push
```

---

## v0.1.0 — MVP Release (Ready)

### Completed

- [x] 양방향 동기화 (push/pull/sync)
- [x] 15+ Notion 블록 타입 양방향 변환
- [x] 프론트매터 ↔ Notion 속성 매핑 (15+ 타입)
- [x] Database 부모 모드 (PropertyMapper)
- [x] 토글/컬럼/구분선/비디오/임베드 양방향
- [x] 색상/밑줄/멘션 보존
- [x] 보존 마커 시스템 (라운드트립 보장)
- [x] 3-way 머지 충돌 해결 (4가지 전략)
- [x] .im-nobsidian-ignore 경로 필터링
- [x] CLI 8개 명령어 (init/push/pull/sync/status/diff/resolve/watch)
- [x] 파일 감시 + 자동 동기화
- [x] Rate limiting + exponential backoff + jitter
- [x] SQLite WAL 상태 DB + 트랜잭션
- [x] 폴더 구조 → Notion 페이지 계층 매핑
- [x] 이미지 Pull 다운로드 + 중복 제거
- [x] 341 테스트, 82.7% 커버리지
- [x] OSS 문서 완비 (README EN/KO, CONTRIBUTING, COC, SECURITY, CHANGELOG)
- [x] CI/CD (Node 20+22 매트릭스, dependabot, audit, provenance)

### Known Limitations (v0.1.0)

- 이미지 Push: Notion API 파일 업로드 미지원 → 플레이스홀더 보존
- 위키링크 Push: 볼드 텍스트로 퇴화 (v0.1.1에서 해결 예정)
- Notion 전용 블록 (버튼/폼/동기블록): 읽기 전용 → 콜아웃 플레이스홀더
- 3-way 머지: naive diff (복잡한 충돌 시 부정확 가능)
- @tryfabric/martian: 4년 미업데이트 (v0.2.0에서 포크 예정)

---

## v0.1.1 — Wikilink Enhancement

### Tasks

- [ ] Push 시 `[[페이지]]` → wikilink_map 조회 → Notion 페이지 멘션 생성
- [ ] Pull 시 Notion 페이지 멘션 → `[[파일경로]]` 위키링크 복원
- [ ] wikilink_map 자동 갱신 (push/pull 양쪽에서)
- [ ] 별칭(alias) 해석 지원
- [ ] 라운드트립 테스트 추가

---

## v0.2.0 — Technical Debt

### Tasks

- [ ] @tryfabric/martian 포크 (katex >=0.16 업데이트, ESM 호환)
- [ ] 3-way 머지: Myers diff 알고리즘 교체 (`diff` 라이브러리 활용)
- [ ] InlineDBParser 제거 또는 파이프라인 연결
- [ ] block-converter.ts unsafe cast → 타입 가드 정리
- [ ] Obsidian 플러그인 테스트 추가 (현재 0개)

---

## v0.3.0 — Performance

### Tasks

- [ ] Incremental sync: last_edited_time 커서 기반 변경 감지
- [ ] Block-level diff: 페이지 전체 교체 → 블록 단위 변경
- [ ] Lazy loading: 대규모 볼트에서 메모리 최적화
- [ ] 벤치마크: 100/500/1000 노트 동기화 성능 측정

---

## v0.5.0 — Obsidian Plugin Release

### Tasks

- [ ] sql.js(WASM) DB 어댑터 (better-sqlite3 제거)
- [ ] 플러그인 실전 테스트 (10+ 노트 볼트)
- [ ] obsidianmd/obsidian-releases PR 제출
- [ ] BRAT 베타 채널 선공개
- [ ] manifest.json / versions.json 검증

---

## v1.0.0 — Stable Release

### Tasks

- [ ] Database view sync (필터/정렬/릴레이션)
- [ ] Notion API 파일 업로드 대응 (API 지원 시)
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

### Why Blue Ocean

1. No real bidirectional competitor exists
2. Only project offering programmatic API (library)
3. Only project with conflict resolution
4. Only project with CLI + Plugin + Library triple deployment

### Differentiation Strategy

- Ship fast, iterate with user feedback
- Prioritize data safety (never lose user content)
- Library-first architecture enables ecosystem growth
- Bilingual docs (EN/KO) for global + Korean community

---

## Risk Register

| Risk                            | Impact                          | Mitigation                         |
| ------------------------------- | ------------------------------- | ---------------------------------- |
| Notion API rate limit (3 req/s) | Slow for large vaults           | Incremental sync + batching        |
| Notion API no file upload       | Can't push images               | Placeholder preservation           |
| martian library abandoned       | Security CVEs, stale conversion | Fork in v0.2.0                     |
| Obsidian plugin review delay    | Plugin release delayed          | BRAT + GitHub direct install       |
| Notion API breaking changes     | Conversion breaks               | Pin SDK version, monitor changelog |
| Competitor emerges              | Market share loss               | Ship v0.1.0 immediately            |
