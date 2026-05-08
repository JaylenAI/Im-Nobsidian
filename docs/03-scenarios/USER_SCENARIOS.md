# 사용자 시나리오

> 작성일: 2026-05-08
> 상태: complete

---

## 페르소나 정의

| 페르소나 | 역할              | Obsidian 숙련도 | Notion 숙련도  | 동기화 니즈                 |
| -------- | ----------------- | --------------- | -------------- | --------------------------- |
| 민수     | 백엔드 개발자     | 상 (일상 PKM)   | 중 (팀 협업)   | 개인 노트 → 팀 공유         |
| 지은     | 콘텐츠 크리에이터 | 중 (글쓰기)     | 상 (기획/관리) | Notion 기획 → Obsidian 집필 |
| 현우     | 스타트업 CTO      | 상 (기술 문서)  | 상 (회사 위키) | 기술 문서 양방향 동기화     |

---

## 페르소나 1: 민수 (백엔드 개발자)

### 배경

- Obsidian에 개인 기술 노트 500+ 개 보유
- 회사에서 Notion을 팀 위키로 사용
- 개인 노트 중 일부를 팀에 공유하고 싶지만 복붙은 귀찮고 포맷이 깨짐
- CLI 사용에 익숙, 터미널에서 모든 걸 하고 싶음

### 시나리오 1-1: 최초 셋업 (CLI)

```
# 민수의 터미널

$ npm install -g obsinotion
$ cd ~/Documents/MyVault
$ obsinotion init

? Notion API Token:
  → 안내 메시지 표시:
  "1. https://www.notion.so/my-integrations 접속
   2. 'New Integration' 클릭
   3. 이름: ObsiNotion, 유형: Internal
   4. Capabilities: Read/Update/Insert content 체크
   5. 토큰 복사하여 붙여넣기"

? Token: ntn_xxxxxxxxxxxxx ✅ 유효

? 동기화 루트 페이지 선택:
  1. 팀 위키 (id: abc...)
  2. 민수의 개인 공간 (id: def...)
  3. 프로젝트 관리 (id: ghi...)
  → 선택: [2] 민수의 개인 공간

? 동기화 모드:
  [1] 전체 Vault 동기화
  [2] 특정 폴더만 선택 (권장)
  → 선택: [2]

? 동기화할 폴더 선택 (스페이스로 토글):
  [x] Projects/
  [x] Notes/Tech/
  [ ] Notes/Personal/     ← 개인 일기는 제외
  [ ] Daily/              ← 데일리 노트는 제외
  [ ] templates/          ← 템플릿 제외
  [x] Shared/             ← 팀 공유용 폴더

? 충돌 해결 기본 정책:
  [1] 로컬 우선 (Obsidian 버전 유지)
  [2] 원격 우선 (Notion 버전 유지)
  [3] 매번 물어보기 (권장)
  → 선택: [3]

✅ 설정 완료!
  설정 파일: .obsinotion/config.json
  상태 DB: .obsinotion/sync.db
  무시 파일: .obsinotion/ignore (수정 가능)

다음 단계:
  $ obsinotion push     ← 로컬 → Notion 첫 전송
  $ obsinotion status   ← 현재 상태 확인
```

### 시나리오 1-2: 일상 워크플로

```
[아침 — 출근]
$ obsinotion pull
📥 Pull 완료: 3개 파일 업데이트
  → Shared/API-가이드.md (팀원이 Notion에서 수정)
  → Projects/인증모듈.md (코드리뷰 코멘트 반영)
  → Notes/Tech/Docker-Tips.md (새로 추가됨)

[오후 — 기술 노트 작성]
Obsidian에서 Notes/Tech/Redis-캐싱전략.md 작성...

$ obsinotion status
📊 상태:
  수정됨: Notes/Tech/Redis-캐싱전략.md (신규)
  수정됨: Projects/인증모듈.md (로컬 편집)
  동기화됨: 나머지 147개 파일

$ obsinotion push
📤 Push 완료:
  생성: Notes/Tech/Redis-캐싱전략.md → Notion 페이지 생성
  수정: Projects/인증모듈.md → Notion 페이지 업데이트

[퇴근 전 — 최종 동기화]
$ obsinotion sync
🔄 Sync 완료: Pull 1건, Push 0건, 충돌 0건
```

### 시나리오 1-3: 충돌 발생

```
[상황] 민수가 Obsidian에서, 팀원이 Notion에서 같은 파일을 편집

$ obsinotion sync

⚠️ 충돌 발견: Shared/API-가이드.md

변경 비교:
  로컬 (Obsidian):
    + ## 인증 헤더
    + Bearer 토큰을 Authorization 헤더에 포함
  원격 (Notion):
    + ## 인증 방식
    + OAuth 2.0 플로우를 사용하여 접근 토큰 획득

? 해결 방법:
  [1] 로컬 유지 (내 버전)
  [2] 원격 유지 (팀원 버전)
  [3] 수동 병합 (충돌 마커 삽입 → 에디터에서 해결)
  [4] 충돌 사본 생성 (둘 다 보존)
  → 선택: [4]

✅ 충돌 사본 생성됨:
  원본: Shared/API-가이드.md (원격 버전 반영)
  사본: Shared/API-가이드 (conflict 2026-05-08).md (내 버전)
  → 두 파일을 비교하고 수동으로 통합하세요
```

---

## 페르소나 2: 지은 (콘텐츠 크리에이터)

### 배경

- Notion에서 콘텐츠 기획, 캘린더 관리, 취재 노트 정리
- Obsidian에서 장문 글쓰기 (블로그, 뉴스레터, 책 집필)
- CLI 사용 경험 없음, GUI 선호
- Notion Database로 콘텐츠 관리 중

### 시나리오 2-1: 플러그인 최초 설정

```
[Obsidian 앱 열기]
설정 → 커뮤니티 플러그인 → 찾아보기 → "ObsiNotion" 검색 → 설치 → 활성화

[ObsiNotion 설정 화면]
┌─────────────────────────────────────────────┐
│ ObsiNotion Sync 설정                         │
├─────────────────────────────────────────────┤
│                                              │
│ Notion API Token                             │
│ ┌──────────────────────────────────────┐     │
│ │ ntn_xxxxx...                        │     │
│ └──────────────────────────────────────┘     │
│ ℹ️ Notion Integration 토큰을 입력하세요      │
│ 📖 토큰 발급 방법 보기                       │
│                                              │
│ ✅ 토큰 유효성 확인 완료                      │
│                                              │
│ 동기화 루트 페이지                            │
│ ┌──────────────────────────────────────┐     │
│ │ 📄 콘텐츠 작업 공간          ▼      │     │
│ └──────────────────────────────────────┘     │
│                                              │
│ 동기화 폴더                                   │
│ ☑ Blog/                                      │
│ ☑ Newsletter/                                │
│ ☑ Research/                                  │
│ ☐ Personal/                                  │
│                                              │
│ 자동 동기화                                   │
│ ☑ 파일 저장 시 자동 Push (10초 디바운스)      │
│ ☑ 앱 시작 시 자동 Pull                       │
│ ☐ 주기적 Pull (간격: 5분)                    │
│                                              │
│ 충돌 해결                                     │
│ ◉ 매번 물어보기                              │
│ ○ 로컬 우선                                  │
│ ○ 원격 우선                                  │
│                                              │
│ [저장]  [지금 동기화]  [연결 테스트]           │
└─────────────────────────────────────────────┘
```

### 시나리오 2-2: Notion DB 기획 → Obsidian 집필

```
[Step 1] 지은이 Notion에서 콘텐츠 기획

Notion "콘텐츠 캘린더" Database:
┌──────────────┬────────┬──────────┬─────────┐
│ 제목         │ 상태   │ 발행일   │ 카테고리│
├──────────────┼────────┼──────────┼─────────┤
│ AI 글쓰기 도구│ 기획중 │ 06-15   │ Tech    │
│ 여행 에세이   │ 초안   │ 06-20   │ Life    │
│ 독서 리뷰     │ 완료   │ 06-01   │ Book    │
└──────────────┴────────┴──────────┴─────────┘

"AI 글쓰기 도구" 페이지에 개요 작성:
  # AI 글쓰기 도구 비교
  ## 서론
  AI가 글쓰기를 어떻게 바꾸고 있는지...
  ## 비교 대상
  - ChatGPT
  - Claude
  - Gemini
```

```
[Step 2] Obsidian에서 Pull (자동 또는 수동)

상태바: "🔄 동기화 중..."

📥 새 콘텐츠 수신:
  databases/콘텐츠 캘린더/AI 글쓰기 도구.md (신규)
  databases/콘텐츠 캘린더/여행 에세이.md (신규)
  databases/콘텐츠 캘린더/독서 리뷰.md (신규)
  databases/콘텐츠 캘린더/_schema.yml (DB 메타)
  databases/콘텐츠 캘린더/_views/전체.base (테이블 뷰)

상태바: "✅ 동기화 완료 — 5개 파일 추가"
```

```
[Step 3] Obsidian에서 "AI 글쓰기 도구.md" 열기

파일 내용:
---
notion_id: "page-uuid-ai-writing"
notion_uid: "CONTENT-7"
title: "AI 글쓰기 도구 비교"
status: "기획중"
publish_date: 2026-06-15
category: "Tech"
---

# AI 글쓰기 도구 비교

## 서론

AI가 글쓰기를 어떻게 바꾸고 있는지...

## 비교 대상

- ChatGPT
- Claude
- Gemini
```

```
[Step 4] 지은이 Obsidian에서 본문 집필 (Obsidian의 강점 활용)

장점:
  → 로컬 파일이라 오프라인에서도 작업 가능
  → Vim 모드, 빠른 검색, 그래프 뷰 활용
  → 다른 노트를 [[위키링크]]로 참조하며 글쓰기
  → 집중 모드로 방해 없이 글 작성

집필 후 프론트매터 수정:
  status: "초안"    ← "기획중" → "초안"으로 변경
```

```
[Step 5] 저장 → 자동 Push (10초 후)

상태바: "📤 동기화 중..." → "✅ 완료"

Notion에서 확인:
  → "AI 글쓰기 도구" 페이지 본문이 업데이트됨
  → 상태 속성이 "초안"으로 자동 변경됨
  → 콘텐츠 캘린더 Board 뷰에서 카드가 "기획중" → "초안" 레인으로 이동됨!
```

### 시나리오 2-3: 취재 노트 (Notion) → 참고 자료 (Obsidian)

```
[상황] 지은이 외출 중 모바일 Notion에서 취재 메모 작성

Notion 모바일:
  "인터뷰 - 김대표" 페이지 생성
  - 빠르게 메모 작성
  - 사진 3장 첨부

[집에 돌아와서 Obsidian 실행]

앱 시작 → 자동 Pull
  📥 새 파일: Research/인터뷰 - 김대표.md
  📥 이미지 3개 다운로드 → attachments/

지은: Obsidian에서 취재 노트를 정리하며 글에 반영
  → [[인터뷰 - 김대표]]를 블로그 글에서 참조
  → 그래프 뷰에서 연결 관계 확인
```

---

## 페르소나 3: 현우 (스타트업 CTO)

### 배경

- 10명 규모 스타트업
- Notion: 회사 위키, 온보딩 문서, 회의록
- Obsidian: 개인 기술 메모, 아키텍처 설계, 의사결정 기록
- 회사 위키 ↔ 개인 노트를 연결하고 싶음

### 시나리오 3-1: 아키텍처 문서 양방향 관리

````
[현우가 Obsidian에서 아키텍처 설계]

Notes/Architecture/인증-시스템-설계.md:
---
tags:
  - architecture
  - auth
status: review
---

# 인증 시스템 설계

## 요구사항

[[제품 요구사항]] 문서의 보안 섹션 참조.

## 방안 비교

### 방안 A: JWT + Refresh Token

> [!tip] 추천
> 모바일 앱 지원에 유리

```mermaid
sequenceDiagram
    Client->>Server: POST /login
    Server->>Client: JWT + Refresh Token
    Client->>Server: GET /api (JWT)
    Server->>Client: 200 OK
```​

### 방안 B: Session + Redis

> [!warning] 주의
> 서버 스케일링 시 세션 공유 문제

$$\text{Latency} = T_{redis} + T_{validation}$$

## 결론

방안 A 채택. 근거: [[ADR-005-JWT-인증]]
````

````
[Push 후 Notion에서 보이는 결과]

📄 인증 시스템 설계
  Properties: tags=[architecture, auth], status=review

  # 인증 시스템 설계

  ## 요구사항
  @제품 요구사항 문서의 보안 섹션 참조.     ← mention 링크

  ## 방안 비교

  ### 방안 A: JWT + Refresh Token

  💡 추천                                   ← 초록 callout
  │ 모바일 앱 지원에 유리

  ```mermaid                                ← Notion에서 렌더링됨!
  sequenceDiagram
      Client->>Server: POST /login
      ...
````

### 방안 B: Session + Redis

⚠️ 주의 ← 노란 callout
│ 서버 스케일링 시 세션 공유 문제

E = Latency = T_redis + T_validation ← 수식 렌더링됨!

## 결론

방안 A 채택. 근거: @ADR-005-JWT-인증

```

```

[팀원이 Notion에서 코멘트 추가 + 일부 수정]

팀원이 "방안 B" 섹션에 텍스트 추가:
"Redis Cluster 사용 시 해결 가능 — 비용 검토 필요"

[현우가 Obsidian에서 Pull]

$ obsinotion pull
📥 업데이트: Notes/Architecture/인증-시스템-설계.md
→ diff 표시: ### 방안 B: Session + Redis + Redis Cluster 사용 시 해결 가능 — 비용 검토 필요

```

### 시나리오 3-2: 온보딩 문서 Notion DB → Obsidian 참조

```

[상황] Notion에 온보딩 체크리스트 DB가 있음

Notion "온보딩 체크리스트" Database:
┌─────────────────┬────────┬──────┬────────┐
│ 항목 │ 카테고리│ 필수 │ 담당 │
├─────────────────┼────────┼──────┼────────┤
│ 슬랙 가입 │ 도구 │ ✅ │ 인사팀 │
│ GitHub 권한 │ 개발 │ ✅ │ CTO │
│ AWS 콘솔 접근 │ 인프라 │ ✅ │ DevOps │
│ 코드 컨벤션 읽기│ 개발 │ ✅ │ - │
│ 사내 위키 구경 │ 문화 │ ☐ │ - │
└─────────────────┴────────┴──────┴────────┘

[Pull 결과]

databases/온보딩 체크리스트/
├── 슬랙 가입.md
│ ---
│ category: "도구"
│ required: true
│ assignee: "인사팀"
│ ---
│ 슬랙 워크스페이스 초대 링크...
│
├── GitHub 권한.md
├── AWS 콘솔 접근.md
├── 코드 컨벤션 읽기.md
├── 사내 위키 구경.md
├── \_schema.yml
└── \_views/
├── 전체.base ← Bases 테이블 뷰
└── 카테고리별.md ← Dataview GROUP BY

[현우의 활용]

Obsidian에서 개인 노트에 참조:

# 신규 입사자 온보딩 개선 메모

현재 [[GitHub 권한]] 절차가 3일 걸림 → 자동화 필요
[[코드 컨벤션 읽기]]에 테스트 가이드 추가해야 함
→ 그래프 뷰에서 온보딩 항목들과의 연결 시각화

```

---

## 실제 유저 플로우: 처음부터 끝까지

### GitHub 오픈소스 배포 후 유저 여정

```

[1단계: 발견]
→ GitHub에서 "obsidian notion sync" 검색
→ README.md 읽기: "양방향 동기화, 오픈소스, 무료"
→ Star 클릭 ⭐

[2단계: 설치 — CLI 사용자]
$ npm install -g obsinotion
$ obsinotion --version
obsinotion v1.0.0

[2단계: 설치 — 플러그인 사용자]
Obsidian → 설정 → 커뮤니티 플러그인 → "ObsiNotion" 검색 → 설치

[3단계: Notion Integration 생성]

1. notion.so/my-integrations 접속
2. "New Integration" 클릭
3. 이름: "ObsiNotion"
4. Capabilities: ✅ Read ✅ Update ✅ Insert
5. 토큰 복사

[4단계: Notion 페이지에 Integration 연결]
→ 동기화할 루트 페이지 열기
→ ... 메뉴 → Connections → "ObsiNotion" 추가
(⚠️ 이 단계를 빠뜨리면 403 에러)

[5단계: 초기화]
CLI: $ obsinotion init (대화형 설정)
플러그인: 설정 화면에서 토큰 + 루트 페이지 선택

[6단계: 첫 동기화]
CLI: $ obsinotion push (로컬 → Notion)
또는: $ obsinotion pull (Notion → 로컬)
플러그인: 🔄 버튼 클릭

[7단계: 일상 사용]
→ 어디서 작성하든 sync 한 번이면 양쪽 반영
→ 자동 동기화 켜면 신경 쓸 것 없음

````

---

## 동기화 정책 옵션

유저가 설정할 수 있는 동기화 행동 옵션:

### .obsinotion/config.json 구조

```json
{
  "notion": {
    "token": "ntn_xxx...",
    "rootPageId": "abc-def-123"
  },
  "sync": {
    "folders": {
      "include": ["Projects", "Notes/Tech", "Shared"],
      "exclude": [".obsidian", "templates", "Daily"]
    },
    "direction": "bidirectional",
    "conflictPolicy": "ask",
    "deletePolicy": "preserve-remote",
    "autoSync": {
      "onSave": true,
      "onSaveDebounce": 10,
      "onStart": true,
      "interval": 300
    },
    "images": {
      "download": true,
      "upload": true,
      "folder": "attachments"
    },
    "database": {
      "syncViews": true,
      "viewFormat": "dataview",
      "schemaFile": true
    }
  },
  "conversion": {
    "wikilinks": true,
    "callouts": true,
    "frontmatter": true,
    "colors": true,
    "columns": true,
    "preserveMarkers": true
  }
}
````

### 동기화 방향 옵션

| 모드            | 설명                | 사용 케이스                           |
| --------------- | ------------------- | ------------------------------------- |
| `bidirectional` | 양방향 (기본값)     | 대부분의 사용자                       |
| `push-only`     | Obsidian → Notion만 | Obsidian이 원본, Notion은 공유용      |
| `pull-only`     | Notion → Obsidian만 | Notion이 원본, Obsidian은 백업/읽기용 |

### 삭제 정책 옵션

| 정책              | 동작                                     |
| ----------------- | ---------------------------------------- |
| `preserve-remote` | 로컬 삭제해도 Notion 보존 (기본값, 안전) |
| `sync-delete`     | 로컬 삭제 시 Notion도 archive            |
| `ask`             | 매번 물어보기                            |

### 무시 파일 (.obsinotion/ignore)

```
# .obsinotion/ignore (gitignore 문법과 동일)

# Obsidian 시스템
.obsidian/

# 템플릿
templates/

# 개인 일기
Daily/
Journal/

# 대용량 첨부 파일
*.pdf
*.zip

# 특정 파일
secret-notes.md
TODO.md
```
