# 현재 진행 상황

> 마지막 업데이트: 2026-05-08

## 전체 진행률

| Phase   | 설명                 | 상태      | 진행률 |
| ------- | -------------------- | --------- | ------ |
| Phase 1 | 기획 & 리서치        | ✅ 완료   | 100%   |
| Phase 2 | 아키텍처 설계        | ✅ 완료   | 100%   |
| Phase 3 | 프로젝트 초기화      | ✅ 완료   | 100%   |
| Phase 4 | 코어 변환 엔진       | 🔄 진행중 | 60%    |
| Phase 5 | 동기화 엔진          | 🔄 진행중 | 40%    |
| Phase 6 | CLI                  | 🔄 진행중 | 50%    |
| Phase 7 | Obsidian 플러그인    | 🔄 진행중 | 30%    |
| Phase 8 | 테스트 & 안정화      | 🔄 진행중 | 30%    |
| Phase 9 | 배포 & 오픈소스 공개 | ❌ 미시작 | 0%     |

## Phase 3: 프로젝트 초기화 ✅

| 항목                  | 상태    | 비고                              |
| --------------------- | ------- | --------------------------------- |
| pnpm install          | ✅ 완료 | better-sqlite3 네이티브 빌드 포함 |
| 전체 빌드 검증        | ✅ 완료 | 3 패키지 모두 성공                |
| 패키지 간 import 확인 | ✅ 완료 | workspace:\* 정상                 |

## Phase 4: 코어 변환 엔진 (60%)

| 항목                      | 상태      | 비고                        |
| ------------------------- | --------- | --------------------------- |
| ConversionPipeline 클래스 | ✅ 완료   | 전/후처리기 체인, 경로 선택 |
| FrontmatterExtractor      | ✅ 완료   | gray-matter 기반            |
| WikilinkResolver          | ✅ 완료   | [[link\|display]] 지원      |
| CalloutTransformer        | ✅ 완료   | 13타입 매핑, foldable 보존  |
| MathNormalizer            | ✅ 완료   | inline/block 정규화         |
| EmbedResolver             | ✅ 완료   | 이미지/비디오/링크 분류     |
| InlineDBParser            | ✅ 완료   | preserve marker 기반 파싱   |
| PreserveMarkerCollector   | ✅ 완료   | 마커 수집                   |
| MentionToWikilink         | ✅ 완료   | Notion 링크 → [[위키링크]]  |
| CalloutRestorer           | ✅ 완료   | 이모지 → [!type] 역변환     |
| ColorAnnotator            | ✅ 완료   | color marker → span         |
| FrontmatterGenerator      | ✅ 완료   | properties → YAML           |
| PreserveMarkerInjector    | ✅ 완료   | 마커 삽입 (뼈대)            |
| martian 통합 (블록 변환)  | ❌ 미시작 | Block API 경로              |
| notion-to-md 통합         | ❌ 미시작 | Pull 블록→MD                |
| Markdown API 연동         | ❌ 미시작 | Fast path                   |

## Phase 5: 동기화 엔진 (40%)

| 항목             | 상태      | 비고                         |
| ---------------- | --------- | ---------------------------- |
| StateDB (SQLite) | ✅ 완료   | CRUD, 마이그레이션, 트랜잭션 |
| ChangeDetector   | ✅ 완료   | SHA-256 + move detection     |
| SyncOrchestrator | ✅ 완료   | push/pull/sync/status 뼈대   |
| NodeVaultFS      | ✅ 완료   | 파일 순회, 읽기/쓰기         |
| ConfigManager    | ✅ 완료   | init/load/save, .gitignore   |
| Three-Way Merge  | ✅ 완료   | 충돌 감지 + 자동 병합        |
| FileWatcher      | ✅ 완료   | chokidar 기반                |
| NotionClient     | ✅ 완료   | rate limit + 재시도          |
| Pull 전체 구현   | ❌ 미시작 | 원격 변경 감지 + 변환 + 쓰기 |
| 이미지 다운로드  | ❌ 미시작 |                              |
| TreeMapper       | ❌ 미시작 | 폴더 구조 동기화             |

## Phase 6: CLI (50%)

| 항목        | 상태      | 비고                       |
| ----------- | --------- | -------------------------- |
| init 명령   | ✅ 완료   | 대화형 설정, 토큰 검증     |
| push 명령   | ✅ 완료   | --dry-run, --path 옵션     |
| pull 명령   | ✅ 완료   | 뼈대 (Pull 엔진 연동 필요) |
| sync 명령   | ✅ 완료   | pull → push 순차 실행      |
| status 명령 | ✅ 완료   | 변경/충돌 표시             |
| diff 명령   | ❌ 미시작 |                            |
| 진행률 UI   | ❌ 미시작 | ora 연동 개선              |

## Phase 7: Obsidian 플러그인 (30%)

| 항목                     | 상태      | 비고                     |
| ------------------------ | --------- | ------------------------ |
| Plugin 클래스            | ✅ 완료   | main.ts                  |
| SettingTab               | ✅ 완료   | 토큰/루트/방향/자동 설정 |
| 커맨드 등록              | ✅ 완료   | push/pull/sync           |
| StatusBar                | ✅ 완료   | 기본 상태 표시           |
| VaultAdapter (core 연동) | ❌ 미시작 |                          |
| 충돌 해결 모달           | ❌ 미시작 |                          |
| 자동 동기화              | ❌ 미시작 |                          |

## Phase 8: 테스트 (30%)

| 항목                  | 상태      | 비고                        |
| --------------------- | --------- | --------------------------- |
| 유틸 테스트           | ✅ 완료   | hash, sanitize (12개)       |
| 변환 테스트           | ✅ 완료   | pipeline, processors (25개) |
| StateDB 테스트        | ✅ 완료   | CRUD, 트랜잭션 (14개)       |
| 충돌 해결 테스트      | ✅ 완료   | three-way merge (5개)       |
| ChangeDetector 테스트 | ✅ 완료   | 6개 시나리오                |
| 라운드트립 테스트     | ✅ 완료   | 4개 (기본 fixture)          |
| E2E (실제 Notion API) | ❌ 미시작 | 토큰 필요                   |
| 커버리지 80%+         | ❌ 미확인 |                             |

**총 테스트: 66개 통과 (8 파일)**

## 다음 작업

1. martian/notion-to-md 라이브러리 통합 (실제 블록 변환)
2. Pull 엔진 완전 구현 (원격 변경 감지 → 변환 → 파일 쓰기)
3. TreeMapper 구현 (폴더 구조 동기화)
4. E2E 테스트 (Notion API 토큰 필요)
5. Plugin VaultAdapter 구현
