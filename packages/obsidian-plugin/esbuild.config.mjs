import esbuild from "esbuild";
import builtins from "builtin-modules";
import sveltePlugin from "esbuild-svelte";
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { svelteCompilerOptions } from "./svelte-options.mjs";

const prod = process.argv[2] === "production";

const nodeBuiltinsWithPrefix = builtins.map((m) => `node:${m}`);

// 모바일 앱에는 Node 가 없다(P11, ADR-053) — core · 의존성이 부르는 Node 모듈을 shim 으로 잇는다. shim 은 데스크톱이면
// 진짜 모듈을 넘긴다. 여기에 없는 Node 모듈을 새로 부르면 main.js 가 그대로 `require` 해 모바일에서 뜨지 않는다 —
// `tests/platform/no-node-load.test.ts` 가 잡는다.
const NODE_SHIMS = {
  fs: "./src/platform/shims/fs.ts",
  "fs/promises": "./src/platform/shims/fs-promises.ts",
  path: "./src/platform/shims/path.ts",
  crypto: "./src/platform/shims/crypto.ts",
  os: "./src/platform/shims/os.ts",
  url: "./src/platform/shims/url.ts",
  events: "./src/platform/shims/events.ts",
};
const shimAliases = Object.fromEntries(
  Object.entries(NODE_SHIMS).flatMap(([name, shim]) => [
    [name, shim],
    [`node:${name}`, shim],
  ]),
);
// npm `buffer`(모바일의 전역 Buffer, `src/platform/buffer-global.ts`)는 싣는다 — Node 의 `buffer` 와 이름이 같다
const shimmed = new Set([...Object.keys(shimAliases), "buffer", "node:buffer"]);

/** vfile 의 `minproc`(`module.exports = process`) — 모바일에는 전역 `process` 가 없다. */
const vfileProcShim = {
  name: "vfile-proc-shim",
  setup(build) {
    build.onResolve({ filter: /^\.\/minproc(\.js)?$/ }, (args) =>
      /[\\/]vfile[\\/]/.test(args.importer)
        ? // Windows 에서 `URL.pathname` 은 `/D:/…` 라 esbuild 가 절대 경로로 받지 않는다
          { path: fileURLToPath(new URL("./src/platform/shims/vfile-proc.ts", import.meta.url)) }
        : undefined,
    );
  },
};

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
      ...[...builtins, ...nodeBuiltinsWithPrefix].filter((name) => !shimmed.has(name)),
    ],
    plugins: [
      sveltePlugin({
        compilerOptions: svelteCompilerOptions,
      }),
      vfileProcShim,
    ],
    alias: {
      "better-sqlite3": "./src/stubs/better-sqlite3.ts",
      ...shimAliases,
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
