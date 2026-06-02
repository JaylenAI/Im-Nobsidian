import { defineConfig } from "vitest/config";

/**
 * Invariant(불변식) 안전망 전용 설정.
 *
 * 실제 Notion API 왕복으로 드리프트/멱등성/삭제 불변식을 검증한다.
 * - .env 로딩: setupFiles 의 load-env.ts 가 레포 루트 .env 를 주입
 * - 직렬 실행: rate limit(3 req/s) 및 eventual consistency 대비
 * - 기본 `pnpm test` 와 분리 — 토큰 없으면 각 테스트가 skipIf 로 건너뜀
 *
 * 실행: `pnpm test:invariants` (레포 루트)
 */
export default defineConfig({
  test: {
    globals: true,
    root: import.meta.dirname,
    include: ["tests/invariants/**/*.invariant.test.ts"],
    setupFiles: ["tests/invariants/load-env.ts"],
    testTimeout: 180000,
    hookTimeout: 180000,
    // 실제 API 왕복 — 파일/테스트 직렬화로 rate limit·정합성 안정화
    fileParallelism: false,
    sequence: { concurrent: false },
    // 워치 비활성 — 일회성 검증
    watch: false,
  },
});
