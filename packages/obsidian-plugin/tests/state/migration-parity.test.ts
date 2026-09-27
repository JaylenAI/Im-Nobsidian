/**
 * 플러그인의 상태 DB 마이그레이션은 core 의 SQL 을 손으로 베낀다 — 두 벌이 갈라져도 오류가 나지
 * 않는다. 같은 볼트를 CLI 와 플러그인이 번갈아 열면 스키마가 달라진다. 베낀 것이 같은지 본다.
 *
 * 001 · 002 는 이미 갈라져 있다(플러그인에 CHECK 제약이 없다) — 따로 고칠 일이라 여기서는
 * 003 부터 본다.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), "utf-8");

/** `const NAME = \`…\`` 의 SQL — 공백은 하나로 줄인다. */
function sqlOf(source: string, name: string): string {
  const match = source.match(new RegExp(`${name}\\s*=\\s*\`([^\`]*)\``));
  if (!match) throw new Error(`${name} 를 찾지 못함`);
  return match[1]!.replace(/\s+/g, " ").trim();
}

const plugin = read("../../src/state/sqljs-state-db.ts");

describe("상태 DB 마이그레이션 — core 와 같은 SQL", () => {
  it.each([
    ["003-stat-cache.ts", "STAT_CACHE_MIGRATION"],
    ["004-remote-observation.ts", "REMOTE_OBSERVATION_MIGRATION"],
  ])("%s", (file, name) => {
    const core = read(`../../../core/src/state/migrations/${file}`);

    expect(sqlOf(plugin, name)).toBe(sqlOf(core, name));
  });
});
