import { describe, it, expect } from "vitest";
import { BlockConverter } from "../../src/converter/block-converter.js";

describe("BlockConverter", () => {
  describe("markdownToNotionBlocks", () => {
    it("마크다운을 Notion 블록으로 변환", () => {
      const converter = new BlockConverter();
      const blocks = converter.markdownToNotionBlocks("# Hello\n\nParagraph text");

      expect(blocks).toBeDefined();
      expect(Array.isArray(blocks)).toBe(true);
      expect(blocks.length).toBeGreaterThan(0);
    });

    it("빈 문자열은 빈 배열 반환", () => {
      const converter = new BlockConverter();
      const blocks = converter.markdownToNotionBlocks("");
      expect(blocks).toEqual([]);
    });

    it("리스트 변환", () => {
      const converter = new BlockConverter();
      const blocks = converter.markdownToNotionBlocks("- item 1\n- item 2\n- item 3");

      expect(blocks.length).toBeGreaterThan(0);
    });

    it("코드 블록 변환", () => {
      const converter = new BlockConverter();
      const md = "```typescript\nconst x = 1;\n```";
      const blocks = converter.markdownToNotionBlocks(md);

      expect(blocks.length).toBeGreaterThan(0);
    });
  });

  describe("notionBlocksToMarkdown", () => {
    it("초기화 안 된 상태에서 호출 시 에러", async () => {
      const converter = new BlockConverter();
      await expect(converter.notionBlocksToMarkdown("some-id")).rejects.toThrow(
        "NotionToMarkdown이 초기화되지 않았습니다",
      );
    });
  });
});
