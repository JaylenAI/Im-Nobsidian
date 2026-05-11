# ObsiNotion

[![CI](https://github.com/JaylenAI/Obsidian_Notion_Syncer/actions/workflows/ci.yml/badge.svg)](https://github.com/JaylenAI/Obsidian_Notion_Syncer/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/obsinotion)](https://www.npmjs.com/package/obsinotion)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green)](https://nodejs.org)

> Obsidian ↔ Notion 양방향 동기화 도구

Obsidian 볼트와 Notion 워크스페이스를 양방향으로 동기화합니다.
마크다운과 Notion 블록 형식을 정확하게 변환하며, 데이터 손실 없는 안전한 동기화를 제공합니다.

## 주요 기능

- **양방향 동기화** — Obsidian에서 편집하든 Notion에서 편집하든, 양쪽에 반영
- **정확한 변환** — 마크다운 ↔ Notion 블록 형식을 정밀하게 변환
- **안전한 충돌 해결** — 양쪽 동시 편집 시 데이터 파괴 없이 conflict copy 생성
- **데이터베이스 부모 모드** — Notion 데이터베이스에 프론트매터 ↔ 속성 매핑으로 동기화
- **폴더 구조 매핑** — Obsidian 폴더 = Notion 페이지 계층
- **델타 동기화** — 변경된 파일만 동기화 (SHA-256 해시 기반)
- **오픈소스** — MIT 라이선스, 무료, 투명

## 지원 기능

| 기능                           | Push (Obsidian → Notion) | Pull (Notion → Obsidian) |
| ------------------------------ | :----------------------: | :----------------------: |
| 제목, 본문, 서식               |            ✅            |            ✅            |
| 코드 블록 (언어별)             |            ✅            |            ✅            |
| 리스트 / 체크박스              |            ✅            |            ✅            |
| 링크 / 위키링크                |            ✅            |            ✅            |
| 콜아웃 (접기 포함)             |            ✅            |            ✅            |
| 수학 수식 (LaTeX)              |            ✅            |            ✅            |
| 테이블                         |            ✅            |            ✅            |
| 구분선                         |            ✅            |            ✅            |
| 프론트매터 ↔ 속성 (15+ 타입)   |            ✅            |            ✅            |
| 토글 블록                      |            ✅            |            ✅            |
| 컬럼 레이아웃                  |            ✅            |            ✅            |
| 색상 / 밑줄 / 멘션             |            ✅            |            ✅            |
| 비디오 / 임베드 URL            |            ✅            |            ✅            |
| 이미지                         |       플레이스홀더       |       ✅ 다운로드        |
| Notion 전용 블록 (버튼, 폼 등) |            —             |       플레이스홀더       |

## 패키지

| 패키지                | 설명                                     |
| --------------------- | ---------------------------------------- |
| `@obsinotion/core`    | 동기화 엔진 (변환 + 상태 관리)           |
| `obsinotion`          | CLI 도구                                 |
| `obsidian-obsinotion` | Obsidian 커뮤니티 플러그인 (v0.5.0 예정) |

## 빠른 시작

### CLI

```bash
# 전역 설치
npm install -g obsinotion

# 초기화 (Notion 토큰 + 루트 페이지 설정)
npx obsinotion init

# 동기화 상태 확인
npx obsinotion status

# 양방향 동기화
npx obsinotion sync

# Obsidian → Notion
npx obsinotion push

# Notion → Obsidian
npx obsinotion pull

# 파일 변경 감시 + 자동 동기화
npx obsinotion watch

# 변경사항 미리보기
npx obsinotion diff

# 충돌 해결
npx obsinotion resolve
```

### Obsidian 플러그인

> v0.5.0에서 제공 예정입니다. 현재는 CLI를 사용해주세요.

### Notion Integration 토큰 발급

1. [Notion Integrations](https://www.notion.so/my-integrations) 접속
2. "새 통합 만들기" → 이름 입력 → 제출
3. "Internal Integration Secret" 복사 (`ntn_` 으로 시작)
4. 동기화할 Notion 페이지에서 ··· → 연결 → 생성한 통합 추가

## 설정

`.obsinotion/config.json`에 설정이 저장됩니다. 주요 옵션:

```jsonc
{
  "notion": {
    "token": "ntn_...",
    "rootPageId": "...",
    "parentMode": "page", // "page" 또는 "database"
    "databaseId": "...", // parentMode가 "database"일 때 필수
  },
  "sync": {
    "direction": "both", // "push" | "pull" | "both"
    "conflictStrategy": "manual",
    "deleteSync": false,
  },
  "paths": {
    "include": ["**/*"],
    "exclude": [],
  },
}
```

## 알려진 제한사항

- **이미지 Push**: Notion API가 파일 업로드를 지원하지 않아 로컬 이미지는 플레이스홀더로 Push되고 Pull 시 복원됩니다.
- **Notion 전용 블록**: 버튼, 폼, 동기화 블록은 읽기 전용(API 제한) — 콜아웃 플레이스홀더로 보존됩니다.
- **Rate limit**: 3 req/s (Notion 공식 제한)

## 개발 환경

### 요구 사항

- Node.js 20+
- pnpm 9+

### 로컬 개발

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

### 프로젝트 구조

```
packages/
├── core/              # @obsinotion/core — 핵심 동기화 엔진
├── cli/               # obsinotion — CLI 도구
└── obsidian-plugin/   # Obsidian 커뮤니티 플러그인
```

## 문서

- [프로젝트 기획서](docs/00-overview/PROJECT_BRIEF.md)
- [현재 진행 상황](docs/06-devlog/CURRENT_STATUS.md)
- [변경 이력](docs/06-devlog/CHANGELOG.md)

## 기여

기여를 환영합니다! [기여 가이드](CONTRIBUTING.md)를 참고해주세요.

## 보안

취약점 보고는 [보안 정책](SECURITY.md)을 참고해주세요.

## 라이선스

[MIT](LICENSE)
