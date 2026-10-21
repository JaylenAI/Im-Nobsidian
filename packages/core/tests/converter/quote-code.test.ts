/**
 * 일반 인용 안 코드 펜스 → 인용의 자식 코드 블록 (S-23).
 *
 * Notion 은 인용의 `>` 한 줄을 인용 블록 하나로 읽어, 인용 안 펜스가 글이 펜스 기호인 인용 블록들이 됐다.
 */
import { describe, it, expect } from "vitest";
import { quotedCodeToChildren } from "../../src/converter/quote-code.js";
import { obsidianToNotionEnhanced } from "../../src/converter/enhanced-md-converter.js";
import { nfmToBlocks } from "../../src/converter/nfm-to-blocks.js";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";
import { sentForm } from "../../src/converter/sent-form.js";

const lines = (...l: string[]) => l.join("\n");

describe("quotedCodeToChildren", () => {
  it("펜스를 앞 인용 줄의 자식으로 — pull 이 인용의 자식을 쓰는 꼴(빈 줄 뒤 2칸)", () => {
    expect(quotedCodeToChildren(lines("> 설명", "> ```js", "> x", ">", "> ```"))).toBe(
      lines("> 설명", "", "  ```js", "  x", "", "  ```"),
    );
  });

  it("인용이 코드로 시작하면 빈 인용 줄이 부모 · 뒤 인용 줄은 새 인용", () => {
    expect(quotedCodeToChildren(lines("> ```", "> x", "> ```", "> 뒤"))).toBe(
      lines(">", "", "  ```", "  x", "  ```", "", "> 뒤"),
    );
  });

  it("이어지는 펜스도 같은 인용 줄의 자식", () => {
    expect(
      quotedCodeToChildren(lines("> 앞", "> ```", "> a", "> ```", "> ```", "> b", "> ```")),
    ).toBe(lines("> 앞", "", "  ```", "  a", "  ```", "", "  ```", "  b", "  ```"));
  });

  it.each([
    ["콜아웃", lines("> [!note] t", "> ```", "> x", "> ```")],
    ["닫히지 않은 펜스", lines("> 앞", "> ```js", "> x")],
    ["중첩 인용 안", lines("> > ```", "> > x", "> > ```")],
    ["코드 블록 안의 인용 모양 줄", lines("```", "> ```", "> x", "> ```", "```")],
  ])("%s 는 그대로", (_name, note) => {
    expect(quotedCodeToChildren(note)).toBe(note);
  });
});

describe("push — 인용 안 코드가 Notion 에서 코드 블록이 된다", () => {
  it("인용 블록 아래 자식 코드 블록 하나", () => {
    const blocks = nfmToBlocks(
      obsidianToNotionEnhanced(lines("> 설명", "> ```js", "> x", "> ```")),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("quote");
    const children = (blocks[0] as { quote: { children: Array<{ type: string; code?: unknown }> } })
      .quote.children;
    expect(children.map((c) => c.type)).toEqual(["code"]);
  });

  it("받은 노트(인용의 자식 코드)와 같은 꼴로 올라간다 — pull 이 로컬의 `> ```` 표기를 남긴다", () => {
    const pipeline = createDefaultPipeline();
    const ctx = { direction: "pull", path: "markdown-api", filePath: "a.md" } as const;
    const local = lines("> 설명", "> ```js", "> x", "> ```");
    const pulled = lines("> 설명", "", "  ```javascript", "  x", "  ```");
    expect(sentForm(pipeline, local, ctx)).toBe(sentForm(pipeline, pulled, ctx));
  });
});
