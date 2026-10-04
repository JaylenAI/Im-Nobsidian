/**
 * 코드 펜스 언어 왕복(S-20).
 *
 * Notion 은 펜스 언어를 제 이름으로 저장하고, 모르는 이름 · 빈 정보 · 속성 붙은 정보는 javascript 로
 * 저장한다. ~~~ 펜스와 네 백틱 펜스는 코드 블록으로 읽지 못한다(2026-09-28 실측). 예전에는 받은 노트의
 * 맨 펜스와 `dataview` 쿼리가 ```javascript 가 되고 `ts` 는 ```typescript 가 됐다.
 */
import { describe, it, expect } from "vitest";
import { isNotionLanguageInfo, notionCodeLanguage } from "../../src/converter/code-language.js";
import {
  codeFingerprint,
  codeLineLead,
  fenceCodeText,
  hasBacktickFenceLine,
} from "../../src/converter/code-fence.js";
import { scanCodeFences } from "../../src/utils/md-regions.js";
import { deferredCodeMarker } from "../../src/constants/markers.js";
import { RICH_TEXT_ARRAY_MAX, RICH_TEXT_CONTENT_MAX } from "../../src/constants/notion-limits.js";
import { CodeLanguageGuard } from "../../src/converter/pre-processors/code-language-guard.js";
import { CodeLanguageRestorer } from "../../src/converter/post-processors/code-language-restorer.js";
import { BlockConverter } from "../../src/converter/block-converter.js";
import type { ProcessorInput } from "../../src/types/convert.js";
import { roundtrip } from "./roundtrip-fidelity.js";

const pushContext = {
  direction: "push" as const,
  path: "markdown-api" as const,
  filePath: "note.md",
};
const pullContext = { ...pushContext, direction: "pull" as const };

function push(content: string): string {
  return pushed(content).content;
}

function pushed(content: string, metadata: ProcessorInput["metadata"] = {}) {
  const input: ProcessorInput = { content, metadata, context: pushContext };
  return new CodeLanguageGuard().process(input);
}

function pull(content: string, localContent?: string): string {
  const input: ProcessorInput = { content, metadata: { localContent }, context: pullContext };
  return new CodeLanguageRestorer().process(input).content;
}

const fence = (info: string, code = "x", bar = "```") => `${bar}${info}\n${code}\n${bar}`;

describe("notionCodeLanguage — 펜스 언어 → Notion 언어", () => {
  it.each([
    // Notion 이 스스로 옮기는 별칭과 같게(실측)
    ["python", "python"],
    ["Python", "python"],
    ["TypeScript", "typescript"],
    ["ts", "typescript"],
    ["tsx", "typescript"],
    ["js", "javascript"],
    ["jsx", "javascript"],
    ["py", "python"],
    ["sh", "bash"],
    ["md", "markdown"],
    ["yml", "yaml"],
    ["txt", "plain text"],
    ["text", "plain text"],
    ["plaintext", "plain text"],
    ["plain", "plain text"],
    ["ini", "plain text"],
    ["jsonc", "json"],
    ["cpp", "c++"],
    ["C++", "c++"],
    ["csharp", "c#"],
    ["cs", "c#"],
    ["rb", "ruby"],
    ["rs", "rust"],
    ["kt", "kotlin"],
    ["dockerfile", "docker"],
    ["tex", "latex"],
    ["ps1", "powershell"],
    ["objc", "objective-c"],
    ["mermaid", "mermaid"],
    // Notion 이 javascript 로 떨어뜨리던 흔한 별칭
    ["zsh", "shell"],
    ["console", "shell"],
    ["golang", "go"],
  ])("%s → %s", (info, expected) => {
    expect(notionCodeLanguage(info)).toBe(expected);
  });

  it.each([
    ["plain text", "plain text"],
    ["Plain Text", "plain text"],
    ["plain   text", "plain text"],
    ["llvm ir", "llvm ir"],
    ["notion formula", "notion formula"],
    ["visual basic", "visual basic"],
    ["Visual  Basic", "visual basic"],
    ["visual\tbasic", "visual basic"],
    ["vb.net", "vb.net"],
    ["objective-c", "objective-c"],
  ])("여러 낱말 · 기호가 든 정식 이름 %s 는 그대로", (info, expected) => {
    expect(notionCodeLanguage(info)).toBe(expected);
  });

  it.each(["ascii art", "java/c/c++/c#"])(
    "펜스로 보내면 javascript 가 되는 정식 이름 %s 는 plain text 로",
    (info) => {
      expect(notionCodeLanguage(info)).toBe("plain text");
    },
  );

  it.each([
    "",
    "   ",
    "dataview",
    "dataviewjs",
    "tasks",
    "query",
    "math",
    "ad-note",
    "excalidraw-json",
    "env",
  ])("모르는 이름 · 빈 정보 %j 는 javascript 가 아니라 plain text 로", (info) => {
    expect(notionCodeLanguage(info)).toBe("plain text");
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "객체 원형의 이름 %s 를 언어로 잡지 않는다",
    (info) => {
      expect(notionCodeLanguage(info)).toBe("plain text");
    },
  );

  it.each([
    ['python title="a.py"', "python"],
    ["js {1,3}", "javascript"],
    ["ts   ", "typescript"],
    [" ts", "typescript"],
  ])("속성 · 공백이 붙은 %j 는 첫 낱말로 → %s", (info, expected) => {
    expect(notionCodeLanguage(info)).toBe(expected);
  });

  it("isNotionLanguageInfo — 정보 문자열이 이미 보낼 수 있는 정식 이름인가", () => {
    expect(isNotionLanguageInfo("python")).toBe(true);
    expect(isNotionLanguageInfo("Plain Text")).toBe(true);
    expect(isNotionLanguageInfo("plain\ttext")).toBe(true);
    expect(isNotionLanguageInfo("ts")).toBe(false);
    expect(isNotionLanguageInfo("")).toBe(false);
    expect(isNotionLanguageInfo("ascii art")).toBe(false);
    expect(isNotionLanguageInfo('python title="a.py"')).toBe(false);
  });
});

describe("scanCodeFences — 펜스 찾기", () => {
  it("맨 위 펜스", () => {
    expect(scanCodeFences("앞\n```ts\nlet a = 1\n```\n뒤")).toEqual([
      {
        open: 1,
        close: 3,
        lead: "",
        bar: "```",
        info: "ts",
        closeLead: "",
        closeBar: "```",
        code: ["let a = 1"],
      },
    ]);
  });

  it("콜아웃 안 펜스 — 인용 표시를 떼고 읽고, 빈 줄(>)도 코드다", () => {
    const [found] = scanCodeFences("> [!note] 제목\n> ```python\n> x = 1\n>\n> ```\n뒤");
    expect(found).toMatchObject({ open: 1, close: 4, lead: "> ", info: "python" });
    expect(found!.closeLead).toBe("> ");
    expect(found!.code).toEqual([" x = 1", ""]);
  });

  it("목록 표시와 같은 줄에서 여는 펜스", () => {
    const [found] = scanCodeFences("- ```ts\n  x\n  ```\n- 다음");
    expect(found).toMatchObject({ open: 0, close: 2, lead: "- ", info: "ts", closeLead: "  " });
  });

  it("코드 줄의 목록 표시 모양은 닫는 펜스가 아니다", () => {
    const [found] = scanCodeFences("```md\n- ```js\n```");
    expect(found).toMatchObject({ close: 2, code: ["- ```js"] });
  });

  it("~~~ 펜스와 긴 펜스", () => {
    expect(scanCodeFences("~~~python\nx\n~~~")[0]).toMatchObject({ bar: "~~~", close: 2 });
    const [long] = scanCodeFences("````md\n```js\ny\n```\n````");
    expect(long).toMatchObject({ bar: "````", close: 4, code: ["```js", "y", "```"] });
    expect(hasBacktickFenceLine(long!)).toBe(true);
  });

  it("닫는 펜스 — 같은 문자 · 여는 것 이상 길이 · 뒤에 공백만", () => {
    expect(scanCodeFences("```ts\n~~~\n```")[0]).toMatchObject({ close: 2, code: ["~~~"] });
    expect(scanCodeFences("````ts\n```\n````")[0]).toMatchObject({ close: 2, code: ["```"] });
    expect(scanCodeFences("```md\n```js\n```")[0]).toMatchObject({ close: 2, code: ["```js"] });
    expect(scanCodeFences("```ts\nx\n```   ")[0]).toMatchObject({ close: 2, closeBar: "```" });
  });

  it("여는 쪽보다 3칸 넘게 들여쓴 ``` 는 코드다", () => {
    expect(scanCodeFences("```md\n    ```\n```")[0]).toMatchObject({ close: 2, code: ["    ```"] });
  });

  it("정보 문자열에 백틱이 있으면 펜스가 아니다(인라인 코드)", () => {
    const fences = scanCodeFences("```a``` 는 인라인\n```ts\nx\n```");
    expect(fences).toHaveLength(1);
    expect(fences[0]).toMatchObject({ open: 1, info: "ts" });
  });

  it("인용이 끝나면 펜스도 닫히지 않은 채 끝나고, 그 줄부터 다시 본다", () => {
    const fences = scanCodeFences("> ```ts\n> x\n밖\n```py\ny\n```");
    expect(fences).toHaveLength(2);
    expect(fences[0]).toMatchObject({ open: 0, close: null, code: [" x"] });
    expect(fences[1]).toMatchObject({ open: 3, close: 5, info: "py" });
  });

  it("인용이 끝난 줄이 곧 새 펜스면 그 펜스부터 본다", () => {
    const fences = scanCodeFences("> ```ts\n> x\n```py\ny\n```");
    expect(fences).toHaveLength(2);
    expect(fences[0]).toMatchObject({ open: 0, close: null });
    expect(fences[1]).toMatchObject({ open: 2, close: 4, info: "py" });
  });

  it("끝까지 닫히지 않은 펜스", () => {
    expect(scanCodeFences("```ts\nx")[0]).toMatchObject({ close: null, closeBar: null });
  });

  it("CRLF 노트 — 정보 문자열에 \\r 이 붙지 않고, 닫는 펜스도 찾는다", () => {
    const [found] = scanCodeFences("> ```py\r\n> x\r\n> ```\r\n뒤");
    expect(found).toMatchObject({ open: 0, close: 2, info: "py", closeBar: "```" });
  });

  it("탭은 4칸이다 — 탭으로 들여쓴 ``` 는 열 0 펜스를 닫지 않는다", () => {
    expect(scanCodeFences("```\n\t```\n```")[0]).toMatchObject({ close: 2, code: ["\t```"] });
  });

  it("목록 표시로 연 펜스는 항목 글 자리보다 덜 들여쓴 줄에서 항목과 함께 끝난다", () => {
    const fences = scanCodeFences("- ```py\n  x\n\n  y\n```\nz");
    expect(fences).toHaveLength(2);
    expect(fences[0]).toMatchObject({ open: 0, close: null, code: ["  x", "", "  y"] });
    expect(fences[1]).toMatchObject({ open: 4, close: null, code: ["z"] });
  });

  it("코드 줄 머리 — 인용 표시는 두고 목록 표시는 같은 폭의 공백으로", () => {
    const [quoted, listed, nested] = scanCodeFences(
      "> - ```py\n>   x\n>   ```\n\n1. ```py\n   y\n   ```\n\n> > ```py\n> > z\n> > ```",
    );
    expect(codeLineLead(quoted!)).toBe(">   ");
    expect(codeLineLead(listed!)).toBe("   ");
    expect(codeLineLead(nested!)).toBe("> > ");
  });

  it("Obsidian 이 보여 주는 코드 — 펜스까지의 들여쓰기 폭만큼 뗀다", () => {
    const [listed, tabbed, shallow] = scanCodeFences(
      [
        "- ```py",
        "  def f():",
        "      return 1",
        "  ```",
        "",
        "\t```py",
        "\tx",
        "\t\ty",
        "\t```",
        "",
        "  ```py",
        " a",
        "b",
        "  ```",
      ].join("\n"),
    );
    expect(fenceCodeText(listed!)).toBe("def f():\n    return 1");
    expect(fenceCodeText(tabbed!)).toBe("x\n\ty");
    // CommonMark — 펜스보다 덜 들여쓴 줄은 있는 만큼만 뗀다.
    expect(fenceCodeText(shallow!)).toBe("a\nb");
  });

  it("인용 안 코드는 인용 표시를 뗀 코드다", () => {
    const [fenceInQuote] = scanCodeFences("> ```md\n> ```js\n> y\n> ```\n> ```");
    expect(fenceCodeText(fenceInQuote!)).toBe("```js\ny");
  });

  it("지문은 공백을 무시한다 — 컨테이너 들여쓰기가 달라도 같은 코드", () => {
    const [a] = scanCodeFences("> ```py\n>     x = 1\n> ```");
    const [b] = scanCodeFences("```py\nx = 1   \n```");
    expect(codeFingerprint(a!)).toBe(codeFingerprint(b!));
  });
});

describe("CodeLanguageGuard (push) — Notion 이 그대로 받는 펜스로", () => {
  it.each([
    [fence("ts"), fence("typescript")],
    [fence(""), fence("plain text")],
    [fence("dataview", "LIST"), fence("plain text", "LIST")],
    [fence('python title="a.py"'), fence("python")],
    [fence("Plain Text"), fence("plain text")],
  ])("%j → %j", (input, expected) => {
    expect(push(input)).toBe(expected);
  });

  it("이미 정식 이름이면 그대로", () => {
    const doc = `앞\n\n${fence("python")}\n\n뒤`;
    expect(push(doc)).toBe(doc);
  });

  it("~~~ 펜스와 긴 펜스는 코드에 ``` 줄이 없으면 ``` 로", () => {
    expect(push(fence("python", "x", "~~~"))).toBe(fence("python"));
    expect(push(fence("md", "# 제목", "````"))).toBe(fence("markdown", "# 제목"));
  });

  // S-22: Notion 은 코드에 ``` 줄이 있으면 어떤 펜스 · 이스케이프로 보내도 그 줄에서 블록을 가른다
  // (2026-10-04 실측). 자리표시만 보내고 코드는 본문을 쓴 뒤 블록으로 채운다.
  it("코드에 ``` 줄이 있으면 자리표시를 보내고 코드는 따로 넘긴다", () => {
    const out = pushed("앞\n\n````md\n```js\ny\n```\n````\n\n뒤");
    expect(out.content).toBe(`앞\n\n\`\`\`markdown\n${deferredCodeMarker(0)}\n\`\`\`\n\n뒤`);
    expect(out.metadata.deferredCode).toEqual([
      { token: deferredCodeMarker(0), code: "```js\ny\n```" },
    ]);
  });

  it("들여쓴 ``` 줄도 Notion 이 블록을 가르는 줄로 본다 — 코드를 따로 넘긴다", () => {
    const out = pushed("~~~md\n  ```js\n  y\n  ```\n~~~");
    expect(out.content).toBe(`\`\`\`markdown\n${deferredCodeMarker(0)}\n\`\`\``);
    expect(out.metadata.deferredCode).toEqual([
      { token: deferredCodeMarker(0), code: "  ```js\n  y\n  ```" },
    ]);
  });

  it("코드에 ``` 줄이 없으면 따로 넘기지 않는다", () => {
    const out = pushed(fence("ts", "~~~"));
    expect(out.content).toBe(fence("typescript", "~~~"));
    expect(out.metadata.deferredCode).toBeUndefined();
  });

  it("콜아웃 · 목록 안 코드는 자리표시를 같은 컨테이너의 코드 줄로 보낸다", () => {
    const doc = [
      "> [!tip] 콜아웃",
      "> ````md",
      "> ```py",
      "> z = 1",
      "> ```",
      "> ````",
      "",
      "- 항목",
      "  ````md",
      "  ```sh",
      "  ls",
      "  ```",
      "  ````",
      "",
      "1. ````md",
      "   ```js",
      "   y",
      "   ```",
      "   ````",
    ].join("\n");
    const out = pushed(doc);
    expect(out.content).toBe(
      [
        "> [!tip] 콜아웃",
        "> ```markdown",
        `> ${deferredCodeMarker(0)}`,
        "> ```",
        "",
        "- 항목",
        "  ```markdown",
        `  ${deferredCodeMarker(1)}`,
        "  ```",
        "",
        "1. ```markdown",
        `   ${deferredCodeMarker(2)}`,
        "   ```",
      ].join("\n"),
    );
    expect(out.metadata.deferredCode!.map((d) => d.code)).toEqual([
      "```py\nz = 1\n```",
      "```sh\nls\n```",
      "```js\ny\n```",
    ]);
  });

  it("코드 블록 하나에 담을 수 없을 만큼 긴 코드는 넘기지 않고 넓은 펜스째 보낸다", () => {
    const long = "x".repeat(RICH_TEXT_CONTENT_MAX * RICH_TEXT_ARRAY_MAX);
    const doc = `\`\`\`\`md\n\`\`\`js\n${long}\n\`\`\`\n\`\`\`\`\n\n\`\`\`\`md\n\`\`\`py\n\`\`\`\n\`\`\`\``;
    const out = pushed(doc);
    // 펜스를 ``` 로 줄이면 Obsidian 에서도 코드 속 줄이 블록을 닫는다 — 넓힌 채 둔다.
    expect(out.content).toBe(
      `\`\`\`\`markdown\n\`\`\`js\n${long}\n\`\`\`\n\`\`\`\`\n\n\`\`\`markdown\n${deferredCodeMarker(0)}\n\`\`\``,
    );
    expect(out.metadata.deferredCode).toEqual([
      { token: deferredCodeMarker(0), code: "```py\n```" },
    ]);
  });

  it("앞 처리기가 넘긴 코드 뒤에 번호를 이어 붙인다", () => {
    const earlier = [{ token: deferredCodeMarker(0), code: "```x\n```" }];
    const out = pushed("````md\n```js\n```\n````", { deferredCode: earlier });
    expect(out.content).toBe(`\`\`\`markdown\n${deferredCodeMarker(1)}\n\`\`\``);
    expect(out.metadata.deferredCode).toEqual([
      ...earlier,
      { token: deferredCodeMarker(1), code: "```js\n```" },
    ]);
  });

  it("콜아웃 · 목록 안 펜스도 접두를 지키며 바꾼다", () => {
    expect(push("> [!note] 제목\n> ```dataview\n> LIST\n> ```")).toBe(
      "> [!note] 제목\n> ```plain text\n> LIST\n> ```",
    );
    expect(push("- ```ts\n  x\n  ```")).toBe("- ```typescript\n  x\n  ```");
  });

  it("닫히지 않은 펜스와 인라인 코드는 건드리지 않는다", () => {
    expect(push("```ts\nx")).toBe("```ts\nx");
    expect(push("```a``` 는 인라인")).toBe("```a``` 는 인라인");
  });

  it("pull 방향에서는 무동작", () => {
    const input: ProcessorInput = { content: fence("ts"), metadata: {}, context: pullContext };
    expect(new CodeLanguageGuard().process(input).content).toBe(fence("ts"));
  });
});

describe("CodeLanguageRestorer (pull) — 로컬 노트의 원래 표기로", () => {
  it.each([
    ["맨 펜스", fence(""), fence("plain text")],
    ["별칭", fence("ts"), fence("typescript")],
    ["Dataview", fence("dataview", "LIST"), fence("plain text", "LIST")],
    ["속성", fence('python title="a.py"'), fence("python")],
    ["대소문자", fence("TypeScript"), fence("typescript")],
  ])("%s 를 되돌린다", (_name, local, pulled) => {
    expect(pull(pulled, local)).toBe(local);
  });

  it("이 버전 전에 올린 노트 — Notion 이 javascript 로 저장한 것도 코드가 같으면 되돌린다", () => {
    expect(pull(fence("javascript"), fence(""))).toBe(fence(""));
    expect(pull(fence("javascript", "LIST"), fence("dataview", "LIST"))).toBe(
      fence("dataview", "LIST"),
    );
  });

  it("이 버전 전에 올린 노트라도 Notion 에서 코드를 고쳤으면 javascript 로 받는다", () => {
    // Notion 에서 JavaScript 로 바꾸고 고친 블록과 가를 수 없다 — 코드가 같을 때만 되돌린다.
    expect(pull(fence("javascript", "LIST FROM b"), fence("dataview", "LIST FROM a"))).toBe(
      fence("javascript", "LIST FROM b"),
    );
  });

  it("원래 정식 이름이던 펜스가 javascript 로 오면 Notion 에서 바꾼 것이다", () => {
    expect(pull(fence("javascript"), fence("python"))).toBe(fence("javascript"));
  });

  it("Notion 에서 언어를 바꿨으면 그쪽을 따른다", () => {
    expect(pull(fence("sql", "LIST"), fence("dataview", "LIST"))).toBe(fence("sql", "LIST"));
  });

  it("받은 언어의 대소문자는 가리지 않는다", () => {
    expect(pull(fence("TypeScript", "y"), fence("ts", "x"))).toBe(fence("ts", "y"));
  });

  it("Notion 에서 코드를 고쳤으면 언어만 되돌린다", () => {
    expect(pull(fence("plain text", "TABLE x"), fence("dataview", "LIST"))).toBe(
      fence("dataview", "TABLE x"),
    );
  });

  it("Notion 에서 더한 블록은 그대로 둔다", () => {
    const local = fence("dataview", "LIST");
    const pulled = `${fence("plain text", "새 블록")}\n\n${fence("plain text", "LIST")}`;
    expect(pull(pulled, local)).toBe(`${fence("plain text", "새 블록")}\n\n${local}`);
  });

  it("블록을 더하고 고치기까지 했으면 같은 줄이 있는 것끼리만 짝짓는다", () => {
    const local = fence("dataview", "LIST\nFROM a");
    const pulled = `${fence("plain text", "hello")}\n\n${fence("plain text", "LIST\nFROM b")}`;
    expect(pull(pulled, local)).toBe(
      `${fence("plain text", "hello")}\n\n${fence("dataview", "LIST\nFROM b")}`,
    );
  });

  it("같은 줄이 많은 짝부터 — 앞에 더한 블록이 흔한 줄 하나로 짝을 가로채지 않는다", () => {
    const local = fence("dataview", "LIST\nFROM a\nWHERE b");
    const pulled = `${fence("plain text", "LIST")}\n\n${fence("plain text", "LIST\nFROM a\nWHERE c")}`;
    expect(pull(pulled, local)).toBe(
      `${fence("plain text", "LIST")}\n\n${fence("dataview", "LIST\nFROM a\nWHERE c")}`,
    );
  });

  it("Notion 에서 한 블록을 지우고 다른 블록을 고쳤으면 고친 블록은 가장 가까운 것 하나와만", () => {
    const local = `${fence("dataview", "LIST\nFROM a\nWHERE y")}\n\n${fence("tasks", "LIST\nnot done")}`;
    expect(pull(fence("plain text", "LIST\nFROM a\nWHERE x"), local)).toBe(
      fence("dataview", "LIST\nFROM a\nWHERE x"),
    );
  });

  it("같은 줄은 공백을 무시하고 보되, 빈 줄은 같은 줄로 세지 않는다", () => {
    const local = fence("ts", "  a()\n\n  b()");
    const indented = `${fence("typescript", "other()")}\n\n${fence("typescript", "\ta()\n\tc()")}`;
    expect(pull(indented, local)).toBe(
      `${fence("typescript", "other()")}\n\n${fence("ts", "\ta()\n\tc()")}`,
    );
    const blankOnly = `${fence("typescript", "x()\n\ny()")}\n\n${fence("typescript", "c()")}`;
    expect(pull(blankOnly, local)).toBe(blankOnly);
  });

  it("같은 코드가 여럿이면 순서대로", () => {
    const local = `${fence("ts")}\n\n${fence("tsx")}`;
    const pulled = `${fence("typescript")}\n\n${fence("typescript")}`;
    expect(pull(pulled, local)).toBe(local);
  });

  it("~~~ 펜스와 긴 펜스를 되돌린다", () => {
    expect(pull(fence("python"), fence("python", "x", "~~~"))).toBe(fence("python", "x", "~~~"));
    expect(pull(fence("markdown", "# 제목"), fence("md", "# 제목", "````"))).toBe(
      fence("md", "# 제목", "````"),
    );
  });

  it("코드를 고친 블록은 받은 펜스 기호를 둔다", () => {
    expect(pull(fence("python", "y"), fence("python3", "x", "~~~"))).toBe(fence("python3", "y"));
  });

  it("콜아웃 안 펜스 — 받은 접두를 지킨다", () => {
    const local = "> [!note] 제목\n> ```dataview\n> LIST\n> ```";
    expect(pull("> [!note] 제목\n> ```plain text\n> LIST\n> ```", local)).toBe(local);
  });

  it("로컬 노트가 없으면 받은 그대로", () => {
    expect(pull(fence("plain text"))).toBe(fence("plain text"));
  });

  it("push 방향에서는 무동작", () => {
    const input: ProcessorInput = {
      content: fence("plain text"),
      metadata: { localContent: fence("") },
      context: pushContext,
    };
    expect(new CodeLanguageRestorer().process(input).content).toBe(fence("plain text"));
  });
});

describe("파이프라인 왕복 — 펜스 표기가 그대로 돌아온다", () => {
  const DOC = [
    "# 코드 모음",
    "",
    fence("", "맨 펜스"),
    "",
    fence("ts", "let a: number = 1"),
    "",
    fence("dataview", "LIST FROM #tag"),
    "",
    fence('python title="a.py"', "print(1)"),
    "",
    fence("bash", "echo hi", "~~~"),
    "",
    fence("md", "# 안쪽 제목", "````"),
    "",
    "> [!example] 콜아웃",
    "> ```dataviewjs",
    "> dv.list([1, 2])",
    "> ```",
    "",
    "- 목록",
    "",
    "  ```zsh",
    "  ls -al",
    "  ```",
  ].join("\n");

  it("push 는 Notion 이름만 보낸다", () => {
    const sent = scanCodeFences(push(DOC)).map((f) => `${f.bar}${f.info}`);
    expect(sent).toEqual([
      "```plain text",
      "```typescript",
      "```plain text",
      "```python",
      "```bash",
      "```markdown",
      "```plain text",
      "```shell",
    ]);
  });

  it("push → pull 이 원문과 같다", () => {
    const { inputBody, outputBody } = roundtrip(DOC);
    expect(outputBody).toBe(inputBody);
  });
});

describe("블록 방식 push — martian 이 정한 언어를 펜스 언어로", () => {
  it.each([
    ["plain text", "plain text"],
    ["llvm ir", "llvm ir"],
    ["toml", "toml"],
    ["visual basic", "visual basic"],
    ["typescript", "typescript"],
  ])("```%s → %s", (info, expected) => {
    const blocks = new BlockConverter().markdownToNotionBlocks(fence(info, "a = 1")) as Array<{
      type: string;
      code?: { language: string };
    }>;
    expect(blocks.find((b) => b.type === "code")?.code?.language).toBe(expected);
  });

  /** 블록 트리의 코드 블록 언어 — 목록 · 콜아웃 아래까지. */
  function languages(markdown: string): string[] {
    const found: string[] = [];
    const visit = (block: Record<string, unknown>): void => {
      const body = block[block.type as string] as
        { language?: string; children?: Array<Record<string, unknown>> } | undefined;
      if (block.type === "code") found.push(body?.language ?? "");
      for (const child of body?.children ?? []) visit(child);
    };
    new BlockConverter().markdownToNotionBlocks(markdown).forEach((b) => visit(b as never));
    return found;
  }

  it("목록 아래 펜스도", () => {
    expect(languages("- 항목\n\n  ```toml\n  a = 1\n  ```")).toEqual(["toml"]);
  });

  it("같은 코드의 펜스가 여럿이면 차례로 제 언어를", () => {
    expect(languages(`${fence("ts", "x = 1")}\n\n${fence("py", "x = 1")}`)).toEqual([
      "typescript",
      "python",
    ]);
  });

  it("닫히지 않은 펜스(문서 끝까지 코드)도 — martian 은 `text` 를 vb.net 으로 보낸다", () => {
    expect(languages("```text\na = 1")).toEqual(["plain text"]);
  });
});
