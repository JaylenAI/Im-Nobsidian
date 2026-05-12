# 제품 요구사항 정의서 (PRD)

> 작성일: 2026-05-08
> 상태: complete

---

## 제품 비전

> **어디서 작성하든, 양쪽에서 동일하게.**
>
> Obsidian의 로컬 마크다운 파워와 Notion의 협업 편의성을
> 하나의 워크플로로 통합하는 오픈소스 양방향 동기화 도구.

---

## 기능 요구사항 (MoSCoW)

### Must Have — v0.1.0 (MVP)

핵심 동기화 루프가 동작하는 최소 버전.

| ID   | 기능                   | 상세                                                                                              | 검증 기준                          |
| ---- | ---------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------- |
| M-01 | MD → Notion 블록 변환  | A등급 전체 (heading, paragraph, list, todo, quote, divider, link, bold/italic/strikethrough/code) | 12개 A등급 요소 라운드트립 통과    |
| M-02 | Notion 블록 → MD 변환  | 위와 동일 역방향                                                                                  | 동일                               |
| M-03 | 라운드트립 안전성      | MD→Notion→MD 변환 후 원본과 동일                                                                  | 자동화 테스트 100% 통과            |
| M-04 | SHA-256 변경 감지      | 파일/페이지별 해시 비교로 변경 여부 판단                                                          | 미변경 파일 skip 확인              |
| M-05 | Push (Obsidian→Notion) | 로컬 변경사항을 Notion에 반영                                                                     | 신규/수정/삭제 모두 처리           |
| M-06 | Pull (Notion→Obsidian) | Notion 변경사항을 로컬에 반영                                                                     | 신규/수정 처리                     |
| M-07 | Sync (양방향)          | Pull + Push 순차 실행                                                                             | 양쪽 변경사항 모두 반영            |
| M-08 | 폴더 ↔ 페이지 계층     | Obsidian 폴더 구조를 Notion 페이지 계층으로 매핑                                                  | 3단계 중첩 폴더 테스트             |
| M-09 | 충돌 감지              | 양쪽 동시 편집 시 충돌 감지                                                                       | Three-Way Merge base snapshot 기반 |
| M-10 | 충돌 해결              | 로컬우선/원격우선/수동병합/사본 생성                                                              | 4가지 정책 모두 동작               |
| M-11 | CLI init               | 대화형 초기 설정 (토큰, 루트 페이지, 폴더 선택)                                                   | `nobsi init` 정상 완료             |
| M-12 | CLI push/pull/sync     | 수동 동기화 명령                                                                                  | 각 명령 정상 동작                  |
| M-13 | CLI status             | 변경된 파일 목록 표시                                                                             | git status 유사 출력               |
| M-14 | State DB (SQLite)      | 동기화 상태 영속 저장                                                                             | 재시작 후 상태 유지                |
| M-15 | Rate Limit 처리        | async-sema 3 req/s + 429 자동 백오프                                                              | 100 파일 push 시 429 없음          |
| M-16 | 에러 복구              | 네트워크 오류 시 재시도 + 부분 동기화                                                             | 중간 실패 후 재시도 성공           |

### Should Have — v0.2.0

일상 사용에 필요한 핵심 변환 + 플러그인.

| ID   | 기능                    | 상세                                                                        | 검증 기준                        |
| ---- | ----------------------- | --------------------------------------------------------------------------- | -------------------------------- |
| S-01 | 위키링크 ↔ 멘션         | `[[Page]]` → Notion page mention, 역방향 포함                               | 매핑 테이블 기반 양방향          |
| S-02 | 콜아웃 ↔ Callout        | 타입→아이콘/색상 매핑 (13개 타입)                                           | foldable 메타 보존               |
| S-03 | 프론트매터 ↔ Properties | 8개 타입 매핑 (string/number/boolean/date/select/multi_select/url/checkbox) | 역방향 복원 일치                 |
| S-04 | 이미지 동기화           | Push: 로컬→Notion 업로드. Pull: Notion→로컬 즉시 다운로드                   | SHA-256 중복 방지, 만료 URL 처리 |
| S-05 | 코드 블록               | 언어명 매핑 테이블                                                          | 30+ 언어 테스트                  |
| S-06 | 수식 (LaTeX)            | `$inline$`, `$$block$$` ↔ Notion equation                                   | 라운드트립 통과                  |
| S-07 | Mermaid                 | 코드 블록 언어 보존                                                         | Notion에서 렌더링 확인           |
| S-08 | Obsidian 플러그인 기본  | 설정 화면, Sync 버튼, 상태바                                                | 커뮤니티 플러그인 등록 가능      |
| S-09 | 동기화 폴더 선택        | include/exclude 폴더 설정                                                   | 지정 폴더만 동기화               |
| S-10 | .im-nobsidian/ignore    | gitignore 문법으로 파일/폴더 무시                                           | 패턴 매칭 정확                   |
| S-11 | 파일 이동/이름변경 감지 | rename 이벤트로 Notion 페이지 제목/위치 업데이트                            | 중복 생성 없음                   |
| S-12 | Preserve Marker 시스템  | `%% im-nobsidian:... %%` 마커로 라운드트립 보존                             | 모든 C등급 기능에 적용           |

### Could Have — v0.3.0 ~ v0.5.0

데이터베이스, 고급 변환, 자동화.

| ID   | 기능                   | 상세                                                                     | 검증 기준                 |
| ---- | ---------------------- | ------------------------------------------------------------------------ | ------------------------- |
| C-01 | Notion DB → 폴더       | Database를 폴더 + frontmatter .md 파일로 매핑                            | Row 추가/수정/삭제 양방향 |
| C-02 | DB Views               | Table→Dataview/Bases, Board→Kanban, Calendar→CALENDAR, Gallery→DataCards | 6종 뷰 자동 생성          |
| C-03 | Relation → 위키링크    | relation property ↔ frontmatter `[[link]]` 배열                          | 양방향 + 백링크           |
| C-04 | Rollup → Dataview      | rollup ↔ Dataview 집계 + 캐시                                            | sum/avg/count 테스트      |
| C-05 | Formula → Bases        | Notion formula 자동 변환 + 불가 시 캐시                                  | 10개+ 함수 매핑           |
| C-06 | 인라인 색상            | span+CSS 클래스 ↔ Notion annotations.color                               | 20개 색상 양방향          |
| C-07 | Column Layout          | callout 컬럼 ↔ column_list                                               | 2~5 컬럼 테스트           |
| C-08 | Toggle Heading         | callout 접기 ↔ is_toggleable heading                                     | 레벨 1/2/3                |
| C-09 | 자동 동기화 (플러그인) | 파일 저장 시 자동 push, 주기적 pull                                      | 디바운스 정상             |
| C-10 | 벌크 연산              | Notion Bulk API (100 페이지 일괄)                                        | 대량 push 성능 향상       |
| C-11 | 태그 동기화            | YAML tags ↔ multi_select + 인라인 #tag 보존                              | 계층형 태그 포함          |
| C-12 | 커버/아이콘            | frontmatter ↔ Notion cover/icon                                          | Banner 플러그인 호환      |
| C-13 | Synced Block           | transclusion ↔ synced block                                              | 읽기 전용 표시            |
| C-14 | Dataview 보존          | 코드 블록 보존 + 정적 테이블 옵션                                        | 라운드트립 원본 유지      |
| C-15 | Embed 변환             | iframe ↔ embed/video/bookmark 블록                                       | YouTube 테스트            |
| C-16 | diff 명령              | `nobsi diff` 로 파일별 변경 비교                                         | 컬러 출력                 |

### Won't Have — v1.0 이후 또는 범위 외

| 기능                                       | 이유                                        |
| ------------------------------------------ | ------------------------------------------- |
| 실시간 협업 (CRDT)                         | 복잡도 극단적, Notion이 이미 제공           |
| Notion 댓글 동기화                         | 개념이 다름 (토론 스레드 vs 인라인 주석)    |
| Notion 자동화/버튼 동기화                  | API 미지원 블록 타입                        |
| Dataview 실시간 실행                       | Notion에서 실행 불가 (Obsidian 전용 런타임) |
| 다른 서비스 연동 (Google Docs, Confluence) | 범위 외                                     |
| GUI 데스크톱 앱                            | CLI + 플러그인으로 충분                     |

---

## 비기능 요구사항

### 성능

| 지표            | 기준                       | 측정 방법                |
| --------------- | -------------------------- | ------------------------ |
| 100 파일 동기화 | 5분 이내                   | E2E 벤치마크             |
| 단일 파일 push  | 3초 이내 (100블록 미만)    | 단위 벤치마크            |
| 변경 감지       | 1초 이내 (1000 파일 vault) | SHA-256 해시 비교 시간   |
| 메모리 사용     | 200MB 미만                 | 1000 파일 동기화 시 peak |
| State DB 크기   | 파일당 ~1KB                | 10,000 파일 = ~10MB      |

### 안정성

| 지표                  | 기준                         |
| --------------------- | ---------------------------- |
| 데이터 손실           | 0건 (절대 원칙)              |
| 동기화 중 크래시 복구 | 재시작 후 이어서 동기화      |
| 부분 실패 처리        | 성공분 유지, 실패분만 재시도 |
| State DB 백업         | 매 동기화 전 자동 백업       |

### 호환성

| 항목          | 지원 범위             |
| ------------- | --------------------- |
| Node.js       | 20, 22 (LTS)          |
| OS            | macOS, Linux, Windows |
| Obsidian      | 1.4.0+ (데스크톱)     |
| Notion API    | 2026-03-11 버전       |
| 패키지 매니저 | npm, pnpm, yarn       |

### 테스트

| 항목              | 기준                 |
| ----------------- | -------------------- |
| 코드 커버리지     | 80%+ (core 패키지)   |
| 라운드트립 테스트 | 모든 A/B등급 기능    |
| E2E 테스트        | 주요 시나리오 8개    |
| Notion API 모킹   | 전체 엔드포인트 mock |

### 문서

| 항목            | 언어          |
| --------------- | ------------- |
| README.md       | 한국어 + 영어 |
| API 문서        | 영어 (TSDoc)  |
| 설정 가이드     | 한국어 + 영어 |
| CONTRIBUTING.md | 한국어        |

---

## 릴리스 계획

```
v0.1.0 (MVP)           ← Must Have 전체
  → 핵심 변환 + CLI + 수동 동기화
  → GitHub 릴리스 + npm 배포

v0.2.0 (Essential)     ← Should Have 전체
  → 위키링크, 콜아웃, 프론트매터, 이미지
  → Obsidian 커뮤니티 플러그인 등록

v0.3.0 (Database)      ← C-01 ~ C-05
  → Notion Database 양방향 동기화

v0.4.0 (Visual)        ← C-06 ~ C-09
  → 인라인 색상, 컬럼, 토글, 자동 동기화

v0.5.0 (Polish)        ← C-10 ~ C-16
  → 벌크 연산, 고급 변환, diff 명령

v1.0.0 (Stable)
  → 전체 안정화 + 문서 완성 + 성능 최적화
```

---

## 성공 지표

| 지표                     | 목표 (출시 6개월) |
| ------------------------ | ----------------- |
| GitHub Stars             | 500+              |
| npm 주간 다운로드        | 200+              |
| Obsidian 플러그인 설치   | 1,000+            |
| 오픈 이슈 대비 해결률    | 80%+              |
| 라운드트립 테스트 통과율 | 100%              |

---

## 기술 아키텍처 결정 (요약)

| 결정            | 선택                          | 이유                            | ADR     |
| --------------- | ----------------------------- | ------------------------------- | ------- |
| 모노레포        | pnpm workspace                | 코드 공유, 버전 일관성          | ADR-001 |
| 상태 저장       | better-sqlite3                | 네이티브 5-10x 빠름, 트랜잭션   | ADR-002 |
| 라운드트립 보존 | preserve marker               | 비침투적, 파서 안전             | ADR-003 |
| MD→Notion       | @tryfabric/martian + 전처리기 | 검증된 라이브러리 + 커스텀 확장 | -       |
| Notion→MD       | notion-to-md + 후처리기       | 검증된 라이브러리 + 커스텀 확장 | -       |
| Rate Limit      | async-sema (3 concurrent)     | 공식 권장 패턴                  | -       |
| 변경 감지       | SHA-256 해시 비교             | 정확, 빠름                      | -       |
| 충돌 해결       | Three-Way Merge               | git 방식, 검증됨                | -       |
