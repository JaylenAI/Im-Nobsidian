# 변환 가능성 매트릭스

> 작성일: 2026-05-08
> 상태: draft
> Phase 1에서 상세 작성 예정

## A등급: 완벽 변환 (손실 0%)

| Obsidian | Notion | 방향 |
|----------|--------|------|
| `# H1` ~ `### H3` | heading_1/2/3 | 양방향 |
| 일반 텍스트 | paragraph | 양방향 |
| `**볼드**` | bold annotation | 양방향 |
| `*이탤릭*` | italic annotation | 양방향 |
| `~~취소선~~` | strikethrough | 양방향 |
| `` `코드` `` | code annotation | 양방향 |
| `- 리스트` | bulleted_list_item | 양방향 |
| `1. 순서` | numbered_list_item | 양방향 |
| `- [ ] 할일` | to_do | 양방향 |
| `> 인용` | quote | 양방향 |
| `---` | divider | 양방향 |
| `[텍스트](URL)` | rich_text href | 양방향 |

## B등급: 변환 가능, 미세 손실 (5-15%)

| 기능 | 손실 내용 | 대응 |
|------|----------|------|
| 코드 블록 (` ``` `) | 언어명 매핑 차이 | 매핑 테이블 |
| 콜아웃 (`> [!type]`) | 아이콘/색상 차이 | 타입→아이콘 매핑 |
| 테이블 | 셀 내 복잡 서식 | 단순화 |
| 수식 (`$$..$$`) | KaTeX 미지원 명령 | 서브셋 사용 |
| 프론트매터 | 타입 매핑 제한 | zod 스키마 |
| 태그 (`#태그`) | 위치 정보 손실 | 속성으로 이동 |
| 이미지 (외부 URL) | 없음 | URL 보존 |
| Mermaid | 없음 (코드 블록) | 언어 보존 |

## C등급: 변환 불가, 보존 전략

### Obsidian 전용 → Notion에서 보존

| 기능 | 보존 방법 |
|------|----------|
| `[[위키링크]]` | Notion 페이지 멘션 + 매핑 테이블 |
| `[[노트\|별칭]]` | 멘션 + 별칭 마커 |
| `![[임베드]]` | preserve marker |
| Dataview | 코드 블록 + preserve marker |
| Templater | 코드 블록 + preserve marker |
| `[^각주]` | 괄호 텍스트 + preserve marker |

### Notion 전용 → Obsidian에서 보존

| 기능 | 보존 방법 |
|------|----------|
| Database | 폴더 + 프론트매터 (읽기 전용) |
| Relation | 프론트매터 캐싱 |
| Rollup | 프론트매터 캐싱 |
| Synced Block | 일반 블록 + preserve marker |
| Column Layout | 순차 텍스트 + preserve marker |
| Toggle Heading | `<details>` HTML |
| 인라인 색상 | 텍스트만 보존 (색상 손실) |
| 댓글 | 동기화 제외 |

## 상세 조사 항목 (작성 예정)

- [ ] 각 블록 타입별 실제 API 응답 샘플
- [ ] martian이 지원하는 블록 타입 목록
- [ ] notion-to-md가 지원하는 블록 타입 목록
- [ ] 커스텀 변환이 필요한 타입 목록
- [ ] preserve marker 형식 최종 정의
