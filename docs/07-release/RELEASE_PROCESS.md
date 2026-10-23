# 릴리스 프로세스

> 마지막 업데이트: 2026-06-02

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

버전은 다섯 곳에 적는다 — `package.json` 넷(루트 · core · cli · obsidian-plugin)과 루트 `manifest.json`(플러그인 폴더의
것은 빌드가 옮긴 사본). `versions.json` 에 그 버전의 `minAppVersion` 을, `docs/07-release/RELEASE_NOTES_vX.Y.Z.md` 와
CHANGELOG 의 `## [X.Y.Z]` 절을 함께 둔다. 목록의 정본은 `scripts/check-release-version.mjs` 다.

```bash
node scripts/check-release-version.mjs vX.Y.Z   # 태그를 달기 전에 — 하나라도 다르면 실패
```

CI 는 push 마다 태그 없이(레포 안의 일치만), Release 워크플로는 태그와 함께 부른다. 실패하면 npm · GitHub
릴리스 어느 것도 나가지 않는다.

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
- [ ] `npm info im-nobsidian` 버전 확인
- [ ] `npx nobsi --version` 동작
- [ ] GitHub Releases 페이지에 릴리스 노트 존재
