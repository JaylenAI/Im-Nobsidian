# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.1] - 2026-05-14

### Fixed

- **`resolveParentPath()` 재귀적 경로 해석** — Pull 시 깊은 중첩 폴더 구조가 1단계로 평탄화되던 문제 수정. 부모 페이지를 재귀적으로 추적하여 전체 경로 체인 복원
- **`pullCreate()` 폴더 레코드 제거** — 같은 parentPageId를 notionPageId로 사용하여 UNIQUE 제약 조건 충돌 (7건) 발생하던 문제 수정
- **`isRetryable()` 에러 코드 확장** — `notionhq_client_request_timeout`, `ECONNRESET`, `ETIMEDOUT` 에러를 자동 재시도 대상에 추가
- **`detectLocalChanges()` 폴더 레코드 삭제 감지 방지** — `folder-note`/`folder-only` fileType을 가진 레코드가 잘못 삭제로 감지되던 문제 수정
- **`ensureFolderPage()` 폴더-노트 중복 생성 방지** — StateDB에서 기존 폴더-노트 레코드를 먼저 확인하여 중복 페이지 생성 방지

### Verified

- 180파일 GC_AI Push: 180/180 성공, 0 실패
- 283파일 Pull: 283/283 성공, 0 UNIQUE 에러
- 폴더 구조: GC_AI/Admin, CVfit, ERP_NextGen/Releases, Meetings, Projects, Study 전부 정확

## [0.1.0] - 2026-05-14

### Added

- **Notion Markdown API** — 공식 Markdown API (GET/POST/PATCH)로 변환 품질 대폭 향상
- **Notion File Upload API** — 로컬 이미지를 Notion에 직접 업로드
- **위키링크 ↔ 페이지 멘션** — `[[link]]` → Notion 페이지 멘션 양방향 매핑
- **YAML 코드블록 프로퍼티** — 프론트매터 무손실 왕복 보존
- **enhanced-md-converter** — Notion Enhanced Markdown ↔ Obsidian 마크다운 변환기
  - 수학 수식 (inline/block LaTeX)
  - HTML 테이블 → 마크다운 테이블
  - 페이지 링크 → 위키링크
  - 색상 스팬 제거
  - 빈 블록 정리
  - 파이프 이스케이프 해제
- **콜아웃 타입 보존** — preserve marker로 원본 콜아웃 타입 완벽 복원
- **15+ Notion 블록 타입 양방향 변환** — 제목, 코드, 리스트, 수식, 콜아웃, 토글, 테이블, 컬럼, 구분선, 임베드
- **프론트매터 ↔ Notion 속성 매핑** — 15+ 프로퍼티 타입 (select, multi-select, date, number, checkbox, URL, people, status 등)
- **Database 부모 모드** — `parentMode: "database"` 설정으로 DB 행 동기화
- **토글/컬럼/구분선/비디오/임베드** 양방향 변환
- **색상/밑줄/멘션** 보존
- **보존 마커 시스템** — 라운드트립 보장 (`%%im-nobsidian:...%%`)
- **3-way 머지 충돌 해결** — ask / local-wins / remote-wins / manual 4가지 전략
- **.im-nobsidian-ignore** 경로 필터링 (.gitignore 형식)
- **CLI 8개 명령어** — init, push, pull, sync, status, diff, resolve, watch
- **동기화 방향 제한** — `sync.direction: "push" / "pull" / "both"`
- **Force push** — `--force` 옵션으로 충돌 파일 강제 push
- **Dry run** — `--dry-run`으로 예정 작업 수 미리 확인
- **중복 파일명 처리** — Pull 시 `Name (1).md` ~ `Name (99).md` 자동 부여
- **중단 복구** — `cleanupInterruptedSync()`로 자동 정리
- **파일 감시 + 자동 동기화** — chokidar 기반 watch 모드
- **Rate limiting** — async-sema 3 req/s + exponential backoff + jitter
- **SQLite WAL 상태 DB** — 트랜잭션 기반 원자적 상태 관리
- **이미지 Pull 다운로드** — 중복 제거 + attachments 폴더 자동 관리
- **폴더 구조 → Notion 페이지 계층** 양방향 매핑
- **CLI 비대화형 모드** — `init --non-interactive --token xxx --root-page-id xxx`
- **CLI --verbose / --quiet** 글로벌 옵션
- **VaultFS.readBinary()** — 이미지 업로드용 바이너리 파일 읽기
- 377 단위 테스트 + 11 E2E 테스트 (실제 Notion API)
- 라운드트립 테스트 20개 (토글, 위키링크, 이미지, 프론트매터, 중첩구조)
- 테스트 픽스처 14개
- OSS 문서 완비 (README EN/KO, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, CHANGELOG)
- CI/CD (GitHub Actions, Node 20+22 매트릭스, dependabot, audit)

### Known Limitations

- **이미지 Push** — Notion API 제한으로 직접 업로드 불가, 플레이스홀더 보존
- **빈 줄 압축** — Notion Markdown API가 빈 줄을 정규화 (렌더링 차이 없음)
- **첫 Push 위키링크** — 새 페이지 간 교차 참조는 첫 동기화 시 미해결, 이후 자동 해결
- **Notion 전용 블록** — 버튼/폼/동기블록은 API가 unsupported 반환, 플레이스홀더 보존
- **Rate limit** — Notion 공식 제한 3 req/s

## [0.0.1] - 2026-05-08

### Added

- Project initial structure (pnpm monorepo: core, cli, obsidian-plugin)
- Core conversion engine (ConversionPipeline, 13 pre/post processors)
- Sync engine (SyncOrchestrator, ChangeDetector, StateDB, NotionClient)
- Block converter integration (@tryfabric/martian + notion-to-md)
- Image handler with deduplication
- Tree mapper for folder structure mapping
- File watcher (chokidar) + auto sync service
- Three-way merge conflict resolution
- CLI: 8 commands (init, push, pull, sync, status, diff, resolve, watch)
- Obsidian plugin: settings, vault adapter, conflict modal, status bar
- 191 unit tests + 11 E2E tests (real Notion API)
- GitHub Actions CI/CD pipeline
- Husky pre-commit + commit-msg hooks
- Changeset-based version management
- ESLint + Prettier configuration
- Documentation structure (7 categories)
- Architecture Decision Records (3 ADRs)
