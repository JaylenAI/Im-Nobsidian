const VALID_COLORS = new Set([
  "default",
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
  "gray_background",
  "brown_background",
  "orange_background",
  "yellow_background",
  "green_background",
  "blue_background",
  "purple_background",
  "pink_background",
  "red_background",
]);

type NotionColor = string;

function safeColor(color: string): NotionColor {
  return VALID_COLORS.has(color) ? color : "default";
}

export interface RichTextSegment {
  content: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  code?: boolean;
  color?: string;
  link?: string;
}

export interface NotionRichText {
  type: "text";
  text: { content: string; link?: { url: string } | null };
  annotations: {
    bold: boolean;
    italic: boolean;
    underline: boolean;
    strikethrough: boolean;
    code: boolean;
    color: string;
  };
}

export interface NotionEquationRichText {
  type: "equation";
  equation: { expression: string };
}

export interface NotionMentionRichText {
  type: "mention";
  mention:
    | { type: "page"; page: { id: string } }
    | { type: "date"; date: { start: string; end?: string } }
    | { type: "user"; user: { id: string } }
    | { type: "database"; database: { id: string } };
}

export type RichTextItem = NotionRichText | NotionEquationRichText | NotionMentionRichText;

export interface NotionBlock {
  object?: "block";
  type: string;
  [key: string]: unknown;
}

export class NotionBlockBuilder {
  // ─── Rich Text ──────────────────────────────────────────

  static richText(content: string, options?: Partial<RichTextSegment>): NotionRichText[] {
    const textObj: { content: string; link?: { url: string } | null } = { content };
    if (options?.link) {
      textObj.link = { url: options.link };
    }
    return [
      {
        type: "text",
        text: textObj,
        annotations: {
          bold: options?.bold ?? false,
          italic: options?.italic ?? false,
          underline: options?.underline ?? false,
          strikethrough: options?.strikethrough ?? false,
          code: options?.code ?? false,
          color: safeColor(options?.color ?? "default"),
        },
      },
    ];
  }

  static richTextArray(segments: RichTextSegment[]): NotionRichText[] {
    return segments.map((seg) => {
      const textObj: { content: string; link?: { url: string } | null } = {
        content: seg.content,
      };
      if (seg.link) {
        textObj.link = { url: seg.link };
      }
      return {
        type: "text" as const,
        text: textObj,
        annotations: {
          bold: seg.bold ?? false,
          italic: seg.italic ?? false,
          underline: seg.underline ?? false,
          strikethrough: seg.strikethrough ?? false,
          code: seg.code ?? false,
          color: safeColor(seg.color ?? "default"),
        },
      };
    });
  }

  static richTextEquation(expression: string): NotionEquationRichText[] {
    return [{ type: "equation", equation: { expression } }];
  }

  static richTextMentionPage(pageId: string): NotionMentionRichText[] {
    return [{ type: "mention", mention: { type: "page", page: { id: pageId } } }];
  }

  static richTextMentionDate(start: string, end?: string): NotionMentionRichText[] {
    const date: { start: string; end?: string } = { start };
    if (end) date.end = end;
    return [{ type: "mention", mention: { type: "date", date } }];
  }

  // ─── Basic Blocks ───────────────────────────────────────

  static paragraph(richText: RichTextItem[], color?: string): NotionBlock {
    return {
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: richText, color: safeColor(color ?? "default") },
    };
  }

  static heading(
    level: 1 | 2 | 3,
    richText: RichTextItem[],
    options?: { color?: string; isToggleable?: boolean; children?: NotionBlock[] },
  ): NotionBlock {
    const key = `heading_${level}`;
    const data: Record<string, unknown> = {
      rich_text: richText,
      color: safeColor(options?.color ?? "default"),
      is_toggleable: options?.isToggleable ?? false,
    };
    if (options?.isToggleable && options?.children) {
      data.children = options.children;
    }
    return { object: "block", type: key, [key]: data };
  }

  static callout(
    richText: RichTextItem[],
    icon?: string,
    options?: { color?: string; children?: NotionBlock[] },
  ): NotionBlock {
    const data: Record<string, unknown> = {
      rich_text: richText,
      icon: { type: "emoji", emoji: icon ?? "\u{1F4CC}" },
      color: safeColor(options?.color ?? "default"),
    };
    if (options?.children) {
      data.children = options.children;
    }
    return { object: "block", type: "callout", callout: data };
  }

  static toggle(richText: RichTextItem[], children?: NotionBlock[], color?: string): NotionBlock {
    const data: Record<string, unknown> = {
      rich_text: richText,
      color: safeColor(color ?? "default"),
    };
    if (children) {
      data.children = children;
    }
    return { object: "block", type: "toggle", toggle: data };
  }

  static bulletedListItem(
    richText: RichTextItem[],
    children?: NotionBlock[],
    color?: string,
  ): NotionBlock {
    const data: Record<string, unknown> = {
      rich_text: richText,
      color: safeColor(color ?? "default"),
    };
    if (children) {
      data.children = children;
    }
    return {
      object: "block",
      type: "bulleted_list_item",
      bulleted_list_item: data,
    };
  }

  static numberedListItem(
    richText: RichTextItem[],
    children?: NotionBlock[],
    color?: string,
  ): NotionBlock {
    const data: Record<string, unknown> = {
      rich_text: richText,
      color: safeColor(color ?? "default"),
    };
    if (children) {
      data.children = children;
    }
    return {
      object: "block",
      type: "numbered_list_item",
      numbered_list_item: data,
    };
  }

  static toDo(richText: RichTextItem[], checked?: boolean, color?: string): NotionBlock {
    return {
      object: "block",
      type: "to_do",
      to_do: {
        rich_text: richText,
        checked: checked ?? false,
        color: safeColor(color ?? "default"),
      },
    };
  }

  static quote(richText: RichTextItem[], children?: NotionBlock[], color?: string): NotionBlock {
    const data: Record<string, unknown> = {
      rich_text: richText,
      color: safeColor(color ?? "default"),
    };
    if (children) {
      data.children = children;
    }
    return { object: "block", type: "quote", quote: data };
  }

  static divider(): NotionBlock {
    return { object: "block", type: "divider", divider: {} };
  }

  static code(code: string, language?: string, caption?: string): NotionBlock {
    const data: Record<string, unknown> = {
      rich_text: NotionBlockBuilder.richText(code),
      language: language ?? "plain text",
    };
    if (caption) {
      data.caption = NotionBlockBuilder.richText(caption);
    }
    return { object: "block", type: "code", code: data };
  }

  static equationBlock(expression: string): NotionBlock {
    return {
      object: "block",
      type: "equation",
      equation: { expression },
    };
  }

  // ─── Media Blocks ───────────────────────────────────────

  static image(url: string, caption?: string): NotionBlock {
    const data: Record<string, unknown> = {
      type: "external",
      external: { url },
    };
    if (caption) {
      data.caption = NotionBlockBuilder.richText(caption);
    }
    return { object: "block", type: "image", image: data };
  }

  static bookmark(url: string, caption?: string): NotionBlock {
    const data: Record<string, unknown> = { url };
    if (caption) {
      data.caption = NotionBlockBuilder.richText(caption);
    }
    return { object: "block", type: "bookmark", bookmark: data };
  }

  static video(url: string, caption?: string): NotionBlock {
    const data: Record<string, unknown> = {
      type: "external",
      external: { url },
    };
    if (caption) {
      data.caption = NotionBlockBuilder.richText(caption);
    }
    return { object: "block", type: "video", video: data };
  }

  static audio(url: string, caption?: string): NotionBlock {
    const data: Record<string, unknown> = {
      type: "external",
      external: { url },
    };
    if (caption) {
      data.caption = NotionBlockBuilder.richText(caption);
    }
    return { object: "block", type: "audio", audio: data };
  }

  static fileBlock(url: string, name?: string, caption?: string): NotionBlock {
    const data: Record<string, unknown> = {
      type: "external",
      external: { url },
    };
    if (name) data.name = name;
    if (caption) {
      data.caption = NotionBlockBuilder.richText(caption);
    }
    return { object: "block", type: "file", file: data };
  }

  static pdf(url: string, caption?: string): NotionBlock {
    const data: Record<string, unknown> = {
      type: "external",
      external: { url },
    };
    if (caption) {
      data.caption = NotionBlockBuilder.richText(caption);
    }
    return { object: "block", type: "pdf", pdf: data };
  }

  static embed(url: string, caption?: string): NotionBlock {
    const data: Record<string, unknown> = { url };
    if (caption) {
      data.caption = NotionBlockBuilder.richText(caption);
    }
    return { object: "block", type: "embed", embed: data };
  }

  // ─── Advanced Blocks ────────────────────────────────────

  static tableOfContents(color?: string): NotionBlock {
    return {
      object: "block",
      type: "table_of_contents",
      table_of_contents: { color: safeColor(color ?? "default") },
    };
  }

  static breadcrumb(): NotionBlock {
    return { object: "block", type: "breadcrumb", breadcrumb: {} };
  }

  static columnList(columns: NotionBlock[][]): NotionBlock {
    const children = columns.map((colBlocks) => ({
      object: "block" as const,
      type: "column" as const,
      column: { children: colBlocks },
    }));
    return {
      object: "block",
      type: "column_list",
      column_list: { children },
    };
  }

  static syncedBlockOriginal(children: NotionBlock[]): NotionBlock {
    return {
      object: "block",
      type: "synced_block",
      synced_block: { synced_from: null, children },
    };
  }

  static syncedBlockDuplicate(originalBlockId: string): NotionBlock {
    return {
      object: "block",
      type: "synced_block",
      synced_block: { synced_from: { block_id: originalBlockId } },
    };
  }

  static linkToPage(pageId: string): NotionBlock {
    return {
      object: "block",
      type: "link_to_page",
      link_to_page: { type: "page_id", page_id: pageId },
    };
  }

  static table(rows: string[][], hasColumnHeader?: boolean, hasRowHeader?: boolean): NotionBlock {
    if (rows.length === 0) rows = [["", ""]];
    const width = rows[0]!.length;
    const tableRows = rows.map((row) => {
      const cells = row.map((cell) => NotionBlockBuilder.richText(cell));
      while (cells.length < width) {
        cells.push(NotionBlockBuilder.richText(""));
      }
      return {
        object: "block" as const,
        type: "table_row" as const,
        table_row: { cells },
      };
    });
    return {
      object: "block",
      type: "table",
      table: {
        table_width: width,
        has_column_header: hasColumnHeader ?? true,
        has_row_header: hasRowHeader ?? false,
        children: tableRows,
      },
    };
  }
}
