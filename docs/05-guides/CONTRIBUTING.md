# 기여 가이드

> 작성일: 2026-05-08
> 상태: draft
> Phase 9 배포 전 작성 예정

## 개발 환경 세팅

```bash
git clone https://github.com/hanseungheon/im-nobsidian.git
cd im-nobsidian
bash scripts/setup.sh
```

## 브랜치 전략

- `main`: 릴리스 전용
- `dev`: 개발 통합 브랜치
- `feature/*`: 기능 브랜치 (dev에서 분기)
- `fix/*`: 버그 수정 (dev에서 분기)

## 커밋 규칙

- 메시지: 한국어 작성
- Prefix: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`
- 예: `feat: 위키링크 양방향 변환 추가`

## PR 규칙

- dev 브랜치로 PR
- squash merge
- 템플릿 체크리스트 완료 필수

## 테스트

- `pnpm test` — 전체 테스트
- `pnpm test:coverage` — 커버리지 확인
- 새 기능: 반드시 테스트 포함
- 커버리지 80% 미만 시 CI 실패
