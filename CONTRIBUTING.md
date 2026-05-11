# Contributing to ObsiNotion

We welcome contributions! / 기여를 환영합니다!

## Getting Started / 개발 환경 설정

### Requirements / 요구 사항

- Node.js 20+
- pnpm 9+

### Setup / 설치

```bash
git clone https://github.com/JaylenAI/Obsidian_Notion_Syncer.git
cd Obsidian_Notion_Syncer
pnpm install
pnpm build
```

### Running Tests / 테스트 실행

```bash
# Unit tests / 단위 테스트
pnpm test

# With coverage / 커버리지 포함
pnpm test:coverage

# Type check / 타입 체크
pnpm typecheck

# Lint
pnpm lint

# E2E tests (requires Notion token / Notion 토큰 필요)
NOTION_TOKEN=ntn_xxx NOTION_ROOT_PAGE_ID=xxx pnpm test
```

## Branch Strategy / 브랜치 전략

- `main` — Stable releases only / 안정 릴리스 전용
- `dev` — Development integration / 개발 통합 브랜치
- `feature/*` — New features (branch from dev → merge to dev)
- `fix/*` — Bug fixes

## Commit Messages / 커밋 메시지

Korean or English. / 한국어 또는 영어로 작성합니다.

```
<type>: <subject>

<body>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`

## Pull Requests

1. Create a feature branch from `dev` / `dev`에서 feature 브랜치 생성
2. Implement changes + write tests / 변경 사항 구현 + 테스트 작성
3. Ensure all checks pass / 모든 체크 통과 확인:
   ```bash
   pnpm test && pnpm build && pnpm lint && pnpm typecheck
   ```
4. Submit PR targeting `dev` / `dev` 브랜치로 PR 제출

## Project Structure / 프로젝트 구조

```
packages/
├── core/              # @obsinotion/core — sync engine / 동기화 엔진
├── cli/               # obsinotion — CLI tool / CLI 도구
└── obsidian-plugin/   # Obsidian community plugin / 커뮤니티 플러그인
```

## Code of Conduct

Please read our [Code of Conduct](CODE_OF_CONDUCT.md) before contributing.
