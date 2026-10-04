import type { LanguageRequest } from "@notionhq/client/build/src/api-endpoints.js";

/**
 * 코드 펜스의 언어를 Notion 코드 블록 언어로 옮긴다(S-20).
 *
 * Notion 은 펜스 정보 문자열을 제 이름으로 바꿔 저장하고, 모르는 이름 · 빈 정보 · 속성이 붙은
 * 정보는 **javascript** 로 저장한다(2026-09-28 실측 — `dataview` · 맨 펜스 · `python title="a.py"`
 * 모두 javascript). 그대로 두면 받은 노트의 Dataview 쿼리가 자바스크립트 블록이 된다. 그래서 push 는
 * 정식 이름만 보내고, 모르는 것은 `plain text` 로 보낸다. 원래 표기는 pull 이 로컬 노트에서 되살린다
 * (`CodeLanguageRestorer`).
 */

/** Notion 코드 블록이 받는 언어 — 주인은 SDK 타입이다. */
export type NotionCodeLanguage = LanguageRequest;

/**
 * Notion 언어 전부. `Record` 라서 SDK 에 언어가 늘거나 줄면 타입 오류가 난다 — 손으로 맞출 일이 없다.
 * 값은 펜스 정보 문자열로 보내도 그 이름 그대로 저장되는가(2026-09-28 실측, 90개 중 88개).
 */
const FENCE_SENDABLE: Record<NotionCodeLanguage, boolean> = {
  abap: true,
  abc: true,
  agda: true,
  arduino: true,
  // 펜스로 보내면 javascript 로 저장된다(실측). 블록 API 로만 고를 수 있다.
  "ascii art": false,
  assembly: true,
  bash: true,
  basic: true,
  bnf: true,
  c: true,
  "c#": true,
  "c++": true,
  clojure: true,
  coffeescript: true,
  coq: true,
  css: true,
  dart: true,
  dhall: true,
  diff: true,
  docker: true,
  ebnf: true,
  elixir: true,
  elm: true,
  erlang: true,
  "f#": true,
  flow: true,
  fortran: true,
  gherkin: true,
  glsl: true,
  go: true,
  graphql: true,
  groovy: true,
  haskell: true,
  hcl: true,
  html: true,
  idris: true,
  java: true,
  javascript: true,
  json: true,
  julia: true,
  kotlin: true,
  latex: true,
  less: true,
  lisp: true,
  livescript: true,
  "llvm ir": true,
  lua: true,
  makefile: true,
  markdown: true,
  markup: true,
  matlab: true,
  mathematica: true,
  mermaid: true,
  nix: true,
  "notion formula": true,
  "objective-c": true,
  ocaml: true,
  pascal: true,
  perl: true,
  php: true,
  "plain text": true,
  powershell: true,
  prolog: true,
  protobuf: true,
  purescript: true,
  python: true,
  r: true,
  racket: true,
  reason: true,
  ruby: true,
  rust: true,
  sass: true,
  scala: true,
  scheme: true,
  scss: true,
  shell: true,
  smalltalk: true,
  solidity: true,
  sql: true,
  swift: true,
  toml: true,
  typescript: true,
  "vb.net": true,
  verilog: true,
  vhdl: true,
  "visual basic": true,
  webassembly: true,
  xml: true,
  yaml: true,
  // 펜스로 보내면 javascript 로 저장된다(실측).
  "java/c/c++/c#": false,
};

/** 모르는 언어 · 빈 정보 문자열이 가는 곳. */
export const PLAIN_TEXT: NotionCodeLanguage = "plain text";

/**
 * 흔히 쓰는 별칭 → Notion 이름. Notion 이 스스로 옮기는 별칭(`ts` · `py` · `sh` · `yml` · `txt` …,
 * 실측)을 모두 담고, Notion 이 javascript 로 떨어뜨리던 흔한 별칭(`zsh` · `console` · `golang`)을 더했다.
 * 받는 쪽 표기는 pull 이 되살리므로 이 표는 Notion 화면의 강조만 정한다.
 */
const ALIASES: ReadonlyMap<string, NotionCodeLanguage> = new Map<string, NotionCodeLanguage>(
  Object.entries({
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    ts: "typescript",
    tsx: "typescript",
    mts: "typescript",
    cts: "typescript",
    py: "python",
    py3: "python",
    python3: "python",
    sh: "bash",
    zsh: "shell",
    ksh: "shell",
    fish: "shell",
    console: "shell",
    "shell-script": "shell",
    shellscript: "shell",
    ps1: "powershell",
    pwsh: "powershell",
    md: "markdown",
    mdx: "markdown",
    yml: "yaml",
    txt: "plain text",
    text: "plain text",
    plaintext: "plain text",
    plain: "plain text",
    ini: "plain text",
    jsonc: "json",
    json5: "json",
    jsonl: "json",
    cpp: "c++",
    cc: "c++",
    cxx: "c++",
    hpp: "c++",
    h: "c",
    csharp: "c#",
    cs: "c#",
    fsharp: "f#",
    fs: "f#",
    rb: "ruby",
    rs: "rust",
    kt: "kotlin",
    kts: "kotlin",
    golang: "go",
    dockerfile: "docker",
    containerfile: "docker",
    tex: "latex",
    objc: "objective-c",
    objectivec: "objective-c",
    "obj-c": "objective-c",
    hs: "haskell",
    ex: "elixir",
    exs: "elixir",
    erl: "erlang",
    clj: "clojure",
    cljs: "clojure",
    coffee: "coffeescript",
    pl: "perl",
    proto: "protobuf",
    gql: "graphql",
    gradle: "groovy",
    htm: "html",
    xhtml: "html",
    vue: "html",
    svelte: "html",
    svg: "xml",
    xsl: "xml",
    make: "makefile",
    mk: "makefile",
    tf: "hcl",
    terraform: "hcl",
    sol: "solidity",
    rkt: "racket",
    scm: "scheme",
    elisp: "lisp",
    "emacs-lisp": "lisp",
    purs: "purescript",
    patch: "diff",
    mysql: "sql",
    postgresql: "sql",
    postgres: "sql",
    psql: "sql",
    pgsql: "sql",
    plsql: "sql",
    sqlite: "sql",
    tsql: "sql",
    ino: "arduino",
    f90: "fortran",
    f95: "fortran",
    feature: "gherkin",
    cucumber: "gherkin",
    pas: "pascal",
    delphi: "pascal",
    vhd: "vhdl",
    sv: "verilog",
    systemverilog: "verilog",
    llvm: "llvm ir",
    asm: "assembly",
    nasm: "assembly",
    ml: "ocaml",
    jl: "julia",
    wasm: "webassembly",
    wat: "webassembly",
    vb: "visual basic",
    vba: "visual basic",
    vbnet: "vb.net",
    wolfram: "mathematica",
  } satisfies Record<string, NotionCodeLanguage>),
);

/**
 * Notion 언어 이름 그 자체인가(대소문자까지) — Notion 이 내보내는 코드 펜스의 정보 문자열이 이 모양이다.
 * 객체 원형의 이름(`constructor` · `__proto__`)을 언어로 잡지 않도록 자기 속성만 본다.
 */
export function isNotionLanguage(name: string): name is NotionCodeLanguage {
  return Object.prototype.hasOwnProperty.call(FENCE_SENDABLE, name);
}

/** 정보 문자열을 비교할 모양으로 — 앞뒤 공백을 떼고 소문자로, 사이 공백은 한 칸으로. */
function normalizeInfo(info: string): string {
  return info.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * 펜스 정보 문자열이 Notion 에서 될 언어. 정식 이름은 그대로(대소문자 무관), 별칭은 옮기고, 모르는
 * 이름 · 빈 정보 · 펜스로 보낼 수 없는 이름은 {@link PLAIN_TEXT}. 속성이 붙으면 첫 낱말로 가른다.
 */
export function notionCodeLanguage(info: string): NotionCodeLanguage {
  const whole = normalizeInfo(info);
  // `plain text` · `llvm ir` 처럼 여러 낱말인 정식 이름이 먼저다 — 첫 낱말만 보면 놓친다.
  if (isNotionLanguage(whole) && FENCE_SENDABLE[whole]) return whole;
  const word = whole.split(" ")[0] ?? "";
  if (isNotionLanguage(word) && FENCE_SENDABLE[word]) return word;
  return ALIASES.get(word) ?? PLAIN_TEXT;
}

/** 정보 문자열이 이미 펜스로 보낼 수 있는 Notion 정식 이름 그 자체인가(대소문자 무관). */
export function isNotionLanguageInfo(info: string): boolean {
  const whole = normalizeInfo(info);
  return isNotionLanguage(whole) && FENCE_SENDABLE[whole];
}
