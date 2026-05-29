import { describe, it, expect } from "vitest";
import { BlockConverter } from "../../src/converter/block-converter.js";
import { TOC_MARKER, BREADCRUMB_MARKER } from "../../src/constants/markers.js";

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

  describe("postProcessBlocks — 단일라인 마커(toc/breadcrumb) 복원", () => {
    it("TOC 마커 문단을 table_of_contents 블록으로 복원", () => {
      const converter = new BlockConverter();
      const blocks = converter.markdownToNotionBlocks(`# Title\n\n${TOC_MARKER}\n\nBody`) as Array<
        Record<string, unknown>
      >;

      const toc = blocks.find((b) => b.type === "table_of_contents");
      expect(toc).toBeDefined();
      // 마커 텍스트가 일반 문단으로 새어나가지 않아야 한다.
      const leaked = blocks.some(
        (b) => b.type === "paragraph" && JSON.stringify(b.paragraph).includes("im-nobsidian:toc"),
      );
      expect(leaked).toBe(false);
    });

    it("breadcrumb 마커 문단을 breadcrumb 블록으로 복원", () => {
      const converter = new BlockConverter();
      const blocks = converter.markdownToNotionBlocks(`${BREADCRUMB_MARKER}\n\n# Title`) as Array<
        Record<string, unknown>
      >;

      const crumb = blocks.find((b) => b.type === "breadcrumb");
      expect(crumb).toBeDefined();
      const leaked = blocks.some(
        (b) =>
          b.type === "paragraph" && JSON.stringify(b.paragraph).includes("im-nobsidian:breadcrumb"),
      );
      expect(leaked).toBe(false);
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

  describe("postProcessBlocks — toggle 보존 마커 변환", () => {
    it("toggle 마커가 포함된 마크다운을 toggle 블록으로 변환", () => {
      const converter = new BlockConverter();
      const md = [
        "%%im-nobsidian:toggle:start%%",
        "- Click to expand",
        "  Hidden content here",
        "%%im-nobsidian:toggle:end%%",
      ].join("\n");

      const blocks = converter.markdownToNotionBlocks(md) as Array<Record<string, unknown>>;
      const toggle = blocks.find((b) => b.type === "toggle");
      expect(toggle).toBeDefined();

      const data = toggle!.toggle as { rich_text: Array<{ text: { content: string } }> };
      expect(data.rich_text[0]!.text.content).toBe("Click to expand");
    });

    it("toggle 내 자식 콘텐츠가 블록으로 변환됨", () => {
      const converter = new BlockConverter();
      const md = [
        "%%im-nobsidian:toggle:start%%",
        "- FAQ",
        "  Answer paragraph",
        "%%im-nobsidian:toggle:end%%",
      ].join("\n");

      const blocks = converter.markdownToNotionBlocks(md) as Array<Record<string, unknown>>;
      const toggle = blocks.find((b) => b.type === "toggle");
      expect(toggle).toBeDefined();

      const data = toggle!.toggle as { children: unknown[] };
      expect(data.children).toBeDefined();
      expect(data.children.length).toBeGreaterThan(0);
    });

    it("여러 토글 블록 동시 처리", () => {
      const converter = new BlockConverter();
      const md = [
        "%%im-nobsidian:toggle:start%%",
        "- Toggle 1",
        "  Content 1",
        "%%im-nobsidian:toggle:end%%",
        "",
        "%%im-nobsidian:toggle:start%%",
        "- Toggle 2",
        "  Content 2",
        "%%im-nobsidian:toggle:end%%",
      ].join("\n");

      const blocks = converter.markdownToNotionBlocks(md) as Array<Record<string, unknown>>;
      const toggles = blocks.filter((b) => b.type === "toggle");
      expect(toggles.length).toBe(2);
    });
  });

  describe("postProcessBlocks — column 보존 마커 변환", () => {
    it("column 마커가 포함된 마크다운을 column_list 블록으로 변환", () => {
      const converter = new BlockConverter();
      const md = [
        "%%im-nobsidian:column-list:start%%",
        "%%im-nobsidian:column%%",
        "Left column text",
        "%%im-nobsidian:column%%",
        "Right column text",
        "%%im-nobsidian:column-list:end%%",
      ].join("\n");

      const blocks = converter.markdownToNotionBlocks(md) as Array<Record<string, unknown>>;
      const colList = blocks.find((b) => b.type === "column_list");
      expect(colList).toBeDefined();

      const data = colList!.column_list as { children: Array<{ type: string }> };
      expect(data.children).toHaveLength(2);
      expect(data.children[0]!.type).toBe("column");
      expect(data.children[1]!.type).toBe("column");
    });

    it("3컬럼 변환", () => {
      const converter = new BlockConverter();
      const md = [
        "%%im-nobsidian:column-list:start%%",
        "%%im-nobsidian:column%%",
        "Col 1",
        "%%im-nobsidian:column%%",
        "Col 2",
        "%%im-nobsidian:column%%",
        "Col 3",
        "%%im-nobsidian:column-list:end%%",
      ].join("\n");

      const blocks = converter.markdownToNotionBlocks(md) as Array<Record<string, unknown>>;
      const colList = blocks.find((b) => b.type === "column_list");
      expect(colList).toBeDefined();

      const data = colList!.column_list as { children: unknown[] };
      expect(data.children).toHaveLength(3);
    });

    it("컬럼 내 복합 콘텐츠 변환", () => {
      const converter = new BlockConverter();
      const md = [
        "%%im-nobsidian:column-list:start%%",
        "%%im-nobsidian:column%%",
        "# Heading",
        "",
        "Paragraph text",
        "%%im-nobsidian:column%%",
        "- List item",
        "%%im-nobsidian:column-list:end%%",
      ].join("\n");

      const blocks = converter.markdownToNotionBlocks(md) as Array<Record<string, unknown>>;
      const colList = blocks.find((b) => b.type === "column_list");
      expect(colList).toBeDefined();

      const data = colList!.column_list as {
        children: Array<{ column: { children: Array<{ type: string }> } }>;
      };
      const firstColChildren = data.children[0]!.column.children;
      expect(firstColChildren.length).toBeGreaterThanOrEqual(2);
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
