# 릴리스 프로세스

> 작성일: 2026-05-08
> 상태: draft
> Phase 9에서 상세화 예정

## 릴리스 체크리스트

1. [ ] dev 브랜치 최신 상태 확인
2. [ ] 전체 테스트 통과 (`pnpm test`)
3. [ ] 타입 체크 통과 (`pnpm typecheck`)
4. [ ] 린트 통과 (`pnpm lint`)
5. [ ] CHANGELOG.md 업데이트
6. [ ] Changeset 버전 업데이트 (`pnpm version-packages`)
7. [ ] dev → main 머지
8. [ ] 태그 생성 (`git tag -a v0.x.0 -m "릴리스 노트"`)
9. [ ] 태그 push → GitHub Actions 자동 배포
10. [ ] npm 배포 확인
11. [ ] GitHub Release 확인
12. [ ] Obsidian 플러그인 릴리스 확인
