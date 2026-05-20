# 현재 진행 상황

> 마지막 업데이트: 2026-05-20
> 버전: v0.1.6 (dev)

## 전체 상태

**v0.1.6 개발 완료.** CLI UIUX 전면 개선 — chalk 기반 컬러풀 터미널 출력, 파일별 실시간 진행률, dry-run 개선.

| 항목                     | 상태                                                |
| ------------------------ | --------------------------------------------------- |
| npm `@im-nobsidian/core` | v0.1.0 published (v0.1.6 dev)                       |
| npm `im-nobsidian` (CLI) | v0.1.0 published (v0.1.6 dev)                       |
| GitHub Release           | v0.1.0 tagged                                       |
| Obsidian Plugin          | v0.5.0 예정 (sql.js 전환 필요, 뷰 렌더링 구현 완료) |

## Phase 진행률

| Phase   | 설명                 | 상태    | 진행률 |
| ------- | -------------------- | ------- | ------ |
| Phase 1 | 기획 & 리서치        | ✅ 완료 | 100%   |
| Phase 2 | 아키텍처 설계        | ✅ 완료 | 100%   |
| Phase 3 | 프로젝트 초기화      | ✅ 완료 | 100%   |
| Phase 4 | 코어 변환 엔진       | ✅ 완료 | 100%   |
| Phase 5 | 동기화 엔진          | ✅ 완료 | 100%   |
| Phase 6 | CLI                  | ✅ 완료 | 100%   |
| Phase 7 | Obsidian 플러그인    | 🔧 진행 | 70%    |
| Phase 8 | 테스트 & 안정화      | ✅ 완료 | 100%   |
| Phase 9 | 배포 & 오픈소스 공개 | ✅ 완료 | 100%   |

## v0.1.2 ~ v0.1.5 주요 성과

### v0.1.2 — 속성 매핑 + Enhanced MD (2026-05-14)

- 속성 Write 15개 타입 지원 + 프론트매터 정규화
- Enhanced MD 변환기: 미디어/탭/색상/밑줄/unknown 보존
- Notion API 최신화: 부분 업데이트, 페이지 이동, 충돌 원격 조회

### v0.1.3 — 테스트 확대 + DB 동기화 (2026-05-15)

- DatabaseSyncer 구현 (DB 페이지 양방향 동기화)
- Standalone 파일 동기화 (비-md 파일 업로드/다운로드)
- 테스트 486개 도달

### v0.1.4 — E2E 검증 + 이미지 Push 수정 (2026-05-16)

- File Upload API 상태 전환 버그 수정
- Pull 변환 버그 5건 수정
- 테스트 확대 (부분 업데이트, Enhanced MD 라운드트립)

### v0.1.5 — DB 뷰 렌더링 + 동기화 품질 (2026-05-17~19)

- Notion Views API 연동 — Gallery/Board/Table/Calendar 4종 뷰
- Board DnD, 캘린더 이벤트 생성, EntryEditor
- 파일 첨부 다운로드 (file:// 프로토콜 → 로컬 저장)
- 자식 페이지 탐색 확장 (모든 has_children 블록)
- 링크 해결 범위 확대 (전체 synced 파일)
- 커버/아이콘 추출

### v0.1.6 — Beautiful CLI 출력 (2026-05-20)

- chalk 기반 컬러풀 터미널 UI (push/pull/sync/status/init)
- 파일별 실시간 진행률 (create/update/delete 아이콘 + [n/N] 카운터)
- dry-run 모드 개선 (파일별 미리보기 출력)
- status 날짜 포맷 ISO 통일
- CLI 데모 GIF 4종 생성 (asciinema → agg)

## 테스트 현황

- **Core 테스트**: 524개 통과 (32 파일)
- **CLI 테스트**: 31개 통과 (8 파일)
- **총 555개 테스트**

## 지원 기능

### 블록 타입 (25+)

| 카테고리    | 블록                               | Push |  Pull   |
| ----------- | ---------------------------------- | :--: | :-----: |
| 기본        | Heading, Paragraph, Quote, Divider |  ✅  |   ✅    |
| 리스트      | Bulleted, Numbered, Checkbox       |  ✅  |   ✅    |
| 코드        | Code block (30+ 언어)              |  ✅  |   ✅    |
| 수식        | LaTeX (인라인 + 블록)              |  ✅  |   ✅    |
| 테이블      | Table + Table row                  |  ✅  |   ✅    |
| 레이아웃    | Toggle, Column, Callout            |  ✅  |   ✅    |
| 미디어      | Image, Audio, Video, PDF, File     |  ✅  |   ✅    |
| 특수        | Tab, Color, Underline              |  ✅  |   ✅    |
| Notion 전용 | Bookmark, Embed, Synced block      |  —   | 📌 보존 |

### 속성 타입 (21 읽기 / 15 쓰기)

| 읽기 전용                                                                   | 읽기+쓰기                                                                                                                            |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| formula, rollup, created_time, created_by, last_edited_time, last_edited_by | title, rich_text, number, select, multi_select, date, checkbox, url, email, phone_number, people, files, relation, status, unique_id |

## CLI 명령어

| 명령            | 상태 | 비고                               |
| --------------- | ---- | ---------------------------------- |
| `nobsi init`    | ✅   | 대화형 + `--non-interactive`       |
| `nobsi push`    | ✅   | `--dry-run`, `--path`, 진행률 표시 |
| `nobsi pull`    | ✅   | 원격 변경 감지 + 변환 + 쓰기       |
| `nobsi sync`    | ✅   | pull → push 순차 실행              |
| `nobsi status`  | ✅   | 변경/충돌 표시                     |
| `nobsi diff`    | ✅   | 변경사항 상세 출력                 |
| `nobsi resolve` | ✅   | 대화형 + `--strategy`              |
| `nobsi watch`   | ✅   | chokidar + debounce 자동 동기화    |

## 알려진 제한사항

| 제한              | 원인                                 | 상태                    |
| ----------------- | ------------------------------------ | ----------------------- |
| Notion 전용 블록  | API가 unsupported 반환               | 콜아웃 플레이스홀더     |
| Rate limit        | Notion 3 req/s 제한                  | 자동 제한 + 지수 백오프 |
| Obsidian 플러그인 | better-sqlite3 + Electron 호환 불가  | v0.5.0에서 sql.js 전환  |
| 첫 Push 위키링크  | 신규 페이지 간 교차 참조 미해결 가능 | 재동기화 시 자동 해결   |

## 다음 목표

1. **v0.5.0** — Obsidian 커뮤니티 플러그인 등록 (sql.js 전환 + 사이드바 UI)
2. **v1.0.0** — Database view sync, 다중 워크스페이스, 1000+ 노트 성능
