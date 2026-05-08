# ADR-001: pnpm Monorepo 구조 채택

> 상태: 승인
> 결정일: 2026-05-08

## 맥락

ObsiNotion은 3개의 배포 단위(core, cli, obsidian-plugin)로 구성된다.
코드 공유와 일관된 개발 경험을 위해 모노레포 vs 멀티레포 결정이 필요.

## 결정

**pnpm workspaces 기반 모노레포** 채택.

## 이유

1. **코드 공유**: core 패키지를 cli와 plugin이 `workspace:*`로 즉시 참조
2. **일관성**: 린트, 테스트, 빌드 설정을 루트에서 공유
3. **원자적 변경**: 여러 패키지에 걸친 변경을 단일 커밋으로 처리
4. **pnpm 선택 이유**: 디스크 효율 (심볼릭 링크), 속도, strict peer deps

## 대안 검토

- **Lerna + npm**: 레거시, pnpm 대비 느림
- **Turborepo**: 빌드 캐싱이 장점이나, 현 규모에서는 과잉
- **멀티레포**: 패키지 간 변경 조율이 복잡

## 결과

- `pnpm-workspace.yaml`로 패키지 정의
- `tsconfig.base.json`으로 TypeScript 설정 공유
- Changesets로 버전 관리 + linked 패키지
