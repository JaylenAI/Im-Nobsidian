import esbuild from "esbuild";
import builtins from "builtin-modules";
import sveltePlugin from "esbuild-svelte";
import { copyFileSync } from "node:fs";
import { svelteCompilerOptions } from "./svelte-options.mjs";

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
        compilerOptions: svelteCompilerOptions,
      }),
    ],
    alias: {
      "better-sqlite3": "./src/stubs/better-sqlite3.ts",
    },
    // sql.js 의 SQLite 엔진(wasm)을 main.js 안에 싣는다 — 디렉터리는 main.js · manifest.json · styles.css 만
    // 내려받는다(ADR-031).
    loader: { ".wasm": "binary" },
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
    // manifest 의 원본은 레포 루트다 — Obsidian 앱 · BRAT · 디렉터리가 루트에서 읽는다(ADR-032).
    // 이 폴더에는 설치할 세 파일(main.js · manifest.json · styles.css)을 모으려고 옮겨 둔다.
    copyFileSync("../../manifest.json", "manifest.json");
  })
  .catch(() => process.exit(1));
