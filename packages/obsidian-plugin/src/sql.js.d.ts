declare module "sql.js" {
  export interface Database {
    run(sql: string, params?: (string | number | Uint8Array | null)[]): Database;
    exec(sql: string): QueryExecResult[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }

  export interface Statement {
    bind(params?: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): boolean;
  }

  export interface QueryExecResult {
    columns: string[];
    values: unknown[][];
  }

  export interface SqlJsStatic {
    Database: new (data?: Uint8Array) => Database;
  }

  export interface InitSqlJsOptions {
    locateFile?: (file: string) => string;
    wasmBinary?: ArrayBuffer | Uint8Array;
  }

  export default function initSqlJs(
    options?: InitSqlJsOptions | Record<string, unknown>,
  ): Promise<SqlJsStatic>;
}

/** esbuild 의 binary 로더(`esbuild.config.mjs`)가 main.js 에 싣는 wasm — 파일의 바이트 그대로다. */
declare module "*.wasm" {
  const bytes: Uint8Array;
  export default bytes;
}
