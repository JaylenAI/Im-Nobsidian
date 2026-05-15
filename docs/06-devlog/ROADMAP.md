# Im-Nobsidian Roadmap

> Last updated: 2026-05-15

## Current State (v0.1.3)

True bidirectional Obsidian <-> Notion sync via CLI.
434 tests passing, 25+ block types, 21 property read types, 15 property write types.
Partial update (search-and-replace), Move page API, media/color/underline/unknown 보존.
동기화 커버리지 ~95% 달성.

---

## Release Timeline

```
v0.1.3  <-- Current — Notion API 최신화 + Enhanced MD 확대
v0.5.0  --> Next — Obsidian community plugin (sql.js WASM)
v1.0.0  --> Database view sync, multi-workspace, 1000+ notes
```

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

## v0.5.0 — Obsidian Plugin Release

### Tasks

- [ ] sql.js (WASM) DB adapter (replace better-sqlite3)
- [ ] DBAdapter 인터페이스 분리 + better-sqlite-adapter + sql-js-adapter
- [ ] Plugin UI 완성 (설정, 리본, 상태바, 진행률)
- [ ] Obsidian 실전 검증 (10+ notes vault)
- [ ] obsidianmd/obsidian-releases PR submission
- [ ] BRAT beta channel pre-release

---

## v1.0.0 — Stable Release

### Tasks

- [ ] Database view sync (filters, sorts)
- [ ] Notion OAuth 인증 (ntn login 방식 참고)
- [ ] Multi-workspace support
- [ ] Performance: 1000+ notes within 5 minutes
- [ ] Notion Workers webhook 연동 검토
- [ ] Obsidian community plugin official registration
