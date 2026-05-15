# Im-Nobsidian Roadmap

> Last updated: 2026-05-14

## Current State (v0.1.1)

First public release + critical Pull bugfixes.
True bidirectional Obsidian <-> Notion sync via CLI.
377 tests passing, 17+ block types, 21 property types, frontmatter roundtrip, conflict resolution.
180 files Push/Pull 실전 테스트 완료.

---

## Release Timeline

```
v0.1.1  <-- Current — Pull 안정성 수정 + 실전 검증
v0.2.0  --> Next — N2O 수준 변환 품질 달성
v0.5.0  --> Obsidian community plugin (sql.js WASM)
v1.0.0  --> Database view sync, multi-workspace, 1000+ notes
```

---

## Competitive Analysis: N2O (v0.9.95)

N2O는 현재 Obsidian <-> Notion 동기화 분야 유일한 경쟁 제품 (Closed source, $8/mo).

### Im-Nobsidian vs N2O 비교

| 기능                        | Im-Nobsidian v0.1.1 |   N2O v0.9.95    | v0.2.0 목표 |
| --------------------------- | :-----------------: | :--------------: | :---------: |
| Pull (Notion->Obsidian)     |          O          |        O         |      O      |
| Push (Obsidian->Notion)     |      O (무료)       |  Pro만 ($8/mo)   |      O      |
| DB -> 폴더 매핑             |          O          |        O         |      O      |
| Relation -> Wikilink 양방향 |       Pull만        |        O         |    **O**    |
| 이미지 Push 업로드          |   구현됨 (미검증)   |        O         |    **O**    |
| 이미지 Pull 다운로드        |          O          |        O         |      O      |
| 3-way merge                 |          O          |        O         |      O      |
| 토글 블록 보존              | O (preserve marker) | X (callout 깨짐) |      O      |
| Obsidian 플러그인           |    WIP (v0.5.0)     |        O         |      -      |
| CLI 도구                    |   O (8 commands)    |        X         |      O      |
| Bases/Gallery 뷰            |          X          |        O         |      -      |
| 블록 타입                   |         17+         |       27+        |   **25+**   |
| 속성 타입 (Read)            |         21          |        21        |     21      |
| 속성 타입 (Write)           |         11          |       ~15        |   **15**    |
| Date range                  |       start만       |        O         |    **O**    |
| Auto-sync                   |      O (watch)      | O (30s polling)  |      O      |
| 프론트매터 라운드트립       |   포맷 차이 있음    |        O         |    **O**    |
| 소스 공개                   |       O (MIT)       |    X (Closed)    |      O      |
| 가격                        |        무료         |    $8/mo~$249    |    무료     |

### Im-Nobsidian만의 강점

1. **완전 무료 오픈소스** — Push 포함 전 기능 무료 (N2O는 Push가 유료)
2. **토글 블록 완벽 보존** — preserve marker 시스템 (N2O는 callout 변환 깨짐)
3. **CLI 8개 명령어** — 자동화/CI 연동 가능 (N2O는 CLI 없음)
4. **프로그래밍 API** — 라이브러리로 다른 도구에서 사용 가능
5. **3중 배포** — Library + CLI + Plugin

### N2O가 앞선 부분 (v0.2.0에서 따라잡기)

1. Relation Push (wikilink -> Notion relation)
2. 프론트매터 라운드트립 품질
3. 이미지 Push 실동작
4. Date range 속성
5. 블록 타입 수 (27+ vs 17+)

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
| `ntn datasources resolve`   | 미사용                     | **v0.2.0에서 활용 검토**  |
| `ntn login` (OAuth)         | PAT 토큰만                 | **v1.0.0에서 OAuth 검토** |

### 결론

Im-Nobsidian은 이미 ntn과 동일한 Notion API를 직접 사용 중.
ntn은 Im-Nobsidian의 접근 방식이 올바름을 공식적으로 검증해줌.

**활용 가능한 새로운 것:**

1. `datasources resolve` — DB ID -> Data Source ID 변환 (v0.2.0 DB 모드 개선)
2. `ntn login` OAuth 플로우 — v1.0.0에서 PAT 대신 OAuth 인증 검토
3. Notion Workers — 실시간 webhook 기반 동기화 (v1.0.0 이후 검토)

---

## v0.1.1 — Pull 안정성 수정 (Current)

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

## v0.2.0 — N2O 수준 변환 품질 (Next)

**목표:** N2O v0.9.x와 동등한 변환 품질 달성 (Obsidian 플러그인 제외)

### 2A. Relation Push — wikilink -> Notion relation (4-6h)

- `property-mapper.ts`: `toNotionProperties()`에 relation 타입 Write 추가
- 프론트매터 `related: ["[[page]]"]` 파싱 -> Notion relation 업데이트
- wikilink 텍스트 -> `stateDb.resolveWikilink()` -> pageId -> `relation: [{id: "xxx"}]`
- **테스트**: relation Push 왕복 테스트

### 2B. 프론트매터 라운드트립 품질 (4-6h)

- 날짜 포맷 정규화: `2026-03-24T00:00:00.000Z` -> `2026-03-24`
- 태그 배열 포맷 일관성: 인라인 `["a", "b"]` 보존
- related 링크: `im-nobsidian://wikilink/X` -> `[[X]]` 역변환
- `frontmatter-generator.ts` 수정

### 2C. 이미지 Push 실동작 검증 + 안정화 (3-4h)

- `image-handler.ts`의 `uploadAndAppendImages()` 실전 테스트
- Notion File Upload API (3-step: create -> send -> complete) 검증
- 실패 시 폴백 로직 (placeholder 보존)
- CURRENT_STATUS에서 "플레이스홀더" -> "업로드 지원"으로 업데이트

### 2D. Date range 속성 지원 (1-2h)

- `property-mapper.ts`: date 타입에 `end` 필드 추가
- Push: `{start: "2026-01-01", end: "2026-12-31"}` 전체 전송
- Pull: start + end 모두 프론트매터에 포함

### 2E. 블록 타입 확대 17+ -> 25+ (6-8h)

- PDF 블록 Pull/Push 커스텀 핸들러
- Embed 블록 커스텀 핸들러 (URL 패턴 세분화)
- Link preview 블록 Push 지원
- Table of contents Push 지원
- Child database 플레이스홀더 개선
- Button/Form 블록 읽기 가능한 콜아웃 플레이스홀더

### 2F. 속성 타입 Write 확대 11 -> 15 (3-4h)

- `people` 속성 Write (user ID 기반)
- `files` 속성 Write (File Upload API 연동)
- `relation` 속성 Write (2A와 연계)
- Date range Write (2D와 연계)

### 검증 기준

- [ ] 180파일 Push/Pull 왕복 0 실패
- [ ] Relation Push: `[[page]]` -> Notion relation -> Pull -> `[[page]]` 왕복
- [ ] 이미지 Push: 로컬 이미지 -> Notion 업로드 성공
- [ ] 프론트매터: Push -> Pull 후 포맷 일관성 유지
- [ ] Date range: start/end 양방향 보존
- [ ] 25+ 블록 타입 Pull/Push 검증

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

---

## Market Position

| Tool               | Direction              | Pricing      | Source         | Status                   |
| ------------------ | ---------------------- | ------------ | -------------- | ------------------------ |
| N2O                | Bidirectional          | $8/mo (Push) | Closed         | v0.9.95, 25 releases     |
| obsidian-to-notion | One-way (->Notion)     | Free         | Open           | ~550 stars, low activity |
| Nobsidion          | Claims bidirectional   | Free         | Open           | Small, incomplete        |
| Obsidian Importer  | One-way (->Obsidian)   | Free         | Official       | Migration only           |
| **Im-Nobsidian**   | **True bidirectional** | **Free**     | **Open (MIT)** | **v0.1.1, active**       |

### Why Im-Nobsidian

1. **유일한 무료 양방향 동기화** — Push 포함 전 기능 무료
2. **오픈소스** — 소스 코드 공개, 커뮤니티 기여 가능
3. **CLI + Library + Plugin** — 3중 배포 (N2O는 Plugin만)
4. **토글 블록 완벽 보존** — N2O에서도 해결 못한 문제
5. **Notion 공식 API만 사용** — Notion CLI (ntn)과 동일한 API 기반
