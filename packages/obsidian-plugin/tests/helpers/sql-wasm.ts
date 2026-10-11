/**
 * 빌드는 sql.js wasm 을 esbuild 의 binary 로더로 main.js 에 싣는다(`esbuild.config.mjs`). 시험(vite)에는 그
 * 로더가 없어, 같은 파일을 바이트로 읽어 같은 모양(Uint8Array)으로 내놓는다.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export default new Uint8Array(readFileSync(require.resolve("sql.js/dist/sql-wasm-browser.wasm")));
