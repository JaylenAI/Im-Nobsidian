# Contributing to Im-Nobsidian

We welcome contributions! / 기여를 환영합니다!

## Getting Started / 개발 환경 설정

### Requirements / 요구 사항

- Node.js 20+
- pnpm 9+

### Setup / 설치

```bash
git clone https://github.com/JaylenAI/Im-Nobsidian.git
cd Im-Nobsidian
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
NOTION_TOKEN=ntn_xxx NOTION_ROOT_PAGE_ID=xxx pnpm --filter @im-nobsidian/core test
```

### Register CLI from local build / 로컬 빌드에서 CLI 등록

```bash
cd packages/cli && npm link && cd ../..
nobsi --version
```

## Branch Strategy / 브랜치 전략

- `main` — Stable releases only / 안정 릴리스 전용
- `dev` — Development integration / 개발 통합 브랜치
- `feature/*` — New features (branch from dev → merge to dev)
- `fix/*` — Bug fixes
- `docs/*` — Documentation updates

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
├── core/              # @im-nobsidian/core — sync engine / 동기화 엔진
│   ├── src/
│   │   ├── converter/     # Markdown ↔ Notion conversion / 변환 파이프라인
│   │   ├── notion/        # Notion API client / API 클라이언트
│   │   ├── state/         # SQLite state database / 상태 DB
│   │   ├── sync/          # Orchestrator, change detection / 동기화 엔진
│   │   └── utils/         # Utilities / 유틸리티
│   └── tests/
├── cli/               # im-nobsidian CLI (nobsi command) / CLI 도구
└── obsidian-plugin/   # Obsidian community plugin / 플러그인
```

## Obsidian Plugin / 옵시디언 플러그인

The Obsidian plugin ships with every release (current: v0.2.0) and uses a sql.js (WASM)
database adapter instead of better-sqlite3. Community-plugin submission is in progress.

옵시디언 플러그인은 매 릴리스에 함께 배포되며(현재 v0.2.0), better-sqlite3 대신
sql.js (WASM) DB 어댑터를 사용합니다. 커뮤니티 플러그인 공식 제출은 진행 중입니다.

## Code of Conduct

Please read our [Code of Conduct](CODE_OF_CONDUCT.md) before contributing.
