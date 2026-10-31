/**
 * 노트마다 묻는 조회는 색인을 탄다 (P10). 색인을 못 쓰는 조회는 노트마다 표를 다 훑어, 볼트가 클수록 push 가 제곱으로
 * 느려진다. `OR` 로 묶은 조건 · 맞지 않는 콜레이션은 오류 없이 색인을 놓치므로 SQLite 의 계획으로 확인한다.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { STATE_DB_MIGRATIONS } from "../../src/state/migrations/index.js";
import { WIKILINK_LOOKUPS } from "../../src/state/wikilink-lookup.js";

function plan(sql: string, params: readonly string[]): string {
  const db = new Database(":memory:");
  for (const migration of STATE_DB_MIGRATIONS) db.exec(migration.sql);
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>;
  db.close();
  return rows.map((row) => row.detail).join(" · ");
}

describe("조회 계획 (P10)", () => {
  // 맨 앞이 `%` 인 LIKE(별칭 · 경로 꼬리)는 색인을 쓸 수 없다 — wikilink-lookup.ts 의 주석
  const exact = WIKILINK_LOOKUPS.filter((lookup) => !lookup.sql.includes("LIKE"));

  it("위키링크의 같음 조회는 모두 색인으로 찾는다", () => {
    expect(exact.length).toBeGreaterThanOrEqual(3);
    for (const lookup of exact) {
      expect(plan(lookup.sql, lookup.params("노트")), lookup.sql).toMatch(
        /USING (COVERING )?INDEX/,
      );
    }
  });

  it("경로 조회 — 그대로 · 대소문자 무시 둘 다 색인", () => {
    expect(plan("SELECT * FROM sync_state WHERE obsidian_path = ?", ["a.md"])).toMatch(/INDEX/);
    expect(
      plan("SELECT * FROM sync_state WHERE obsidian_path = ? COLLATE NOCASE", ["a.md"]),
    ).toMatch(/INDEX/);
  });
});
