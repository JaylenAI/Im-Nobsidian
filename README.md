# ObsiNotion

> Obsidian ↔ Notion 양방향 동기화 도구

Obsidian 볼트와 Notion 워크스페이스를 양방향으로 동기화합니다.
마크다운과 Notion 블록 형식을 정확하게 변환하며, 데이터 손실 없는 안전한 동기화를 제공합니다.

## 주요 기능

- **양방향 동기화** — Obsidian에서 편집하든 Notion에서 편집하든, 양쪽에 반영
- **정확한 변환** — 마크다운 ↔ Notion 블록 형식을 정밀하게 변환
- **안전한 충돌 해결** — 양쪽 동시 편집 시 데이터 파괴 없이 conflict copy 생성
- **폴더 구조 매핑** — Obsidian 폴더 = Notion 페이지 계층
- **델타 동기화** — 변경된 파일만 동기화 (SHA-256 해시 기반)
- **오픈소스** — MIT 라이선스, 무료, 투명

## 패키지

| 패키지 | 설명 | npm |
|--------|------|-----|
| `@obsinotion/core` | 동기화 엔진 (변환 + 상태 관리) | - |
| `obsinotion` | CLI 도구 | - |
| `obsidian-obsinotion` | Obsidian 커뮤니티 플러그인 | - |

## 빠른 시작

> 아직 개발 중입니다. 첫 릴리스 전까지는 사용할 수 없습니다.

```bash
# CLI 설치
npx obsinotion init

# 동기화 상태 확인
npx obsinotion status

# 양방향 동기화
npx obsinotion sync
```

## 개발 환경

### 요구 사항
- Node.js 20+
- pnpm 9+

### 로컬 개발

```bash
# 의존성 설치
pnpm install

# 전체 빌드
pnpm build

# 테스트
pnpm test

# 린트
pnpm lint
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
- [경쟁 도구 분석](docs/01-research/COMPETITIVE_ANALYSIS.md)
- [현재 진행 상황](docs/06-devlog/CURRENT_STATUS.md)
- [로드맵](docs/06-devlog/ROADMAP.md)
- [용어 정의](docs/00-overview/GLOSSARY.md)

## 기여

기여를 환영합니다! [기여 가이드](docs/05-guides/CONTRIBUTING.md)를 참고해주세요.

## 라이선스

[MIT](LICENSE)
