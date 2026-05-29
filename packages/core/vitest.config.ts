import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/**/*.test.ts"],
    // invariant 안전망은 실제 Notion 왕복이 필요 — 기본 오프라인 스위트에서 제외.
    // 전용 설정(vitest.invariant.config.ts) + `pnpm test:invariants` 로만 구동.
    exclude: [...configDefaults.exclude, "tests/invariants/**"],
  },
});
