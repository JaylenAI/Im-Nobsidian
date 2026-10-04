/**
 * 코드 속 펜스 줄(S-22) — pull 쪽.
 *
 * Notion 은 코드에 ``` 로 시작하는 줄이 있어도 펜스를 넓히지 않고 ``` 로 내보낸다. 여는 줄에는 늘
 * 제 언어 이름을 붙이고, 코드 줄은 컨테이너 깊이와 상관없이 열 0 에 둔다(2026-10-04 실측, 아래
 * `EXPORT` 는 그때 받은 본문의 모양 그대로다). 예전에는 맨 위 코드가 코드 속 첫 ``` 줄에서 닫혀 코드
 * 뒷부분이 본문이 되고, 진짜 닫는 줄이 새 코드 블록을 열어 노트 끝까지 삼켰다.
 */
import { describe, it, expect } from "vitest";
import type { Client } from "@notionhq/client";
import { BlockConverter } from "../../src/converter/block-converter.js";
import {
  fenceBarAbove,
  needsCodeBlockTexts,
  widenNestedCodeFences,
} from "../../src/converter/nested-code-fence.js";
import { notionEnhancedToObsidian } from "../../src/converter/enhanced-md-converter.js";
import { codeBoundaryDrift } from "../render/rules.js";

/** 실측 export — 블록 API 로 만든 코드 블록들을 Markdown API 로 받은 본문. */
const EXPORT = [
  "F1 코드 안 백틱 3개 펜스:",
  "```javascript",
  "before",
  "```js",
  "nested();",
  "```",
  "after",
  "```",
  "F2 코드 안 백틱 4개 펜스:",
  "```markdown",
  "````md",
  "```js",
  "x",
  "```",
  "````",
  "```",
  "F3 코드 안 물결 펜스:",
  "```plain text",
  "~~~",
  "y",
  "~~~",
  "```",
  "F4 코드가 펜스 줄로 끝남:",
  "```javascript",
  "```",
  "```",
  '<callout icon="💡">',
  "\tF5 콜아웃",
  "\t```javascript",
  "in callout",
  "```py",
  "z = 1",
  "```",
  "\t```",
  "</callout>",
  "- F6 항목",
  "\t```javascript",
  "in list",
  "```sh",
  "ls",
  "```",
  "\t```",
  "F7 들여쓴 펜스 줄:",
  "```javascript",
  "x",
  "  ```",
  "  y",
  "  ```",
  "```",
  "F8 끝",
].join("\n");

/** 실측 때 블록 API 로 넣은 코드 — 블록의 글. */
const CODE_TEXTS = new Set([
  "before\n```js\nnested();\n```\nafter",
  "````md\n```js\nx\n```\n````",
  "~~~\ny\n~~~",
  "```",
  "in callout\n```py\nz = 1\n```",
  "in list\n```sh\nls\n```",
  "x\n  ```\n  y\n  ```",
]);

/** Obsidian 처럼 순차로 짝지어 코드 블록마다 코드를 모은다 — 인용 표시 · 펜스 들여쓰기는 뗀다. */
function obsidianCodeBlocks(md: string): string[] {
  const blocks: string[] = [];
  let open: { bar: string; indent: number; lines: string[] } | null = null;
  for (const raw of md.split("\n")) {
    const line = raw.replace(/^(?:[ \t]*>)+ ?/, "");
    const fence = /^([ \t]*)(`{3,}|~{3,})(.*)$/.exec(line);
    if (!open) {
      if (fence) open = { bar: fence[2]!, indent: fence[1]!.length, lines: [] };
      continue;
    }
    if (
      fence &&
      fence[2]![0] === open.bar[0] &&
      fence[2]!.length >= open.bar.length &&
      fence[3]!.trim() === ""
    ) {
      blocks.push(open.lines.join("\n"));
      open = null;
      continue;
    }
    open.lines.push(line.slice(Math.min(open.indent, /^[ \t]*/.exec(line)![0].length)));
  }
  return blocks;
}

describe("코드 속 펜스 줄 — 실측 export (S-22)", () => {
  it("맨 위 코드는 경계 펜스를 코드 속 펜스보다 길게 넓힌다", () => {
    const widened = widenNestedCodeFences(EXPORT, CODE_TEXTS);
    expect(widened).toContain("````javascript\nbefore\n```js\nnested();\n```\nafter\n````");
    expect(widened).toContain("`````markdown\n````md\n```js\nx\n```\n````\n`````");
    expect(widened).toContain("````javascript\n```\n````");
    expect(widened).toContain("````javascript\nx\n  ```\n  y\n  ```\n````");
  });

  it("코드에 ``` 줄이 없으면 그대로 — ~~~ 는 백틱 펜스를 닫지 않는다", () => {
    expect(widenNestedCodeFences(EXPORT, CODE_TEXTS)).toContain(
      "F3 코드 안 물결 펜스:\n```plain text\n~~~\ny\n~~~\n```",
    );
  });

  it("컨테이너 안 코드는 같은 들여쓰기의 경계 펜스를 넓힌다", () => {
    const widened = widenNestedCodeFences(EXPORT, CODE_TEXTS);
    expect(widened).toContain("\t````javascript\nin callout\n```py\nz = 1\n```\n\t````");
    expect(widened).toContain("\t````javascript\nin list\n```sh\nls\n```\n\t````");
  });

  it("받은 노트에서 Obsidian 이 읽는 코드가 블록의 글과 같다", () => {
    const pulled = notionEnhancedToObsidian(EXPORT, { codeTexts: CODE_TEXTS });
    expect(obsidianCodeBlocks(pulled)).toEqual([...CODE_TEXTS]);
    expect(pulled).toContain("F8 끝");
  });

  it("예전 변환은 코드 뒷부분을 본문으로 흘리고 뒤 블록을 삼켰다", () => {
    // 넓히지 않고 읽으면 코드 블록 수부터 어긋난다 — 이 테스트가 고친 것을 잠근다.
    expect(obsidianCodeBlocks(EXPORT)).not.toEqual([...CODE_TEXTS]);
    expect(
      codeBoundaryDrift(EXPORT, notionEnhancedToObsidian(EXPORT, { codeTexts: CODE_TEXTS })),
    ).not.toContainEqual(expect.objectContaining({ name: "코드블록수", after: 0 }));
  });
});

describe("코드 범위 — 규칙만으로 가를 수 없을 때 블록의 글로", () => {
  // 코드 블록 둘로 읽어도, 코드가 "a\n```\n```python\nb" 인 블록 하나로 읽어도 규칙에 맞는다.
  const twoReadings = ["```markdown", "a", "```", "```python", "b", "```", "끝"].join("\n");

  it("맨 위 코드 안에 여는 줄 · 닫는 줄 모양이 있으면 글이 필요하다", () => {
    expect(needsCodeBlockTexts(EXPORT)).toBe(true);
    expect(needsCodeBlockTexts("```markdown\n```python\nx\n```\n```")).toBe(true);
  });

  it("코드 블록 여럿이 차례로 있을 뿐이면 글 없이 그 읽기를 믿는다", () => {
    // 하나로 읽는 길도 규칙에는 맞지만, 그러려면 코드가 펜스를 닫고 새 펜스를 연 채 끝나야 한다 —
    // 드문 글 때문에 코드 블록이 둘 이상인 페이지마다 블록을 읽지 않는다(ADR-029).
    const plain = "```python\na\n```\n본문\n```python\nb\n```";
    expect(needsCodeBlockTexts(plain)).toBe(false);
    expect(widenNestedCodeFences(plain)).toBe(plain);
    expect(needsCodeBlockTexts(twoReadings)).toBe(false);
  });

  it("컨테이너 안 코드의 열 0 펜스 줄은 글 없이 가른다", () => {
    const callout = '<callout icon="💡">\n\t```markdown\n```js\nx\n```\n\t```\n</callout>';
    expect(needsCodeBlockTexts(callout)).toBe(false);
    expect(widenNestedCodeFences(callout)).toBe(
      '<callout icon="💡">\n\t````markdown\n```js\nx\n```\n\t````\n</callout>',
    );
  });

  it("글이 하나로 읽기를 가리키면 끝까지 하나의 코드다", () => {
    const texts = new Set(["a\n```\n```python\nb"]);
    expect(widenNestedCodeFences(twoReadings, texts)).toBe(
      ["````markdown", "a", "```", "```python", "b", "````", "끝"].join("\n"),
    );
  });

  it("글이 둘로 읽기를 가리키면 그대로 둔다", () => {
    const texts = new Set(["a", "b"]);
    expect(widenNestedCodeFences(twoReadings, texts)).toBe(twoReadings);
  });

  it("글이 없으면 규칙에 맞는 가장 가까운 닫는 줄이다", () => {
    expect(widenNestedCodeFences(twoReadings)).toBe(twoReadings);
  });
});

describe("코드 범위 — 규칙에 맞게 읽을 수 없으면 손대지 않는다", () => {
  it("코드 밖에 맨 ``` 줄이 남으면 그대로", () => {
    const stray = "```javascript\n```js\nx\n```\n본문\n```\n```";
    expect(widenNestedCodeFences(stray)).not.toBe(stray);
    const orphan = "본문\n```\n```javascript\n```js\n```";
    expect(widenNestedCodeFences(orphan)).toBe(orphan);
  });

  it("컨테이너 안 코드는 닫는 줄을 건너뛰어 뒤 블록을 삼키지 않는다", () => {
    // 여는 줄에 Notion 언어 이름이 없는 블록(합성) — 그 닫는 줄을 앞 블록의 닫는 줄로 쓰면 둘째
    // 블록이 첫째 코드가 된다. 읽기를 그만두고 예전처럼 둔다.
    const doc = [
      '<callout icon="💡">',
      "\t```python",
      "x",
      "\t```",
      "</callout>",
      "<details>",
      "<summary>로그</summary>",
      "\t```",
      "y",
      "\t```",
      "</details>",
    ].join("\n");
    expect(widenNestedCodeFences(doc)).toBe(doc);
    expect(needsCodeBlockTexts(doc)).toBe(false);
  });

  it("닫히지 않은 코드는 그대로", () => {
    const open = "```javascript\n```js\nx";
    expect(widenNestedCodeFences(open)).toBe(open);
  });

  it("펜스가 없으면 그대로", () => {
    expect(widenNestedCodeFences("본문만")).toBe("본문만");
    expect(needsCodeBlockTexts("본문만")).toBe(false);
  });
});

describe("fenceBarAbove — 코드를 감쌀 백틱 펜스", () => {
  it.each([
    [["x"], null],
    [["~~~", "y"], null],
    [["```js"], "````"],
    [["  ````md", "```"], "`````"],
    [["\t```"], "````"],
    [["`` 인라인"], null],
  ])("%j → %j", (code, bar) => {
    expect(fenceBarAbove(code)).toBe(bar);
  });
});

describe("블록 폴백 pull(notion-to-md) — 코드 속 펜스 줄", () => {
  // 평면 블록만 넣는다 — 클라이언트를 부르면 오프라인 위반이다.
  const offline = new Proxy(
    {},
    {
      get() {
        throw new Error("오프라인 위반: Notion 클라이언트가 호출됨");
      },
    },
  ) as unknown as Client;
  const converter = new BlockConverter();
  converter.initNotionToMd(offline);
  const code = (text: string[], language: string) => ({
    object: "block",
    id: `code-${language}`,
    type: "code",
    has_children: false,
    // 글이 rich text 여럿에 나뉘어 와도 이어 붙인다 — 긴 코드는 2,000자씩 나뉜다.
    code: { language, caption: [], rich_text: text.map(richText) },
  });
  const richText = (content: string) => ({
    type: "text",
    text: { content, link: null },
    plain_text: content,
    href: null,
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: "default",
    },
  });

  it("코드에 ``` 줄이 있으면 그보다 긴 펜스로 감싼다", async () => {
    const md = await converter.notionBlockArrayToMarkdown([
      code(["before\n```js\nnested();", "\n```\nafter"], "JavaScript"),
    ]);
    expect(md.trim()).toBe("````javascript\nbefore\n```js\nnested();\n```\nafter\n````");
    expect(obsidianCodeBlocks(md)).toEqual(["before\n```js\nnested();\n```\nafter"]);
  });

  it("``` 줄이 없으면 기본 렌더 그대로", async () => {
    const md = await converter.notionBlockArrayToMarkdown([code(["const x = 1;"], "typescript")]);
    expect(md.trim()).toBe("```typescript\nconst x = 1;\n```");
  });
});
