# 현재 진행 상황

> 마지막 업데이트: 2026-05-15

## v0.2.0 — Notion API 최신화 + Enhanced MD 확대 (Current)

Im-Nobsidian v0.2.0은 2026년 Notion 신규 API를 완전 통합하고,
Enhanced Markdown 변환기를 확대하여 동기화 커버리지를 ~95%로 끌어올렸습니다.

### 핵심 기능

| 기능                     | 상태            | 비고                              |
| ------------------------ | --------------- | --------------------------------- |
| Push (Obsidian → Notion) | ✅ 완료         | Markdown API + 부분 업데이트      |
| Pull (Notion → Obsidian) | ✅ 완료         | Enhanced Markdown 변환            |
| Sync (양방향)            | ✅ 완료         | Pull → Push 순차 실행             |
| 충돌 감지 + 해결         | ✅ 완료         | 4가지 전략 + 실제 원격 내용 비교  |
| 부분 업데이트            | ✅ 완료         | search-and-replace (≤20 패치)     |
| 페이지 이동              | ✅ 완료         | Move API로 히스토리/코멘트 보존   |
| 프론트매터 ↔ 속성        | ✅ 완료         | 21 읽기 + 15 쓰기 + 읽기전용 스킵 |
| 위키링크 ↔ 멘션          | ✅ 완료         | 페이지 멘션 양방향 매핑           |
| 이미지 Pull              | ✅ 완료         | 자동 다운로드 + 중복 제거         |
| 이미지 Push              | 📎 플레이스홀더 | Notion API 제한                   |
| 폴더 구조 보존           | ✅ 완료         | 1:1 페이지 계층 매핑              |

### 변환 품질

| 요소                                       |      Push       |    Pull     |
| ------------------------------------------ | :-------------: | :---------: |
| 제목/본문/서식 (bold/italic/strikethrough) |       ✅        |     ✅      |
| 코드 블록 (30+ 언어)                       |       ✅        |     ✅      |
| 리스트 (순서/비순서/체크박스)              |       ✅        |     ✅      |
| 링크 + 위키링크                            |       ✅        |     ✅      |
| 콜아웃 (접기 상태 보존)                    |       ✅        |     ✅      |
| 수학 수식 (LaTeX inline/block)             |       ✅        |     ✅      |
| 테이블                                     |       ✅        |     ✅      |
| 구분선                                     |       ✅        |     ✅      |
| 토글 블록                                  |       ✅        |     ✅      |
| 컬럼 레이아웃                              |       ✅        |     ✅      |
| 색상/밑줄 보존                             |       ✅        |   ✅ 보존   |
| 미디어 (audio/video/pdf/file)              |       ✅        |     ✅      |
| Tab 블록                                   |       ✅        |   ✅ 보존   |
| 비디오/임베드 URL                          |       ✅        |     ✅      |
| 이미지                                     | 📎 플레이스홀더 | ✅ 다운로드 |
| Notion 전용 (bookmark/embed/link preview)  |       ✅        |   ✅ 보존   |
| Notion 전용 (버튼/폼/동기블록)             |        —        |   📌 보존   |

### CLI 명령어

| 명령            | 상태 | 주요 옵션                                        |
| --------------- | ---- | ------------------------------------------------ |
| `nobsi init`    | ✅   | `--non-interactive`, `--token`, `--root-page-id` |
| `nobsi push`    | ✅   | `--dry-run`, `--force`, `--path`                 |
| `nobsi pull`    | ✅   | `--dry-run`                                      |
| `nobsi sync`    | ✅   | `--dry-run`                                      |
| `nobsi status`  | ✅   | 변경/충돌 파일 표시                              |
| `nobsi diff`    | ✅   | 패치 형식 출력                                   |
| `nobsi resolve` | ✅   | `--strategy`                                     |
| `nobsi watch`   | ✅   | 자동 동기화                                      |

### v0.1.1에서 수정된 버그

| 수정 항목                       | 증상                                 | 원인                                       | 해결                                 |
| ------------------------------- | ------------------------------------ | ------------------------------------------ | ------------------------------------ |
| `resolveParentPath()` 재귀 해석 | Pull 시 폴더가 1단계만 해석 → 평탄화 | 부모 경로를 1-depth만 조회                 | 재귀적 경로 해석으로 깊은 중첩 지원  |
| `pullCreate()` 폴더 레코드      | UNIQUE 제약 조건 충돌 (7건)          | 같은 parentPageId를 notionPageId로 사용    | 불필요한 폴더 레코드 생성 제거       |
| `isRetryable()` 확장            | 타임아웃/네트워크 에러 시 크래시     | timeout/ECONNRESET/ETIMEDOUT 미처리        | 재시도 대상 에러 코드 추가           |
| `detectLocalChanges()`          | 폴더 레코드 잘못된 삭제 감지         | folder-note/folder-only를 일반 파일로 취급 | fileType 체크로 폴더 레코드 스킵     |
| `ensureFolderPage()`            | 폴더-노트 중복 생성                  | 기존 폴더-노트 레코드 미확인               | StateDB에서 기존 레코드 확인 후 생성 |

### 실전 검증 결과

| 테스트             | 결과         | 비고                                                          |
| ------------------ | ------------ | ------------------------------------------------------------- |
| 180파일 GC_AI Push | 180/180 성공 | 0 실패, 폴더 구조 완벽 보존                                   |
| 283파일 Pull       | 283/283 성공 | 0 UNIQUE 에러, 폴더 계층 정확                                 |
| 폴더 구조 검증     | ✅ 정확      | Admin, CVfit, ERP_NextGen/Releases, Meetings, Projects, Study |

### v0.2.0에서 추가된 기능

| 기능               | 상세                                                       |
| ------------------ | ---------------------------------------------------------- |
| 부분 업데이트      | `update_content` search-and-replace (≤20 패치)             |
| 페이지 이동        | Move API로 위치 이동 (delete+create 대신)                  |
| 충돌 원격 조회     | `remoteContent` 실제 Notion 내용 조회 (빈 문자열 대신)     |
| 미디어 태그 양방향 | `<audio>/<video>/<pdf>/<file>` ↔ 이모지 링크               |
| Tab 블록 보존      | `<tab>` ↔ `> [!tab]` 콜아웃 양방향                         |
| 색상/밑줄 보존     | `<span color>/<underline>` → 보존 마커 (기존: 제거)        |
| Unknown 블록 보존  | `<unknown>` → 보존 마커 (기존: 삭제)                       |
| 읽기전용 속성 스킵 | Push 시 `created_time`/`formula`/`rollup` 등 8종 자동 스킵 |
| 타임존 정규화 확대 | `T00:00:00.000+09:00` → `YYYY-MM-DD` (KST 등 오프셋 지원)  |
| 빈 배열 제외       | `tags: []` → 프론트매터에서 자동 제외                      |

### 테스트

- **단위 테스트**: 434개 통과
- **E2E 테스트**: 11개 통과 (실제 Notion API)
- **라운드트립 테스트**: 20+ (17개 픽스처)
- **실전 동기화**: 180파일 Push + 283파일 Pull 성공

### Obsidian 플러그인

| 항목           | 상태      | 비고                              |
| -------------- | --------- | --------------------------------- |
| Plugin 클래스  | ✅ 구현   | 설정/명령/자동동기화              |
| SettingTab     | ✅ 구현   | 토큰/루트/방향/자동 설정          |
| 충돌 해결 모달 | ✅ 구현   |                                   |
| DB 어댑터      | ❌ 미완   | better-sqlite3 → sql.js 전환 필요 |
| Obsidian 검증  | ❌ 미검증 | v0.5.0에서 배포 예정              |

### 알려진 한계

| 항목             | 상태            | 비고                          |
| ---------------- | --------------- | ----------------------------- |
| 이미지 Push      | 📎 플레이스홀더 | Notion API 파일 업로드 미지원 |
| 빈 줄 압축       | 📌 Notion 동작  | 렌더링 차이 없음              |
| 첫 Push 위키링크 | ⚠️ 미해결 가능  | 후속 동기화에서 자동 해결     |
| Notion 전용 블록 | 📌 읽기 전용    | API가 unsupported 반환        |
| Rate limit       | 3 req/s         | Notion 공식 제한              |

### 기능 현황 요약

| 영역                  | 상태                          |
| --------------------- | ----------------------------- |
| Pull/Push 양방향      | ✅ 완료                       |
| 부분 업데이트         | ✅ search-and-replace         |
| 페이지 이동           | ✅ Move API                   |
| Relation Push         | ✅ wikilink ↔ relation 양방향 |
| 프론트매터 라운드트립 | ✅ 타임존 정규화 확대         |
| 이미지 Push           | ✅ File Upload API            |
| 미디어 태그           | ✅ audio/video/pdf/file       |
| 색상/밑줄 보존        | ✅ 보존 마커                  |
| Unknown 블록 보존     | ✅ 보존 마커                  |
| 블록 타입             | 25+                           |
| 속성 읽기/쓰기        | 21 읽기 + 15 쓰기             |
| 토글 블록 보존        | ✅ preserve marker            |
| CLI                   | ✅ 8개 명령어                 |

### 다음 단계

1. **v0.5.0** — Obsidian 커뮤니티 플러그인 (sql.js WASM)
2. **v1.0.0** — Database view sync, multi-workspace, 1000+ 노트
