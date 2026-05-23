export class StmtMock {
  private rows: Record<string, unknown>[] = [];
  private index = -1;

  constructor(
    private db: DatabaseMock,
    private sql: string,
  ) {}

  bind(params: unknown[] = []): void {
    this.rows = this.db._executeQuery(this.sql, params);
    this.index = -1;
  }

  step(): boolean {
    this.index++;
    return this.index < this.rows.length;
  }

  getAsObject(): Record<string, unknown> {
    return this.rows[this.index] ?? {};
  }

  free(): void {
    this.rows = [];
  }
}

export class DatabaseMock {
  private tables = new Map<string, { columns: string[]; rows: Record<string, unknown>[] }>();
  private inTransaction = false;
  private savedState: Map<string, { columns: string[]; rows: Record<string, unknown>[] }> | null =
    null;

  run(sql: string, params?: (string | number | Uint8Array | null)[]): void {
    const trimmed = sql.trim().toUpperCase();

    if (trimmed === "BEGIN") {
      this.inTransaction = true;
      this.savedState = new Map(
        [...this.tables.entries()].map(([k, v]) => [
          k,
          { columns: [...v.columns], rows: v.rows.map((r) => ({ ...r })) },
        ]),
      );
      return;
    }
    if (trimmed === "COMMIT") {
      this.inTransaction = false;
      this.savedState = null;
      return;
    }
    if (trimmed === "ROLLBACK") {
      if (this.savedState) {
        this.tables = this.savedState;
      }
      this.inTransaction = false;
      this.savedState = null;
      return;
    }
    if (trimmed.startsWith("PRAGMA")) return;

    if (trimmed.startsWith("CREATE TABLE")) {
      const nameMatch = sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/i);
      if (nameMatch && !this.tables.has(nameMatch[1]!)) {
        const colMatches = [...sql.matchAll(/^\s+(\w+)\s+/gm)];
        const columns = colMatches
          .map((m) => m[1]!)
          .filter(
            (c) =>
              ![
                "PRIMARY",
                "CREATE",
                "UNIQUE",
                "NOT",
                "REFERENCES",
                "ON",
                "DEFAULT",
                "INSERT",
                "UPDATE",
                "VALUES",
              ].includes(c.toUpperCase()),
          );
        this.tables.set(nameMatch[1]!, { columns, rows: [] });
      }
      return;
    }
    if (trimmed.startsWith("CREATE UNIQUE INDEX") || trimmed.startsWith("CREATE INDEX")) return;
    if (trimmed.startsWith("ALTER TABLE")) {
      const addColMatch = sql.match(/ALTER TABLE (\w+) ADD COLUMN (\w+)/i);
      if (addColMatch) {
        const table = this.tables.get(addColMatch[1]!);
        if (table && !table.columns.includes(addColMatch[2]!)) {
          table.columns.push(addColMatch[2]!);
          for (const row of table.rows) {
            row[addColMatch[2]!] = null;
          }
        }
      }
      return;
    }

    if (trimmed.startsWith("INSERT")) {
      this._handleInsert(sql, params);
      return;
    }
    if (trimmed.startsWith("UPDATE")) {
      this._handleUpdate(sql, params);
      return;
    }
    if (trimmed.startsWith("DELETE")) {
      this._handleDelete(sql, params);
      return;
    }
  }

  prepare(sql: string): StmtMock {
    return new StmtMock(this, sql);
  }

  exec(sql: string): { columns: string[]; values: unknown[][] }[] {
    const selectMatch = sql.match(/SELECT\s+(\w+)\s+FROM\s+(\w+)\s+WHERE\s+(\w+)\s*=\s*'([^']*)'/i);
    if (selectMatch) {
      const table = this.tables.get(selectMatch[2]!);
      if (!table) return [];
      const matching = table.rows.filter((r) => String(r[selectMatch[3]!]) === selectMatch[4]!);
      if (matching.length === 0) return [];
      return [{ columns: [selectMatch[1]!], values: matching.map((r) => [r[selectMatch[1]!]]) }];
    }
    const trimmed = sql.trim().toUpperCase();
    if (trimmed.startsWith("INSERT")) {
      this.run(sql);
    }
    return [];
  }

  export(): Uint8Array {
    return new Uint8Array([1, 2, 3]);
  }

  close(): void {}

  _executeQuery(sql: string, params: unknown[]): Record<string, unknown>[] {
    const selectAllMatch = sql.match(/SELECT\s+\*\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?/i);
    if (!selectAllMatch) {
      const selectFieldMatch = sql.match(
        /SELECT\s+(\w+|\d+)\s+FROM\s+(\w+)\s+WHERE\s+(\w+)\s*=\s*\?/i,
      );
      if (selectFieldMatch) {
        const table = this.tables.get(selectFieldMatch[2]!);
        if (!table) return [];
        const field = selectFieldMatch[3]!;
        const val = params[0];
        const matching = table.rows.filter((r) => String(r[field]) === String(val));
        if (matching.length === 0) return [];
        const colName = selectFieldMatch[1]!;
        if (colName === "1") return matching.map(() => ({ "1": 1 }));
        return matching.map((r) => ({ [colName]: r[colName] }));
      }

      const selectValueMatch = sql.match(/SELECT\s+value\s+FROM\s+(\w+)\s+WHERE\s+key\s*=\s*\?/i);
      if (selectValueMatch) {
        const table = this.tables.get(selectValueMatch[1]!);
        if (!table) return [];
        const matching = table.rows.filter((r) => String(r["key"]) === String(params[0]));
        return matching.map((r) => ({ value: r["value"] }));
      }

      return [];
    }

    const tableName = selectAllMatch[1]!;
    const table = this.tables.get(tableName);
    if (!table) return [];

    const whereClause = selectAllMatch[2];
    if (!whereClause) return [...table.rows];

    if (whereClause.match(/\w+\s*=\s*\?/i)) {
      const field = whereClause.match(/(\w+)\s*=\s*\?/i)![1]!;
      return table.rows.filter((r) => String(r[field]) === String(params[0]));
    }

    if (whereClause.match(/\w+\s+LIKE\s+\?/i)) {
      const field = whereClause.match(/(\w+)\s+LIKE\s+\?/i)![1]!;
      const pattern = String(params[0]);
      const regex = new RegExp("^" + pattern.replace(/%/g, ".*").replace(/_/g, ".") + "$");
      return table.rows.filter((r) => regex.test(String(r[field] ?? "")));
    }

    return [...table.rows];
  }

  private _handleInsert(sql: string, params?: (string | number | Uint8Array | null)[]): void {
    const orReplace = /INSERT\s+OR\s+REPLACE/i.test(sql);
    const orIgnore = /INSERT\s+OR\s+IGNORE/i.test(sql);
    const tableMatch = sql.match(/INTO\s+(\w+)/i);
    if (!tableMatch) return;
    const tableName = tableMatch[1]!;

    if (!this.tables.has(tableName)) {
      this.tables.set(tableName, { columns: [], rows: [] });
    }

    const colMatch = sql.match(/\(([^)]+)\)\s*VALUES/i);
    if (!colMatch || !params) return;
    const columns = colMatch[1]!.split(",").map((c) => c.trim());

    const row: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      row[columns[i]!] = params[i] ?? null;
    }

    const table = this.tables.get(tableName)!;

    if (orReplace) {
      const pkCol = columns[0]!;
      const idx = table.rows.findIndex((r) => r[pkCol] === row[pkCol]);
      if (idx >= 0) {
        table.rows[idx] = row;
      } else {
        table.rows.push(row);
      }
    } else if (orIgnore) {
      const pkCol = columns[0]!;
      const exists = table.rows.some((r) => r[pkCol] === row[pkCol]);
      if (!exists) table.rows.push(row);
    } else {
      table.rows.push(row);
    }
  }

  private _handleUpdate(sql: string, params?: (string | number | Uint8Array | null)[]): void {
    const tableMatch = sql.match(/UPDATE\s+(\w+)/i);
    if (!tableMatch || !params) return;
    const table = this.tables.get(tableMatch[1]!);
    if (!table) return;

    const setMatch = sql.match(/SET\s+(.*?)\s+WHERE/is);
    if (!setMatch) return;

    const setClauses = setMatch[1]!.split(",").map((s) => s.trim());
    const whereMatch = sql.match(/WHERE\s+(\w+)\s*=\s*\?/i);
    if (!whereMatch) return;

    const whereCol = whereMatch[1]!;
    const whereVal = params[params.length - 1];

    let paramIdx = 0;
    for (const row of table.rows) {
      if (String(row[whereCol]) === String(whereVal)) {
        for (const clause of setClauses) {
          const colMatch2 = clause.match(/^(\w+)\s*=/);
          if (!colMatch2) continue;
          const col = colMatch2[1]!;
          if (clause.includes("?")) {
            row[col] = params[paramIdx++];
          } else if (clause.includes("version + 1")) {
            row[col] = (Number(row[col]) || 0) + 1;
            continue;
          } else if (clause.includes("datetime('now')")) {
            row[col] = new Date().toISOString();
            continue;
          }
        }
      }
    }
  }

  private _handleDelete(sql: string, params?: (string | number | Uint8Array | null)[]): void {
    const tableMatch = sql.match(/DELETE\s+FROM\s+(\w+)/i);
    if (!tableMatch || !params) return;
    const table = this.tables.get(tableMatch[1]!);
    if (!table) return;

    const whereMatch = sql.match(/WHERE\s+(\w+)\s*=\s*\?/i);
    if (!whereMatch) return;

    const col = whereMatch[1]!;
    const val = params[0];
    table.rows = table.rows.filter((r) => String(r[col]) !== String(val));
  }
}

export function createSqlJsMock() {
  return {
    default: async () => ({
      Database: class {
        constructor(_data?: Uint8Array) {
          return new DatabaseMock() as unknown as InstanceType<typeof this.constructor>;
        }
      },
    }),
    __esModule: true,
  };
}
