# 현재 진행 상황

> 마지막 업데이트: 2026-05-22
> 버전: v0.1.10

## 전체 상태

**v0.1.10 릴리스.** Obsidian Bases 갤러리 커버 이미지 동기화 (Phase 6 완료). Notion 갤러리 뷰의 커버 이미지가 Obsidian Bases cards에서 자동 표시.

| 항목                     | 상태                                         |
| ------------------------ | -------------------------------------------- |
| npm `@im-nobsidian/core` | v0.1.10                                      |
| npm `im-nobsidian` (CLI) | v0.1.10                                      |
| GitHub Release           | v0.1.10 tagged                               |
| Obsidian Plugin          | v0.1.10 (BRAT 설치 가능, 커뮤니티 제출 예정) |

## Phase 진행률

| Phase   | 설명                        | 상태    | 진행률 |
| ------- | --------------------------- | ------- | ------ |
| Phase 1 | IStateDB 인터페이스 분리    | ✅ 완료 | 100%   |
| Phase 2 | sql.js WASM 어댑터          | ✅ 완료 | 100%   |
| Phase 3 | 커뮤니티 플러그인 심사 요건 | ✅ 완료 | 100%   |
| Phase 4 | 사이드바 + 리본 + UI        | ✅ 완료 | 100%   |
| Phase 5 | DB 뷰 고급 + 양방향 감지    | ✅ 완료 | 100%   |
| Phase 6 | Notion DB → .base 자동 생성 | ✅ 완료 | 100%   |
| Phase 7 | 테스트 강화 50+             | 📋 예정 | 0%     |
| Phase 8 | 문서 + BRAT + 커뮤니티 제출 | 📋 예정 | 0%     |

## 버전별 주요 성과

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

- **Core 테스트**: 550개 통과
- **CLI 테스트**: 31개 통과
- **TypeScript 타입 체크**: 클린 (에러 0)
- **플러그인 빌드**: 637KB (sql.js WASM 별도)

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

1. **Phase 7** — 테스트 강화 (플러그인 50+ 테스트)
2. **Phase 8** — 문서 + BRAT 베타 + 커뮤니티 플러그인 제출
