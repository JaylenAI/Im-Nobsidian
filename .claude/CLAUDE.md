# Im-Nobsidian — 프로젝트 규칙

> 글로벌 `~/.claude/CLAUDE.md` 규칙을 상속하며, 이 파일은 프로젝트 특화 규칙만 정의.

## 프로젝트 개요

- **목적**: Obsidian ↔ Notion 양방향 동기화 오픈소스 도구
- **구조**: pnpm monorepo (core, cli, obsidian-plugin)
- **언어**: TypeScript (strict mode), ESM only
- **Node.js**: 20+

## 패키지 의존 관계

```
obsidian-plugin ──→ @im-nobsidian/core
cli ──────────────→ @im-nobsidian/core
```

- core는 다른 패키지에 의존하지 않음 (독립적)
- cli와 plugin은 core를 `workspace:*`로 참조

## 빌드/테스트 명령

```bash
pnpm install          # 의존성 설치
pnpm build            # 전체 빌드
pnpm test             # 전체 테스트
pnpm test:coverage    # 커버리지 포함 테스트
pnpm lint             # 린트
pnpm typecheck        # 타입 체크
```

## 개발 규칙

### 코드 구조

- core 패키지의 공개 API는 `packages/core/src/index.ts`에서만 export
- 내부 모듈 간 import는 상대 경로 사용
- 패키지 간 import는 패키지명 사용 (`@im-nobsidian/core`)

### Notion API

- 공식 SDK (`@notionhq/client`)만 사용 — 비공식 API 절대 금지
- Rate limit 준수: `async-sema`로 3 req/s 제한
- 모든 API 호출은 `packages/core/src/notion/` 통해서만

### 변환 레이어

- MD→Notion: `@tryfabric/martian` + 커스텀 전처리기
- Notion→MD: `notion-to-md` + 커스텀 후처리기
- 변환 불가 기능은 preserve marker로 보존

### 테스트

- 라운드트립 테스트 최우선 (MD→Notion→MD === 원본)
- Notion API 모킹: `tests/helpers/mock-notion.ts`
- 픽스처: `tests/fixtures/`

## 문서 업데이트 규칙

- 개발 시작 전: `docs/06-devlog/CURRENT_STATUS.md` 업데이트
- 기술 결정 시: `docs/02-architecture/adr/` ADR 추가
- 개발 일지: `docs/06-devlog/journal/YYYY-MM-DD.md`
