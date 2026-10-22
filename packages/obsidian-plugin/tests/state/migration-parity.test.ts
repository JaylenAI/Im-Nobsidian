/**
 * 플러그인의 상태 DB 스키마는 CLI 와 같다 — 둘 다 core 의 스키마 목록(`STATE_DB_MIGRATIONS`)을 돈다(D5).
 *
 * 예전에는 플러그인이 SQL 을 손으로 베껴, 처음 두 스키마의 CHECK 제약이 플러그인 DB 에만 없었다. 같은 볼트를
 * CLI 와 플러그인이 번갈아 열면 어느 쪽이 만들었느냐에 따라 받는 값이 달랐다. 실제 sql.js 로 본다.
 */
import { describe, it, expect } from "vitest";
import initSqlJs from "sql.js";
import { STATE_DB_MIGRATIONS } from "@im-nobsidian/core";
import sqlJsWasm from "sql.js/dist/sql-wasm-browser.wasm";
import { SqlJsStateDB } from "../../src/state/sqljs-state-db.js";

const SCHEMA_QUERY = "SELECT type, name, sql FROM sqlite_master ORDER BY type, name";

async function sqlJs() {
  return initSqlJs({ wasmBinary: sqlJsWasm.buffer as ArrayBuffer });
}

/** 플러그인이 새로 만든 상태 DB 의 스키마. */
async function pluginSchema(): Promise<unknown[]> {
  const db = await SqlJsStateDB.open();
  const data = db.export();
  await db.close();
  const SQL = await sqlJs();
  const copy = new SQL.Database(data);
  const rows = copy.exec(SCHEMA_QUERY)[0]!.values;
  copy.close();
  return rows;
}

describe("상태 DB 스키마 — CLI 와 같다 (D5)", () => {
  it("core 의 스키마 목록을 차례로 돈 DB 와 같다", async () => {
    const SQL = await sqlJs();
    const core = new SQL.Database();
    for (const migration of STATE_DB_MIGRATIONS) core.exec(migration.sql);
    const expected = core.exec(SCHEMA_QUERY)[0]!.values;
    core.close();

    expect(await pluginSchema()).toEqual(expected);
  });

  it("CHECK 제약이 있다 — 모르는 상태 값은 적지 못한다", async () => {
    const schema = (await pluginSchema()).map((row) => String((row as unknown[])[2]));

    expect(schema.find((sql) => sql.startsWith("CREATE TABLE sync_state"))).toContain(
      "CONSTRAINT chk_status CHECK",
    );
    expect(schema.find((sql) => sql.startsWith("CREATE TABLE file_registry"))).toContain(
      "CONSTRAINT chk_file_type CHECK",
    );
  });

  it("마지막 스키마 버전을 적는다 — 다시 열어도 스키마를 또 돌지 않는다", async () => {
    const db = await SqlJsStateDB.open();
    const data = db.export();
    await db.close();

    const reopened = await SqlJsStateDB.open(data);
    expect(reopened.getMeta("schema_version")).toBe(String(STATE_DB_MIGRATIONS.at(-1)!.version));
    await reopened.close();
  });
});
