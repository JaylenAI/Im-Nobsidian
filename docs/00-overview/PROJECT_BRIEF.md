# Project Brief — Im-Nobsidian

> 작성일: 2026-05-08
> 상태: draft

## 왜 만드는가

Obsidian과 Notion을 동시에 사용하는 사람들은 두 도구 사이에서 콘텐츠를 수동으로
복사/붙여넣기하거나, 내보내기/가져오기를 반복해야 한다. 이 과정에서:

1. **서식이 깨진다** — Notion 내보내기 → Obsidian 가져오기 시 마크다운 형식 불일치
2. **내용이 분산된다** — 어디에 최신 버전이 있는지 추적 불가
3. **반복 작업이 발생한다** — 한쪽 수정 → 다른쪽 수동 반영

## 어떤 문제를 푸는가

- Obsidian에서 작성한 노트가 Notion에 **자동으로 반영**되고
- Notion에서 편집한 내용이 Obsidian으로 **자동으로 돌아오며**
- 두 시스템의 **서로 다른 마크다운/블록 형식을 정확히 변환**해주는 도구

## 핵심 가치

| #   | 가치         | 설명                                               |
| --- | ------------ | -------------------------------------------------- |
| 1   | **양방향**   | 한쪽만이 아닌, 어디서 편집해도 동기화              |
| 2   | **무손실**   | 변환 과정에서 데이터 손실 최소화 + 라운드트립 안전 |
| 3   | **안전**     | 충돌 시 데이터 파괴 없음, conflict copy 생성       |
| 4   | **오픈소스** | 무료, 투명, 커뮤니티 기여 가능                     |

## 타겟 사용자

### 페르소나 1: 지식 워커

- Obsidian: 개인 메모, 학습 정리, 아이디어 연결 (그래프)
- Notion: 팀 협업, 프로젝트 관리, 공유 문서
- 니즈: 개인 메모 중 공유할 것만 Notion에 자동 동기화

### 페르소나 2: 콘텐츠 크리에이터

- Obsidian: 초안 작성, 리서치 정리 (로컬, 빠름)
- Notion: 발행 파이프라인, 편집자 협업
- 니즈: Obsidian에서 쓴 글이 Notion에 올라가면 편집자가 수정 → 수정본 다시 Obsidian으로

### 페르소나 3: 개발자

- Obsidian: 기술 노트, TIL, 코드 스니펫 (Git 연동)
- Notion: 팀 위키, 온보딩 문서, 회의록
- 니즈: 로컬 기술 노트 정리본을 팀 위키로 자동 동기화

## 차별점 (기존 도구 대비)

| 기존 도구                      | 한계                          | Im-Nobsidian                  |
| ------------------------------ | ----------------------------- | ----------------------------- |
| obsidian-to-notion (EasyChris) | 단방향, 2단계 중첩 제한       | 양방향, 무제한 중첩           |
| Nobsidion                      | 단방향, Rate limit 없음, 방치 | 양방향, Rate limit, 활발 유지 |
| Notion 내보내기                | 수동, 형식 깨짐               | 자동, 형식 보존               |

## MVP 범위 (v1.0)

### Must Have

- [ ] 마크다운 ↔ Notion 블록 양방향 변환 (A+B등급 기능)
- [ ] 파일/폴더 구조 ↔ Notion 페이지 계층 매핑
- [ ] SHA-256 기반 변경 감지 + 델타 동기화
- [ ] 충돌 감지 + conflict copy 생성
- [ ] CLI (init, sync, push, pull, status)
- [ ] Obsidian 플러그인 (커맨드 팔레트 + 설정 탭)

### Should Have

- [ ] [[위키링크]] ↔ Notion 페이지 멘션 양방향 변환
- [ ] 콜아웃 ↔ Callout 블록 양방향 변환
- [ ] 프론트매터 ↔ Notion 페이지 속성
- [ ] 이미지 업로드/다운로드
- [ ] 자동 동기화 (파일 감시 + 웹훅)

### Could Have

- [ ] Notion 데이터베이스 → 폴더 + 프론트매터 파일
- [ ] Notion Relations → [[위키링크]]
- [ ] 대규모 볼트 최적화 (벌크 연산)
- [ ] 크로스플랫폼 데스크톱 앱 (Tauri)

### Won't Have (v1에서 제외)

- 모바일 앱
- Dataview 쿼리 동기화
- Notion 댓글 동기화
- 실시간 협업 편집

## 기술 스택

| 영역        | 기술                                |
| ----------- | ----------------------------------- |
| 언어        | TypeScript (strict)                 |
| 런타임      | Node.js 20+                         |
| 패키지 관리 | pnpm workspaces (monorepo)          |
| 빌드        | tsup (core, cli) / esbuild (plugin) |
| 테스트      | vitest                              |
| CI/CD       | GitHub Actions                      |
| DB          | SQLite (better-sqlite3)             |
| Notion SDK  | @notionhq/client                    |
| MD→Notion   | @tryfabric/martian                  |
| Notion→MD   | notion-to-md                        |
| 파일 감시   | chokidar                            |
| 검증        | zod                                 |

## 성공 지표

- GitHub Stars: 100+ (6개월 내)
- npm 주간 다운로드: 500+ (6개월 내)
- Obsidian 커뮤니티 플러그인 등록 완료
- 라운드트립 테스트 통과율: 95%+
- 테스트 커버리지: 80%+
