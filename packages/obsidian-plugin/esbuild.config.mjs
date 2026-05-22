import esbuild from "esbuild";
import builtins from "builtin-modules";
import sveltePlugin from "esbuild-svelte";
import { copyFileSync } from "node:fs";

const prod = process.argv[2] === "production";

const nodeBuiltinsWithPrefix = builtins.map((m) => `node:${m}`);

esbuild
  .build({
    entryPoints: ["src/main.ts"],
    bundle: true,
    external: [
      "obsidian",
      "electron",
      "@codemirror/autocomplete",
      "@codemirror/collab",
      "@codemirror/commands",
      "@codemirror/language",
      "@codemirror/lint",
      "@codemirror/search",
      "@codemirror/state",
      "@codemirror/view",
      "@lezer/common",
      "@lezer/highlight",
      "@lezer/lr",
      ...builtins,
      ...nodeBuiltinsWithPrefix,
    ],
    plugins: [
      sveltePlugin({
        compilerOptions: { css: "injected" },
      }),
    ],
    format: "cjs",
    target: "es2022",
    logLevel: "info",
    sourcemap: prod ? false : "inline",
    treeShaking: true,
    outfile: "main.js",
    minify: prod,
    platform: "node",
    mainFields: ["svelte", "browser", "module", "main"],
    conditions: ["svelte", "browser"],
  })
  .then(() => {
    copyFileSync("src/styles/main.css", "styles.css");
    try {
      const wasmSrc = new URL("../node_modules/sql.js/dist/sql-wasm.wasm", import.meta.url);
      copyFileSync(wasmSrc, "sql-wasm.wasm");
    } catch {
      const pnpmPath = new URL("../../node_modules/.pnpm/sql.js@1.14.1/node_modules/sql.js/dist/sql-wasm.wasm", import.meta.url);
      copyFileSync(pnpmPath, "sql-wasm.wasm");
    }
  })
  .catch(() => process.exit(1));
