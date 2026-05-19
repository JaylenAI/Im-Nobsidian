# npm 배포 절차

> 마지막 업데이트: 2026-05-11

## 사전 요구사항

- npm 계정 + 토큰 (`NPM_TOKEN` secret 설정)
- GitHub repository에 `NPM_TOKEN` secret 등록

## 배포 대상 패키지

| 패키지        | npm 이름             | 접근   |
| ------------- | -------------------- | ------ |
| packages/core | `@im-nobsidian/core` | public |
| packages/cli  | `im-nobsidian`       | public |

> `obsidian-im-nobsidian` (플러그인)은 npm이 아닌 Obsidian Community Plugins를 통해 배포

## 수동 배포 절차

```bash
# 1. 변경사항 기록
pnpm changeset

# 2. 버전 업
pnpm version-packages

# 3. 빌드 확인
pnpm build

# 4. 패키지 내용 확인
pnpm -r exec -- pnpm pack --dry-run

# 5. 배포
pnpm -r publish --access public
```

## 자동 배포 (GitHub Actions)

`v*` 태그 push 시 `.github/workflows/release.yml`이 자동 실행:

```bash
git tag v0.1.0
git push origin v0.1.0
```

release.yml이 자동으로:

1. 빌드
2. npm publish (`@im-nobsidian/core`, `nobsi`)
3. GitHub Release 생성

## 배포 전 체크리스트

- [ ] `pnpm lint` 클린
- [ ] `pnpm typecheck` 클린
- [ ] `pnpm test` 전체 통과
- [ ] `pnpm build` 성공
- [ ] CHANGELOG.md 업데이트
- [ ] package.json 버전 확인
- [ ] `pnpm pack --dry-run`으로 배포 파일 확인
