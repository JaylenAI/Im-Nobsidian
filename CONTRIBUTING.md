# Contributing to ObsiNotion

기여를 환영합니다! 이 문서에서는 기여 방법을 안내합니다.

## 개발 환경 설정

### 요구 사항

- Node.js 20+
- pnpm 9+

### 설치

```bash
git clone https://github.com/JaylenAI/Obsidian_Notion_Syncer.git
cd Obsidian_Notion_Syncer
pnpm install
pnpm build
```

### 테스트 실행

```bash
# 단위 테스트
pnpm test

# 커버리지 포함
pnpm test:coverage

# E2E 테스트 (Notion 토큰 필요)
NOTION_TOKEN=ntn_xxx NOTION_ROOT_PAGE_ID=xxx pnpm test
```

## 브랜치 전략

- `main` — 안정 릴리스 전용
- `dev` — 개발 통합 브랜치
- `feature/*` — 새 기능 (dev에서 분기 → dev로 머지)
- `fix/*` — 버그 수정

## 커밋 메시지

한국어로 작성합니다.

```
<type>: <제목>

<본문>
```

타입: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`

## Pull Request

1. `dev` 브랜치에서 feature 브랜치 생성
2. 변경 사항 구현 + 테스트 작성
3. `pnpm test && pnpm build && pnpm lint` 통과 확인
4. PR 제출 (dev 브랜치로)

## 프로젝트 구조

```
packages/
├── core/              # @obsinotion/core — 동기화 엔진
├── cli/               # obsinotion — CLI 도구
└── obsidian-plugin/   # Obsidian 커뮤니티 플러그인
```

자세한 개발 가이드는 [docs/05-guides/CONTRIBUTING.md](docs/05-guides/CONTRIBUTING.md)를 참고하세요.
