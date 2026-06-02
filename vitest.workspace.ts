import { defineWorkspace } from "vitest/config";
// core/cli 는 각자 vitest.config.ts 를 가져 디렉토리 참조로 잡힌다. plugin 은 node/components
// 두 프로젝트(svelte browser 컨디션 분리)라 자체 vitest.workspace.mts 로 정의되는데,
// 디렉토리 참조로는 그 nested workspace 가 로드되지 않는다 → 프로젝트 정의를 직접 펼친다.
import pluginProjects from "./packages/obsidian-plugin/vitest.workspace.mts";

export default defineWorkspace(["packages/core", "packages/cli", ...pluginProjects]);
