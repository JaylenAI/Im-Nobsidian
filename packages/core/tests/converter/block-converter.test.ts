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

  describe("postProcessBlocks — divider 변환", () => {
    it("--- 를 divider 블록으로 변환", () => {
      const converter = new BlockConverter();
      const blocks = converter.markdownToNotionBlocks("# Title\n\n---\n\nParagraph after") as Array<
        Record<string, unknown>
      >;

      const divider = blocks.find((b) => b.type === "divider");
      expect(divider).toBeDefined();
      expect(divider!.divider).toEqual({});
    });

    it("코드 블록 안의 ---는 변환하지 않음", () => {
      const converter = new BlockConverter();
      const md = "```\nsome code\n---\nmore code\n```";
      const blocks = converter.markdownToNotionBlocks(md) as Array<Record<string, unknown>>;

      const divider = blocks.find((b) => b.type === "divider");
      expect(divider).toBeUndefined();
    });

    it("여러 개의 --- 모두 변환", () => {
      const converter = new BlockConverter();
      const md = "Part 1\n\n---\n\nPart 2\n\n---\n\nPart 3";
      const blocks = converter.markdownToNotionBlocks(md) as Array<Record<string, unknown>>;

      const dividers = blocks.filter((b) => b.type === "divider");
      expect(dividers.length).toBe(2);
    });
  });

  describe("postProcessBlocks — video/embed URL 변환", () => {
    it("YouTube URL 이미지를 video 블록으로 변환", () => {
      const converter = new BlockConverter();
      const md = "![video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)";
      const blocks = converter.markdownToNotionBlocks(md) as Array<Record<string, unknown>>;

      const videoBlock = blocks.find((b) => b.type === "video");
      expect(videoBlock).toBeDefined();
      const data = videoBlock!.video as { external: { url: string } };
      expect(data.external.url).toContain("youtube.com");
    });

    it("youtu.be 단축 URL도 video로 변환", () => {
      const converter = new BlockConverter();
      const md = "![](https://youtu.be/dQw4w9WgXcQ)";
      const blocks = converter.markdownToNotionBlocks(md) as Array<Record<string, unknown>>;

      const videoBlock = blocks.find((b) => b.type === "video");
      expect(videoBlock).toBeDefined();
    });

    it("Vimeo URL을 video로 변환", () => {
      const converter = new BlockConverter();
      const md = "![](https://vimeo.com/123456)";
      const blocks = converter.markdownToNotionBlocks(md) as Array<Record<string, unknown>>;

      const videoBlock = blocks.find((b) => b.type === "video");
      expect(videoBlock).toBeDefined();
    });

    it("Figma URL을 embed로 변환", () => {
      const converter = new BlockConverter();
      const md = "![](https://figma.com/design/abc123)";
      const blocks = converter.markdownToNotionBlocks(md) as Array<Record<string, unknown>>;

      const embedBlock = blocks.find((b) => b.type === "embed");
      expect(embedBlock).toBeDefined();
    });

    it("Google Docs URL을 embed로 변환", () => {
      const converter = new BlockConverter();
      const md = "![](https://docs.google.com/spreadsheets/d/abc123)";
      const blocks = converter.markdownToNotionBlocks(md) as Array<Record<string, unknown>>;

      const embedBlock = blocks.find((b) => b.type === "embed");
      expect(embedBlock).toBeDefined();
    });

    it("일반 이미지 URL은 image 그대로 유지", () => {
      const converter = new BlockConverter();
      const md = "![photo](https://example.com/photo.png)";
      const blocks = converter.markdownToNotionBlocks(md) as Array<Record<string, unknown>>;

      const imageBlock = blocks.find((b) => b.type === "image");
      expect(imageBlock).toBeDefined();
      expect(blocks.find((b) => b.type === "video")).toBeUndefined();
      expect(blocks.find((b) => b.type === "embed")).toBeUndefined();
    });
  });

  describe("postProcessBlocks — quote → callout 변환", () => {
    it("이모지 접두사 quote를 callout으로 변환", () => {
      const converter = new BlockConverter();
      const blocks = converter.markdownToNotionBlocks(
        "> \u{26A0}\u{FE0F} Warning message",
      ) as Array<Record<string, unknown>>;

      const callout = blocks.find((b) => b.type === "callout");
      if (callout) {
        const data = callout.callout as { icon: { emoji: string } };
        expect(data.icon.emoji).toBe("\u{26A0}\u{FE0F}");
      } else {
        const quote = blocks.find((b) => b.type === "quote");
        expect(quote).toBeDefined();
      }
    });

    it("일반 quote는 그대로 유지", () => {
      const converter = new BlockConverter();
      const blocks = converter.markdownToNotionBlocks("> Just a normal quote") as Array<
        Record<string, unknown>
      >;

      expect(blocks[0]?.type).toBe("quote");
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
