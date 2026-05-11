# 현재 진행 상황

> 마지막 업데이트: 2026-05-11

## 전체 진행률

| Phase   | 설명                 | 상태      | 진행률 |
| ------- | -------------------- | --------- | ------ |
| Phase 1 | 기획 & 리서치        | ✅ 완료   | 100%   |
| Phase 2 | 아키텍처 설계        | ✅ 완료   | 100%   |
| Phase 3 | 프로젝트 초기화      | ✅ 완료   | 100%   |
| Phase 4 | 코어 변환 엔진       | ✅ 완료   | 100%   |
| Phase 5 | 동기화 엔진          | ✅ 완료   | 100%   |
| Phase 6 | CLI                  | ✅ 완료   | 95%    |
| Phase 7 | Obsidian 플러그인    | ✅ 완료   | 90%    |
| Phase 8 | 테스트 & 안정화      | ✅ 완료   | 90%    |
| Phase 9 | 배포 & 오픈소스 공개 | 🔄 진행중 | 20%    |

## Phase 4: 코어 변환 엔진 ✅

| 항목                      | 상태    | 비고                        |
| ------------------------- | ------- | --------------------------- |
| ConversionPipeline 클래스 | ✅ 완료 | 전/후처리기 체인, 경로 선택 |
| FrontmatterExtractor      | ✅ 완료 | gray-matter 기반            |
| WikilinkResolver          | ✅ 완료 | [[link\|display]] 지원      |
| CalloutTransformer        | ✅ 완료 | 13타입 매핑, foldable 보존  |
| MathNormalizer            | ✅ 완료 | inline/block 정규화         |
| EmbedResolver             | ✅ 완료 | 이미지/비디오/링크 분류     |
| InlineDBParser            | ✅ 완료 | preserve marker 기반 파싱   |
| PreserveMarkerCollector   | ✅ 완료 | 마커 수집                   |
| MentionToWikilink         | ✅ 완료 | Notion 링크 → [[위키링크]]  |
| CalloutRestorer           | ✅ 완료 | 이모지 → [!type] 역변환     |
| ColorAnnotator            | ✅ 완료 | color marker → span         |
| FrontmatterGenerator      | ✅ 완료 | properties → YAML           |
| PreserveMarkerInjector    | ✅ 완료 | 마커 삽입                   |
| martian 통합 (블록 변환)  | ✅ 완료 | @tryfabric/martian 연동     |
| notion-to-md 통합         | ✅ 완료 | Pull 블록→MD 변환           |

## Phase 5: 동기화 엔진 ✅

| 항목             | 상태    | 비고                          |
| ---------------- | ------- | ----------------------------- |
| StateDB (SQLite) | ✅ 완료 | CRUD, 마이그레이션, 트랜잭션  |
| ChangeDetector   | ✅ 완료 | SHA-256 + move detection      |
| SyncOrchestrator | ✅ 완료 | push/pull/sync/status 전체    |
| NodeVaultFS      | ✅ 완료 | 파일 순회, 읽기/쓰기          |
| ConfigManager    | ✅ 완료 | init/load/save, .gitignore    |
| Three-Way Merge  | ✅ 완료 | 충돌 감지 + 자동 병합         |
| FileWatcher      | ✅ 완료 | chokidar 기반 + debounce      |
| NotionClient     | ✅ 완료 | rate limit + 재시도           |
| Pull 전체 구현   | ✅ 완료 | 원격 변경 감지 + 변환 + 쓰기  |
| 이미지 다운로드  | ✅ 완료 | ImageHandler + image_registry |
| TreeMapper       | ✅ 완료 | 폴더 구조 양방향 매핑         |

## Phase 6: CLI ✅

| 항목          | 상태      | 비고                          |
| ------------- | --------- | ----------------------------- |
| init 명령     | ✅ 완료   | 대화형 설정, 토큰 검증        |
| push 명령     | ✅ 완료   | --dry-run, --path 옵션        |
| pull 명령     | ✅ 완료   | 실제 Pull 엔진 연동 완료      |
| sync 명령     | ✅ 완료   | pull → push 순차 실행         |
| status 명령   | ✅ 완료   | 변경/충돌 표시                |
| diff 명령     | ✅ 완료   | 변경사항 상세 출력            |
| resolve 명령  | ✅ 완료   | 대화형 + --strategy 옵션      |
| watch 명령    | ✅ 완료   | chokidar + debounce           |
| 진행률 UI     | ❌ 미구현 | 대규모 sync 시 미표시         |
| 비대화형 모드 | ❌ 미구현 | init에 --non-interactive 없음 |

## Phase 7: Obsidian 플러그인 ✅

| 항목                     | 상태      | 비고                                  |
| ------------------------ | --------- | ------------------------------------- |
| Plugin 클래스            | ✅ 완료   | main.ts (11.8KB)                      |
| SettingTab               | ✅ 완료   | 토큰/루트/방향/자동 설정              |
| 커맨드 등록              | ✅ 완료   | push/pull/sync/status/resolve         |
| StatusBar                | ✅ 완료   | 상태 표시 (ready/syncing/error)       |
| VaultAdapter (core 연동) | ✅ 완료   | vault-adapter.ts (3.0KB)              |
| 충돌 해결 모달           | ✅ 완료   | conflict-modal.ts + CSS               |
| 자동 동기화              | ✅ 완료   | vault 이벤트 기반 + debounce          |
| 실제 Obsidian 로딩 검증  | ❌ 미검증 | better-sqlite3 + Electron 호환 미확인 |

## Phase 8: 테스트 ✅

| 항목                  | 상태    | 비고                              |
| --------------------- | ------- | --------------------------------- |
| 유틸 테스트           | ✅ 완료 | hash, sanitize, id                |
| 변환 테스트           | ✅ 완료 | pipeline, processors, roundtrip   |
| StateDB 테스트        | ✅ 완료 | CRUD, 트랜잭션                    |
| 충돌 해결 테스트      | ✅ 완료 | three-way merge + resolver        |
| ChangeDetector 테스트 | ✅ 완료 | 6개 시나리오                      |
| 라운드트립 테스트     | ✅ 완료 | 4개 fixture                       |
| Watcher 테스트        | ✅ 완료 | file-watcher + watch-sync-service |
| Orchestrator 테스트   | ✅ 완료 | push/pull/sync mock 기반          |
| E2E (실제 Notion API) | ✅ 완료 | 11개 통과 (3파일)                 |

**총 테스트: 191개 통과 + E2E 11개 통과**

## E2E 테스트 결과 (2026-05-11)

| 테스트           | 결과    | 비고                        |
| ---------------- | ------- | --------------------------- |
| Notion 인증      | ✅ 통과 | bot 사용자 확인             |
| 루트 페이지 접근 | ✅ 통과 |                             |
| 하위 블록 조회   | ✅ 통과 |                             |
| 검색 API         | ✅ 통과 |                             |
| 페이지 CRUD      | ✅ 통과 | 생성→수정→아카이브          |
| MD→Notion Push   | ✅ 통과 | martian 변환 정상           |
| Notion→MD Pull   | ✅ 통과 | notion-to-md 변환 정상      |
| 라운드트립       | ✅ 통과 | MD→Notion→MD 왕복           |
| Pull 신규 페이지 | ✅ 통과 | 로컬 파일 생성 확인         |
| Pull 업데이트    | ✅ 통과 | 변경사항 로컬 반영          |
| 충돌 감지        | ✅ 통과 | 로컬+원격 동시 수정 시 감지 |

## CLI 수동 테스트 결과 (2026-05-11)

| 테스트    | 결과    | 비고                       |
| --------- | ------- | -------------------------- |
| push      | ✅ 성공 | Notion에 페이지 생성       |
| pull      | ✅ 성공 | 로컬에 .md 파일 생성       |
| sync      | ✅ 성공 | 양방향 동기화              |
| status    | ✅ 성공 | clean 상태 표시            |
| diff      | ✅ 성공 | 변경 없음 정상 출력        |
| 충돌 감지 | ✅ 성공 | 양쪽 수정 시 충돌 1건 감지 |
| resolve   | ⚠ 이슈  | 아래 버그 #1 참조          |

## 발견된 이슈

### 버그

| #   | 심각도 | 설명                                                                                                                   | 파일                      |
| --- | ------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1   | 높음   | **충돌 상태에서 push 진행됨** — sync 시 충돌 감지 후에도 push가 해당 파일을 밀어넣음. 충돌 파일은 push에서 제외해야 함 | `orchestrator.ts`         |
| 2   | 높음   | **pushUpdate 데이터 손실 위험** — 기존 블록 전체 삭제 후 새 블록 추가. 추가 실패 시 데이터 유실                        | `orchestrator.ts:302-332` |
| 3   | 중간   | **StateDB 트랜잭션 미사용** — 다단계 작업이 트랜잭션 없이 실행됨                                                       | `orchestrator.ts`         |
| 4   | 중간   | **Rate limit jitter 없음** — 순수 지수 백오프만 사용                                                                   | `client.ts:234-245`       |
| 5   | 중간   | **Windows 경로 미지원** — '/' 하드코딩                                                                                 | `node-vault-fs.ts`        |
| 6   | 낮음   | **CLI shebang 중복** — 소스와 tsup banner 양쪽에 shebang → 빌드 깨짐 (수정 완료)                                       | `cli/src/index.ts`        |

### 개선 필요

| #   | 우선순위 | 설명                               |
| --- | -------- | ---------------------------------- |
| 1   | 높음     | README 영문화 (오픈소스 배포 필수) |
| 2   | 높음     | CHANGELOG 실질 내용 작성           |
| 3   | 중간     | CLI init 비대화형 모드             |
| 4   | 중간     | 진행률 표시 (대규모 sync)          |
| 5   | 낮음     | Obsidian 플러그인 실제 로딩 검증   |

## 다음 작업

1. 충돌 상태 파일 push 제외 버그 수정
2. pushUpdate 안전화 (데이터 손실 방지)
3. StateDB 트랜잭션 래핑
4. CLI UX 개선 (진행률, 비대화형 모드)
5. 문서 국제화 + 배포 인프라
6. Obsidian 플러그인 실전 검증
