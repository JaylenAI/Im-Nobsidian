import { describe, it, expect } from "vitest";
import { NotionBlockBuilder } from "../../src/notion/block-builder.js";

describe("NotionBlockBuilder", () => {
  describe("richText", () => {
    it("기본 텍스트 생성", () => {
      const rt = NotionBlockBuilder.richText("Hello");
      expect(rt).toHaveLength(1);
      expect(rt[0]!.type).toBe("text");
      expect(rt[0]!.text.content).toBe("Hello");
      expect(rt[0]!.annotations.bold).toBe(false);
    });

    it("서식 옵션 적용", () => {
      const rt = NotionBlockBuilder.richText("Bold", { bold: true, color: "red" });
      expect(rt[0]!.annotations.bold).toBe(true);
      expect(rt[0]!.annotations.color).toBe("red");
    });

    it("링크 포함", () => {
      const rt = NotionBlockBuilder.richText("Click", { link: "https://example.com" });
      expect(rt[0]!.text.link).toEqual({ url: "https://example.com" });
    });

    it("잘못된 색상은 default로 대체", () => {
      const rt = NotionBlockBuilder.richText("Text", { color: "rainbow" });
      expect(rt[0]!.annotations.color).toBe("default");
    });
  });

  describe("richTextArray", () => {
    it("혼합 서식 세그먼트 배열 생성", () => {
      const rt = NotionBlockBuilder.richTextArray([
        { content: "Bold", bold: true },
        { content: " normal " },
        { content: "italic", italic: true, link: "https://example.com" },
      ]);
      expect(rt).toHaveLength(3);
      expect(rt[0]!.annotations.bold).toBe(true);
      expect(rt[1]!.text.content).toBe(" normal ");
      expect(rt[2]!.annotations.italic).toBe(true);
      expect(rt[2]!.text.link).toEqual({ url: "https://example.com" });
    });
  });

  describe("richTextEquation", () => {
    it("인라인 수식 생성", () => {
      const rt = NotionBlockBuilder.richTextEquation("E = mc^2");
      expect(rt[0]!.type).toBe("equation");
      expect(rt[0]!.equation.expression).toBe("E = mc^2");
    });
  });

  describe("richTextMentionPage", () => {
    it("페이지 멘션 생성", () => {
      const rt = NotionBlockBuilder.richTextMentionPage("page-123");
      expect(rt[0]!.type).toBe("mention");
      expect((rt[0]! as { mention: { type: string; page: { id: string } } }).mention.page.id).toBe(
        "page-123",
      );
    });
  });

  describe("richTextMentionDate", () => {
    it("날짜 멘션 생성", () => {
      const rt = NotionBlockBuilder.richTextMentionDate("2026-01-01", "2026-12-31");
      const mention = rt[0]! as {
        mention: { type: string; date: { start: string; end?: string } };
      };
      expect(mention.mention.date.start).toBe("2026-01-01");
      expect(mention.mention.date.end).toBe("2026-12-31");
    });
  });

  describe("paragraph", () => {
    it("문단 블록 생성", () => {
      const block = NotionBlockBuilder.paragraph(NotionBlockBuilder.richText("Hello"));
      expect(block.type).toBe("paragraph");
      expect((block.paragraph as { rich_text: unknown[] }).rich_text).toHaveLength(1);
    });

    it("색상 적용", () => {
      const block = NotionBlockBuilder.paragraph(
        NotionBlockBuilder.richText("Red"),
        "red_background",
      );
      expect((block.paragraph as { color: string }).color).toBe("red_background");
    });
  });

  describe("heading", () => {
    it("레벨별 제목 생성", () => {
      for (const level of [1, 2, 3] as const) {
        const block = NotionBlockBuilder.heading(level, NotionBlockBuilder.richText(`H${level}`));
        expect(block.type).toBe(`heading_${level}`);
      }
    });

    it("토글 제목 생성", () => {
      const children = [NotionBlockBuilder.paragraph(NotionBlockBuilder.richText("Child"))];
      const block = NotionBlockBuilder.heading(2, NotionBlockBuilder.richText("Toggle"), {
        isToggleable: true,
        children,
      });
      const data = block.heading_2 as { is_toggleable: boolean; children: unknown[] };
      expect(data.is_toggleable).toBe(true);
      expect(data.children).toHaveLength(1);
    });
  });

  describe("callout", () => {
    it("콜아웃 블록 생성", () => {
      const block = NotionBlockBuilder.callout(NotionBlockBuilder.richText("Warning!"), "⚠️");
      expect(block.type).toBe("callout");
      const data = block.callout as { icon: { emoji: string }; rich_text: unknown[] };
      expect(data.icon.emoji).toBe("⚠️");
      expect(data.rich_text).toHaveLength(1);
    });

    it("기본 아이콘은 핀", () => {
      const block = NotionBlockBuilder.callout(NotionBlockBuilder.richText("Note"));
      const data = block.callout as { icon: { emoji: string } };
      expect(data.icon.emoji).toBe("\u{1F4CC}");
    });

    it("자식 블록 포함", () => {
      const children = [NotionBlockBuilder.paragraph(NotionBlockBuilder.richText("Detail"))];
      const block = NotionBlockBuilder.callout(NotionBlockBuilder.richText("Title"), "\u{1F4A1}", {
        children,
      });
      const data = block.callout as { children: unknown[] };
      expect(data.children).toHaveLength(1);
    });
  });

  describe("toggle", () => {
    it("토글 블록 생성", () => {
      const children = [NotionBlockBuilder.paragraph(NotionBlockBuilder.richText("Hidden"))];
      const block = NotionBlockBuilder.toggle(NotionBlockBuilder.richText("Click me"), children);
      expect(block.type).toBe("toggle");
      const data = block.toggle as { children: unknown[] };
      expect(data.children).toHaveLength(1);
    });
  });

  describe("list items", () => {
    it("불릿 리스트 생성", () => {
      const block = NotionBlockBuilder.bulletedListItem(NotionBlockBuilder.richText("Item"));
      expect(block.type).toBe("bulleted_list_item");
    });

    it("번호 리스트 생성", () => {
      const block = NotionBlockBuilder.numberedListItem(NotionBlockBuilder.richText("Item"));
      expect(block.type).toBe("numbered_list_item");
    });

    it("체크박스 생성", () => {
      const block = NotionBlockBuilder.toDo(NotionBlockBuilder.richText("Task"), true);
      expect(block.type).toBe("to_do");
      const data = block.to_do as { checked: boolean };
      expect(data.checked).toBe(true);
    });
  });

  describe("quote", () => {
    it("인용 블록 생성", () => {
      const block = NotionBlockBuilder.quote(NotionBlockBuilder.richText("Quote text"));
      expect(block.type).toBe("quote");
    });
  });

  describe("divider", () => {
    it("구분선 블록 생성", () => {
      const block = NotionBlockBuilder.divider();
      expect(block.type).toBe("divider");
      expect(block.divider).toEqual({});
    });
  });

  describe("code", () => {
    it("코드 블록 생성", () => {
      const block = NotionBlockBuilder.code("const x = 1;", "typescript");
      expect(block.type).toBe("code");
      const data = block.code as { language: string; rich_text: unknown[] };
      expect(data.language).toBe("typescript");
    });

    it("캡션 포함", () => {
      const block = NotionBlockBuilder.code("print(1)", "python", "example");
      const data = block.code as { caption: unknown[] };
      expect(data.caption).toBeDefined();
    });
  });

  describe("equationBlock", () => {
    it("수식 블록 생성", () => {
      const block = NotionBlockBuilder.equationBlock("\\sum_{i=1}^{n} i");
      expect(block.type).toBe("equation");
      expect((block.equation as { expression: string }).expression).toBe("\\sum_{i=1}^{n} i");
    });
  });

  describe("media blocks", () => {
    it("이미지 블록 생성", () => {
      const block = NotionBlockBuilder.image("https://example.com/img.png", "Screenshot");
      expect(block.type).toBe("image");
      const data = block.image as { type: string; external: { url: string }; caption: unknown[] };
      expect(data.type).toBe("external");
      expect(data.external.url).toBe("https://example.com/img.png");
      expect(data.caption).toBeDefined();
    });

    it("북마크 블록 생성", () => {
      const block = NotionBlockBuilder.bookmark("https://github.com");
      expect(block.type).toBe("bookmark");
      expect((block.bookmark as { url: string }).url).toBe("https://github.com");
    });

    it("비디오 블록 생성", () => {
      const block = NotionBlockBuilder.video("https://youtube.com/watch?v=abc");
      expect(block.type).toBe("video");
      const data = block.video as { type: string; external: { url: string } };
      expect(data.external.url).toBe("https://youtube.com/watch?v=abc");
    });

    it("오디오 블록 생성", () => {
      const block = NotionBlockBuilder.audio("https://example.com/audio.mp3");
      expect(block.type).toBe("audio");
    });

    it("파일 블록 생성", () => {
      const block = NotionBlockBuilder.fileBlock("https://example.com/doc.pdf", "document.pdf");
      expect(block.type).toBe("file");
      const data = block.file as { name: string };
      expect(data.name).toBe("document.pdf");
    });

    it("PDF 블록 생성", () => {
      const block = NotionBlockBuilder.pdf("https://example.com/doc.pdf");
      expect(block.type).toBe("pdf");
    });

    it("임베드 블록 생성", () => {
      const block = NotionBlockBuilder.embed("https://figma.com/design/abc");
      expect(block.type).toBe("embed");
      expect((block.embed as { url: string }).url).toBe("https://figma.com/design/abc");
    });
  });

  describe("advanced blocks", () => {
    it("목차 블록 생성", () => {
      const block = NotionBlockBuilder.tableOfContents("blue");
      expect(block.type).toBe("table_of_contents");
      expect((block.table_of_contents as { color: string }).color).toBe("blue");
    });

    it("브레드크럼 블록 생성", () => {
      const block = NotionBlockBuilder.breadcrumb();
      expect(block.type).toBe("breadcrumb");
    });

    it("컬럼 리스트 블록 생성", () => {
      const col1 = [NotionBlockBuilder.paragraph(NotionBlockBuilder.richText("Left"))];
      const col2 = [NotionBlockBuilder.paragraph(NotionBlockBuilder.richText("Right"))];
      const block = NotionBlockBuilder.columnList([col1, col2]);
      expect(block.type).toBe("column_list");
      const data = block.column_list as { children: unknown[] };
      expect(data.children).toHaveLength(2);
    });

    it("동기 블록 (원본) 생성", () => {
      const children = [NotionBlockBuilder.paragraph(NotionBlockBuilder.richText("Synced"))];
      const block = NotionBlockBuilder.syncedBlockOriginal(children);
      expect(block.type).toBe("synced_block");
      expect((block.synced_block as { synced_from: unknown }).synced_from).toBeNull();
    });

    it("동기 블록 (복제) 생성", () => {
      const block = NotionBlockBuilder.syncedBlockDuplicate("block-123");
      const data = block.synced_block as { synced_from: { block_id: string } };
      expect(data.synced_from.block_id).toBe("block-123");
    });

    it("페이지 링크 블록 생성", () => {
      const block = NotionBlockBuilder.linkToPage("page-456");
      expect(block.type).toBe("link_to_page");
      expect((block.link_to_page as { page_id: string }).page_id).toBe("page-456");
    });

    it("테이블 블록 생성", () => {
      const block = NotionBlockBuilder.table(
        [
          ["Name", "Age"],
          ["Alice", "30"],
          ["Bob", "25"],
        ],
        true,
        false,
      );
      expect(block.type).toBe("table");
      const data = block.table as {
        table_width: number;
        has_column_header: boolean;
        children: unknown[];
      };
      expect(data.table_width).toBe(2);
      expect(data.has_column_header).toBe(true);
      expect(data.children).toHaveLength(3);
    });

    it("빈 테이블은 기본 2칸", () => {
      const block = NotionBlockBuilder.table([]);
      const data = block.table as { table_width: number; children: unknown[] };
      expect(data.table_width).toBe(2);
      expect(data.children).toHaveLength(1);
    });
  });
});
