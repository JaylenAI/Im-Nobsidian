# 릴리스 프로세스

> 마지막 업데이트: 2026-05-11

## 릴리스 흐름

```
feature 브랜치에서 작업
    ↓
dev 브랜치로 PR/merge
    ↓
dev에서 품질 게이트 통과 확인
    ↓
release/vX.Y.Z 브랜치 생성
    ↓
changeset version + CHANGELOG 업데이트
    ↓
main으로 merge
    ↓
git tag vX.Y.Z + push
    ↓
GitHub Actions 자동: npm publish + GitHub Release
```

## 릴리스 체크리스트

### 1. 코드 품질

- [ ] `pnpm lint` 클린
- [ ] `pnpm typecheck` 클린
- [ ] `pnpm test` 전체 통과
- [ ] `pnpm build` 성공
- [ ] E2E 테스트 통과 (NOTION_TOKEN 필요)

### 2. 문서

- [ ] CHANGELOG.md 업데이트 (Unreleased → vX.Y.Z)
- [ ] README.md 최신 상태
- [ ] CURRENT_STATUS.md 최신 상태

### 3. 버전 관리

```bash
pnpm changeset          # 변경사항 기록
pnpm version-packages   # 버전 업 + CHANGELOG 생성
```

### 4. 브랜치 관리

```bash
git checkout dev
git checkout -b release/vX.Y.Z
# changeset version 결과 커밋
git checkout main
git merge release/vX.Y.Z
```

### 5. 태그 + 배포

```bash
git tag vX.Y.Z
git push origin main --tags
```

### 6. 배포 확인

- [ ] `npm info @im-nobsidian/core` 버전 확인
- [ ] `npm info nobsi` 버전 확인
- [ ] `npx nobsi --version` 동작
- [ ] GitHub Releases 페이지에 릴리스 노트 존재
