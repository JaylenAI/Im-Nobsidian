import { defineWorkspace } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "path";

const here = import.meta.dirname;
const obsidianAlias = { obsidian: path.resolve(here, "tests/helpers/obsidian-stub.ts") };

// Svelte 5 컴포넌트의 실제 DOM 마운트 테스트(I9). browser 컨디션으로 svelte 클라이언트
// 빌드를 해석해야 `mount()` 가 동작한다. 이 컨디션이 node 프로젝트로 새지 않도록 분리한다.
const COMPONENT_TESTS = [
  "tests/views/table-view.test.ts",
  "tests/views/gallery-view.test.ts",
  "tests/views/list-view.test.ts",
  "tests/views/sync-dashboard.test.ts",
];

export default defineWorkspace([
  // node 프로젝트 — 로직/컨트롤러 테스트(svelte·sql.js 는 mock). 기존 동작 그대로.
  // root 를 명시해야 루트 워크스페이스가 이 프로젝트를 펼쳐도 include 가 plugin 기준으로 잡힌다.
  {
    root: here,
    plugins: [svelte({ hot: false })],
    resolve: { alias: obsidianAlias },
    test: {
      name: "node",
      globals: true,
      environment: "node",
      include: ["tests/**/*.test.ts"],
      exclude: COMPONENT_TESTS,
      deps: { inline: ["@im-nobsidian/core"] },
    },
  },
  // components 프로젝트 — Svelte 컴포넌트 실제 마운트(happy-dom + browser 컨디션).
  {
    root: here,
    plugins: [svelte({ hot: false })],
    resolve: { alias: obsidianAlias, conditions: ["browser"] },
    test: {
      name: "components",
      globals: true,
      environment: "happy-dom",
      include: COMPONENT_TESTS,
      deps: { inline: ["@im-nobsidian/core"] },
    },
  },
]);
