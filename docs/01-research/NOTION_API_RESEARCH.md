# Notion API 리서치

> 작성일: 2026-05-08
> 상태: draft
> Phase 1에서 상세 작성 예정

## API 버전 히스토리 (2026)

| 버전 | 주요 변경 |
|------|----------|
| 2026-02-01 | 벌크 연산 (100페이지/요청), 수식 속성 쓰기 |
| 2026-03-01 | **웹훅**, 댓글 스레딩 |
| 2026-04-01 | Views API, H4 제목, 탭 블록, 동기화 블록 복사 |

## Rate Limit

- 지속: 3 req/s (모든 플랜)
- 버스트: 최대 10 req/s
- 웹훅: Rate limit에 포함 안 됨
- Free 플랜: 월 10,000 API 요청 제한

## 인증

- Internal Integration: `ntn_` 접두사 토큰
- Public Integration: OAuth 2.0 + refresh token
- 우리는 Internal Integration 기본, OAuth는 v2+

## 상세 조사 항목 (작성 예정)

- [ ] 블록 타입별 API 지원 현황
- [ ] 웹훅 이벤트 타입 및 페이로드 구조
- [ ] 벌크 연산 제약사항
- [ ] 마크다운 API (GET/PATCH) 제약사항
- [ ] 파일 업로드 API
- [ ] 페이지네이션 전략
- [ ] 에러 코드 및 재시도 전략
