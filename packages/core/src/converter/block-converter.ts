import { markdownToBlocks } from "@tryfabric/martian";
import { NotionToMarkdown } from "notion-to-md";
import type { Client } from "@notionhq/client";
import type { BlockObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import { NotionBlockBuilder } from "../notion/block-builder.js";
import type { NotionBlock } from "../notion/block-builder.js";
import { richTextToPlain, richTextToMarkdown } from "./rich-text-converter.js";
import type { RichTextItem } from "./rich-text-converter.js";
import {
  MARKER_BRAND,
  compactMarker,
  TOGGLE_START,
  TOGGLE_END,
  COLUMN_LIST_START,
  COLUMN_SEP,
  COLUMN_LIST_END,
  TOC_MARKER,
  BREADCRUMB_MARKER,
} from "../constants/markers.js";

const TRULY_UNSUPPORTED_BLOCK_TYPES = ["unsupported", "template"] as const;

const DIVIDER_PLACEHOLDER = "​%%IM-NOBSIDIAN_DIVIDER%%​";

const VIDEO_URL_PATTERNS = [
  /^https?:\/\/(www\.)?youtube\.com\/watch/,
  /^https?:\/\/youtu\.be\//,
  /^https?:\/\/(www\.)?vimeo\.com\//,
  /^https?:\/\/(www\.)?dailymotion\.com\//,
  /^https?:\/\/(www\.)?loom\.com\/share\//,
];

const EMBED_URL_PATTERNS = [
  /^https?:\/\/(www\.)?figma\.com\//,
  /^https?:\/\/docs\.google\.com\//,
  /^https?:\/\/drive\.google\.com\//,
  /^https?:\/\/(www\.)?miro\.com\//,
  /^https?:\/\/(www\.)?twitter\.com\//,
  /^https?:\/\/(www\.)?x\.com\//,
  /^https?:\/\/codepen\.io\//,
  /^https?:\/\/gist\.github\.com\//,
  /^https?:\/\/(www\.)?spotify\.com\//,
  /^https?:\/\/(www\.)?soundcloud\.com\//,
];

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class BlockConverter {
  private n2m: NotionToMarkdown | null = null;
  private client: Client | null = null;

  initNotionToMd(client: Client): void {
    this.client = client;
    this.n2m = new NotionToMarkdown({ notionClient: client });
    this.registerCustomTransformers();
  }

  private registerCustomTransformers(): void {
    if (!this.n2m) return;

    for (const blockType of TRULY_UNSUPPORTED_BLOCK_TYPES) {
      this.n2m.setCustomTransformer(blockType, (block) => {
        const id = block.id ?? "unknown";
        return Promise.resolve(
          `> [!${MARKER_BRAND}-unsupported] Notion 전용 블록\n> type: ${blockType}, id: ${id}\n> ${compactMarker(`unsupported:type=${blockType}&id=${id}`)}`,
        );
      });
    }

    this.registerToggleTransformer();
    this.registerColumnTransformer();
    this.registerSyncedBlockTransformer();
    this.registerBookmarkTransformer();
    this.registerVideoTransformer();
    this.registerAudioTransformer();
    this.registerFileTransformer();
    this.registerChildPageTransformer();
    this.registerChildDatabaseTransformer();
    this.registerLinkToPageTransformer();
    this.registerTocTransformer();
    this.registerBreadcrumbTransformer();
    this.registerLinkPreviewTransformer();
    this.registerPdfTransformer();
    this.registerEmbedTransformer();
    this.registerCalloutTransformer();
    this.registerToggleHeadingTransformers();
  }

  private registerToggleTransformer(): void {
    if (!this.n2m) return;
    const n2m = this.n2m;
    this.n2m.setCustomTransformer("toggle", async (block) => {
      const b = block as unknown as { toggle: { rich_text: RichTextItem[] } } & BlockObjectResponse;
      const title = richTextToMarkdown(b.toggle?.rich_text as never);
      const children = b.has_children ? await n2m.pageToMarkdown(b.id) : [];
      const childMd = (Array.isArray(children) ? n2m.toMarkdownString(children).parent : "") ?? "";
      const indented = childMd
        .split("\n")
        .map((line: string) => (line.trim() ? `  ${line}` : "  "))
        .join("\n")
        .trimEnd();
      return `${TOGGLE_START}\n- ${title}\n${indented}\n${TOGGLE_END}`;
    });
  }

  private registerToggleHeadingTransformers(): void {
    if (!this.n2m) return;
    const n2m = this.n2m;

    for (const level of [1, 2, 3] as const) {
      const headingKey = `heading_${level}` as const;
      this.n2m.setCustomTransformer(headingKey, async (block) => {
        const b = block as unknown as {
          [K in typeof headingKey]: { rich_text: RichTextItem[]; is_toggleable?: boolean };
        } & BlockObjectResponse;
        const headingData = b[headingKey];
        const text = richTextToMarkdown(headingData?.rich_text as never);
        const prefix = "#".repeat(level);

        if (headingData?.is_toggleable && b.has_children) {
          const children = await n2m.pageToMarkdown(b.id);
          const childMd =
            (Array.isArray(children) ? n2m.toMarkdownString(children).parent : "") ?? "";
          return `${prefix} ${text}\n\n${childMd.trimEnd()}`;
        }

        return `${prefix} ${text}`;
      });
    }
  }

  private registerColumnTransformer(): void {
    if (!this.n2m) return;
    const n2m = this.n2m;
    const client = this.client!;

    this.n2m.setCustomTransformer("column_list", async (block) => {
      const b = block as BlockObjectResponse;
      const response = await client.blocks.children.list({ block_id: b.id });
      const columns = response.results as BlockObjectResponse[];
      const parts: string[] = [];

      for (let i = 0; i < columns.length; i++) {
        const col = columns[i]!;
        const children = await n2m.pageToMarkdown(col.id);
        const childMd =
          (Array.isArray(children) ? n2m.toMarkdownString(children).parent : "") ?? "";
        parts.push(`${COLUMN_SEP}\n${childMd.trimEnd()}`);
      }

      return `${COLUMN_LIST_START}\n${parts.join("\n")}\n${COLUMN_LIST_END}`;
    });

    this.n2m.setCustomTransformer("column", async () => "");
  }

  private registerSyncedBlockTransformer(): void {
    if (!this.n2m) return;
    const n2m = this.n2m;
    const client = this.client!;

    this.n2m.setCustomTransformer("synced_block", async (block) => {
      const b = block as unknown as {
        synced_block: { synced_from: { block_id: string } | null };
      } & BlockObjectResponse;

      const sourceId = b.synced_block?.synced_from?.block_id ?? b.id;

      const response = await client.blocks.children.list({ block_id: sourceId });
      const mdBlocks: unknown[] = [];
      for (const child of response.results as BlockObjectResponse[]) {
        const result = await n2m.blockToMarkdown(child as never);
        if (result) mdBlocks.push(result);
      }
      const childMd = n2m.toMarkdownString(mdBlocks as never).parent ?? "";
      return childMd.trimEnd();
    });
  }

  private registerBookmarkTransformer(): void {
    if (!this.n2m) return;
    this.n2m.setCustomTransformer("bookmark", async (block) => {
      const b = block as unknown as {
        bookmark: { url: string; caption?: RichTextItem[] };
      };
      const url = b.bookmark?.url ?? "";
      const caption = richTextToPlain(b.bookmark?.caption);
      if (caption) {
        return `[${caption}](${url})`;
      }
      return `[${url}](${url})`;
    });
  }

  private registerVideoTransformer(): void {
    if (!this.n2m) return;
    this.n2m.setCustomTransformer("video", async (block) => {
      const b = block as unknown as {
        video: {
          type: string;
          external?: { url: string };
          file?: { url: string };
          caption?: RichTextItem[];
        };
      };
      const url = b.video?.type === "external" ? b.video.external?.url : b.video?.file?.url;
      const caption = richTextToPlain(b.video?.caption);
      return `![${caption || "video"}](${url ?? ""})`;
    });
  }

  private registerAudioTransformer(): void {
    if (!this.n2m) return;
    this.n2m.setCustomTransformer("audio", async (block) => {
      const b = block as unknown as {
        audio: {
          type: string;
          external?: { url: string };
          file?: { url: string };
          caption?: RichTextItem[];
        };
      };
      const url = b.audio?.type === "external" ? b.audio.external?.url : b.audio?.file?.url;
      const caption = richTextToPlain(b.audio?.caption);
      return `![${caption || "audio"}](${url ?? ""})`;
    });
  }

  private registerFileTransformer(): void {
    if (!this.n2m) return;
    this.n2m.setCustomTransformer("file", async (block) => {
      const b = block as unknown as {
        file: {
          type: string;
          external?: { url: string };
          file?: { url: string };
          caption?: RichTextItem[];
          name?: string;
        };
      };
      const url = b.file?.type === "external" ? b.file.external?.url : b.file?.file?.url;
      const name = b.file?.name ?? richTextToPlain(b.file?.caption) ?? "file";
      return `[${name}](${url ?? ""})`;
    });
  }

  private registerChildPageTransformer(): void {
    if (!this.n2m) return;
    this.n2m.setCustomTransformer("child_page", async (block) => {
      const b = block as unknown as { child_page: { title: string } };
      const title = b.child_page?.title ?? "Untitled";
      return `[[${title}]]`;
    });
  }

  private registerChildDatabaseTransformer(): void {
    if (!this.n2m) return;
    this.n2m.setCustomTransformer("child_database", async (block) => {
      const b = block as unknown as {
        child_database: { title: string };
      } & BlockObjectResponse;
      const title = b.child_database?.title ?? "Database";
      return `> [!database] ${title}\n> ${compactMarker(`child-database:id=${b.id}&title=${encodeURIComponent(title)}`)}`;
    });
  }

  private registerLinkToPageTransformer(): void {
    if (!this.n2m) return;
    const client = this.client!;
    this.n2m.setCustomTransformer("link_to_page", async (block) => {
      const b = block as unknown as {
        link_to_page: { type: string; page_id?: string; database_id?: string };
      };
      const pageId = b.link_to_page?.page_id ?? b.link_to_page?.database_id;
      if (!pageId) return "";
      try {
        const page = await client.pages.retrieve({ page_id: pageId });
        const p = page as {
          properties: Record<string, { type: string; title?: Array<{ plain_text: string }> }>;
        };
        for (const prop of Object.values(p.properties)) {
          if (prop.type === "title" && prop.title?.[0]?.plain_text) {
            return `[[${prop.title[0].plain_text}]]`;
          }
        }
      } catch {
        // fallback
      }
      return `[[${pageId}]]`;
    });
  }

  private registerTocTransformer(): void {
    if (!this.n2m) return;
    this.n2m.setCustomTransformer("table_of_contents", async () => {
      return TOC_MARKER;
    });
  }

  private registerBreadcrumbTransformer(): void {
    if (!this.n2m) return;
    // breadcrumb 은 마크다운 표현이 없다. 빈 문자열로 버리면 라운드트립에서 소실되므로
    // 보존 마커를 남겨 push 시 breadcrumb 블록으로 복원한다(convertSingleLineMarker).
    this.n2m.setCustomTransformer("breadcrumb", async () => BREADCRUMB_MARKER);
  }

  private registerLinkPreviewTransformer(): void {
    if (!this.n2m) return;
    this.n2m.setCustomTransformer("link_preview", async (block) => {
      const b = block as unknown as { link_preview: { url: string } };
      const url = b.link_preview?.url ?? "";
      return `[${url}](${url})`;
    });
  }

  private registerPdfTransformer(): void {
    if (!this.n2m) return;
    this.n2m.setCustomTransformer("pdf", async (block) => {
      const b = block as unknown as {
        pdf: {
          type: string;
          file?: { url: string };
          external?: { url: string };
          caption?: RichTextItem[];
        };
      };
      const url = b.pdf?.type === "file" ? (b.pdf.file?.url ?? "") : (b.pdf?.external?.url ?? "");
      const caption = b.pdf?.caption ? richTextToMarkdown(b.pdf.caption as never) : "";
      return `[📄 ${caption || "PDF"}](${url})`;
    });
  }

  private registerEmbedTransformer(): void {
    if (!this.n2m) return;
    this.n2m.setCustomTransformer("embed", async (block) => {
      const b = block as unknown as {
        embed: { url: string; caption?: RichTextItem[] };
      };
      const url = b.embed?.url ?? "";
      const caption = b.embed?.caption ? richTextToMarkdown(b.embed.caption as never) : "";
      return `[${caption || url}](${url})`;
    });
  }

  private registerCalloutTransformer(): void {
    if (!this.n2m) return;
    const n2m = this.n2m;
    this.n2m.setCustomTransformer("callout", async (block) => {
      const b = block as unknown as {
        callout: { rich_text: RichTextItem[]; icon?: { type: string; emoji?: string } };
      } & BlockObjectResponse;
      const text = richTextToMarkdown(b.callout?.rich_text as never);
      const emoji = b.callout?.icon?.emoji ?? "";

      const children = b.has_children ? await n2m.pageToMarkdown(b.id) : [];
      const childMd = (Array.isArray(children) ? n2m.toMarkdownString(children).parent : "") ?? "";

      const EMOJI_TO_TYPE: Record<string, string> = {
        "\u{1F4DD}": "note",
        "\u{1F4CB}": "abstract",
        "\u{2139}\u{FE0F}": "info",
        "\u{1F4A1}": "tip",
        "\u{2705}": "success",
        "\u{2753}": "question",
        "\u{26A0}\u{FE0F}": "warning",
        "\u{274C}": "failure",
        "\u{1F525}": "danger",
        "\u{1F41B}": "bug",
        "\u{1F4CC}": "example",
        "\u{1F4AC}": "quote",
      };
      const calloutType = EMOJI_TO_TYPE[emoji] ?? "note";

      let result = `> [!${calloutType}] ${text}`;
      if (childMd?.trim()) {
        const lines = childMd
          .trim()
          .split("\n")
          .map((l: string) => (l.trim() ? `> ${l}` : ">"));
        result += "\n" + lines.join("\n");
      }
      return result;
    });
  }

  markdownToNotionBlocks(markdown: string): unknown[] {
    const preprocessed = this.preProcessMarkdown(markdown);
    const blocks = markdownToBlocks(preprocessed) as Array<Record<string, unknown>>;
    const processed = this.postProcessBlocks(blocks);
    return normalizeBlocksForNotion(processed as Array<Record<string, unknown>>);
  }

  private toggleContents: Map<number, string> = new Map();
  private columnContents: Map<number, string[]> = new Map();
  private toggleCounter = 0;
  private columnCounter = 0;

  private preProcessMarkdown(markdown: string): string {
    this.toggleContents.clear();
    this.columnContents.clear();
    this.toggleCounter = 0;
    this.columnCounter = 0;

    let processed = this.extractToggleBlocks(markdown);
    processed = this.extractColumnBlocks(processed);
    processed = this.replaceDividers(processed);
    processed = processed.replace(/<unknown[^>]*\/>/g, "");
    processed = this.stripInlineAnnotationMarkers(processed);
    return processed;
  }

  /**
   * compact underline/color 보존마커를 평문으로 강등 — block(martian) 폴백 경로 전용.
   *
   * 무손실 underline/color 복원은 기본 경로인 Markdown API({@link obsidianToNotionEnhanced})가
   * 전담한다. martian 은 이 서식을 표현할 수 없으므로, Markdown API 가 실패해 이 폴백을 탈 때는
   * 마커 텍스트가 본문에 리터럴로 새지 않도록 텍스트만 남기고 마커를 제거한다(서식 degrade).
   */
  private stripInlineAnnotationMarkers(markdown: string): string {
    return markdown
      .replace(new RegExp(`%%${MARKER_BRAND}:underline%%([\\s\\S]*?)%%\\/underline%%`, "g"), "$1")
      .replace(new RegExp(`%%${MARKER_BRAND}:color:[^%]+%%([\\s\\S]*?)%%\\/color%%`, "g"), "$1");
  }

  private replaceDividers(markdown: string): string {
    const lines = markdown.split("\n");
    const result: string[] = [];
    let inCodeBlock = false;

    for (const line of lines) {
      if (line.trimStart().startsWith("```")) {
        inCodeBlock = !inCodeBlock;
      }

      if (!inCodeBlock && /^---\s*$/.test(line.trim())) {
        result.push(DIVIDER_PLACEHOLDER);
      } else {
        result.push(line);
      }
    }

    return result.join("\n");
  }

  private extractToggleBlocks(markdown: string): string {
    const startRe = new RegExp(`^${escapeRegex(TOGGLE_START)}$`, "gm");
    const endRe = new RegExp(`^${escapeRegex(TOGGLE_END)}$`, "gm");
    let result = markdown;
    let match: RegExpExecArray | null;

    while ((match = startRe.exec(result)) !== null) {
      endRe.lastIndex = match.index;
      const endMatch = endRe.exec(result);
      if (!endMatch) break;

      const content = result.slice(match.index + match[0].length + 1, endMatch.index).trimEnd();
      const id = this.toggleCounter++;
      this.toggleContents.set(id, content);

      const placeholder = `%%IM-NOBSIDIAN_TOGGLE_${id}%%`;
      result =
        result.slice(0, match.index) +
        placeholder +
        result.slice(endMatch.index + endMatch[0].length);

      startRe.lastIndex = match.index + placeholder.length;
    }

    return result;
  }

  private extractColumnBlocks(markdown: string): string {
    const startRe = new RegExp(`^${escapeRegex(COLUMN_LIST_START)}$`, "gm");
    const endRe = new RegExp(`^${escapeRegex(COLUMN_LIST_END)}$`, "gm");
    let result = markdown;
    let match: RegExpExecArray | null;

    while ((match = startRe.exec(result)) !== null) {
      endRe.lastIndex = match.index;
      const endMatch = endRe.exec(result);
      if (!endMatch) break;

      const inner = result.slice(match.index + match[0].length + 1, endMatch.index);
      const columns = inner
        .split(new RegExp(`^${escapeRegex(COLUMN_SEP)}$`, "m"))
        .map((c) => c.trim())
        .filter(Boolean);

      const id = this.columnCounter++;
      this.columnContents.set(id, columns);

      const placeholder = `%%IM-NOBSIDIAN_COLLIST_${id}%%`;
      result =
        result.slice(0, match.index) +
        placeholder +
        result.slice(endMatch.index + endMatch[0].length);

      startRe.lastIndex = match.index + placeholder.length;
    }

    return result;
  }

  private postProcessBlocks(blocks: Array<Record<string, unknown>>): unknown[] {
    const result: unknown[] = [];

    for (const block of blocks) {
      const toggleConverted = this.convertTogglePlaceholder(block);
      if (toggleConverted) {
        result.push(toggleConverted);
        continue;
      }

      const columnConverted = this.convertColumnPlaceholder(block);
      if (columnConverted) {
        result.push(columnConverted);
        continue;
      }

      const dividerConverted = this.convertDividerPlaceholder(block);
      if (dividerConverted) {
        result.push(dividerConverted);
        continue;
      }

      const markerConverted = this.convertSingleLineMarker(block);
      if (markerConverted) {
        result.push(markerConverted);
        continue;
      }

      const videoConverted = this.convertImageToVideoOrEmbed(block);
      if (videoConverted) {
        result.push(videoConverted);
        continue;
      }

      const calloutConverted = this.convertQuoteToCallout(block);
      result.push(calloutConverted);
    }

    return result;
  }

  private convertTogglePlaceholder(block: Record<string, unknown>): unknown | null {
    if (block.type !== "paragraph") return null;

    const para = block.paragraph as
      | { rich_text?: Array<{ text?: { content: string } }> }
      | undefined;
    const text = para?.rich_text?.[0]?.text?.content ?? "";

    const toggleMatch = text.match(/%%IM-NOBSIDIAN_TOGGLE_(\d+)%%/);
    if (!toggleMatch) return null;

    const id = parseInt(toggleMatch[1]!, 10);
    const content = this.toggleContents.get(id);
    if (content === undefined) return null;

    const titleMatch = content.match(/^- (.+)$/m);
    const title = titleMatch?.[1] ?? "Toggle";

    const childLines = content.split("\n").slice(1);
    const childMd = childLines
      .map((l) => (l.startsWith("  ") ? l.slice(2) : l))
      .join("\n")
      .trim();

    const children = childMd ? (markdownToBlocks(childMd) as Array<Record<string, unknown>>) : [];

    return NotionBlockBuilder.toggle(
      NotionBlockBuilder.richText(title),
      children.length > 0 ? (children as unknown as NotionBlock[]) : undefined,
    );
  }

  private convertColumnPlaceholder(block: Record<string, unknown>): unknown | null {
    if (block.type !== "paragraph") return null;

    const para = block.paragraph as
      | { rich_text?: Array<{ text?: { content: string } }> }
      | undefined;
    const text = para?.rich_text?.[0]?.text?.content ?? "";

    const colMatch = text.match(/%%IM-NOBSIDIAN_COLLIST_(\d+)%%/);
    if (!colMatch) return null;

    const id = parseInt(colMatch[1]!, 10);
    const columns = this.columnContents.get(id);
    if (!columns) return null;

    const columnBlocks = columns.map((colMd) => {
      const blocks = markdownToBlocks(colMd) as Array<Record<string, unknown>>;
      return this.postProcessBlocks(blocks) as unknown as NotionBlock[];
    });

    return NotionBlockBuilder.columnList(columnBlocks);
  }

  private convertDividerPlaceholder(block: Record<string, unknown>): unknown | null {
    if (block.type !== "paragraph") return null;

    const para = block.paragraph as
      | { rich_text?: Array<{ text?: { content: string } }> }
      | undefined;
    const text = para?.rich_text?.[0]?.text?.content ?? "";

    if (text.includes("%%IM-NOBSIDIAN_DIVIDER%%")) {
      return NotionBlockBuilder.divider();
    }
    return null;
  }

  /**
   * 단일 라인 보존 마커(목차·breadcrumb)를 원래 블록으로 복원한다.
   * pull 시 마크다운 표현이 없는 블록을 `%%im-nobsidian:toc%%` /
   * `%%im-nobsidian:breadcrumb%%` 마커 문단으로 남겨두므로, push 시 이 문단을
   * 감지해 table_of_contents / breadcrumb 블록으로 되돌린다. 그러지 않으면
   * 마커 텍스트가 일반 문단으로 Notion 에 기록되는 잠재 손실이 된다.
   */
  private convertSingleLineMarker(block: Record<string, unknown>): unknown | null {
    if (block.type !== "paragraph") return null;

    const para = block.paragraph as
      | { rich_text?: Array<{ text?: { content: string } }> }
      | undefined;
    const texts = para?.rich_text ?? [];
    if (texts.length !== 1) return null;

    const text = (texts[0]?.text?.content ?? "").trim();
    if (text === TOC_MARKER) {
      return NotionBlockBuilder.tableOfContents();
    }
    if (text === BREADCRUMB_MARKER) {
      return NotionBlockBuilder.breadcrumb();
    }
    return null;
  }

  private convertImageToVideoOrEmbed(block: Record<string, unknown>): unknown | null {
    let url = "";
    let caption: string | undefined;

    if (block.type === "image") {
      const img = block.image as
        | { external?: { url: string }; caption?: Array<{ text?: { content: string } }> }
        | undefined;
      url = img?.external?.url ?? "";
      caption = img?.caption?.[0]?.text?.content;
    } else if (block.type === "paragraph") {
      const para = block.paragraph as
        | { rich_text?: Array<{ text?: { content: string } }> }
        | undefined;
      const texts = para?.rich_text ?? [];
      if (texts.length === 1) {
        const content = texts[0]?.text?.content ?? "";
        if (/^https?:\/\//.test(content)) {
          url = content;
        }
      }
    }

    if (!url) return null;

    if (VIDEO_URL_PATTERNS.some((p) => p.test(url))) {
      return NotionBlockBuilder.video(url, caption);
    }

    if (EMBED_URL_PATTERNS.some((p) => p.test(url))) {
      return NotionBlockBuilder.embed(url, caption);
    }

    return null;
  }

  private convertQuoteToCallout(block: Record<string, unknown>): unknown {
    if (block.type !== "quote") return block;

    const quote = block.quote as
      | {
          rich_text: Array<{
            type: string;
            text?: { content: string; link?: unknown };
            annotations?: Record<string, boolean>;
          }>;
          children?: Array<Record<string, unknown>>;
        }
      | undefined;
    if (!quote?.rich_text?.[0]) return block;

    const firstText = quote.rich_text[0]?.text?.content ?? "";

    const KNOWN_CALLOUT_EMOJIS = [
      "\u{1F4DD}",
      "\u{1F4CB}",
      "\u{2139}\u{FE0F}",
      "\u{1F4A1}",
      "\u{2705}",
      "\u{2753}",
      "\u{26A0}\u{FE0F}",
      "\u{274C}",
      "\u{1F525}",
      "\u{1F41B}",
      "\u{1F4CC}",
      "\u{1F4AC}",
    ];
    const matchedEmoji = KNOWN_CALLOUT_EMOJIS.find((e) => firstText.startsWith(e));
    if (!matchedEmoji) return block;

    const emoji = matchedEmoji;
    const remainingText = firstText.slice(emoji.length).replace(/^\s+/, "");

    const newRichText = [...quote.rich_text];
    if (remainingText) {
      newRichText[0] = {
        ...newRichText[0]!,
        text: { content: remainingText, link: null },
      };
    } else {
      newRichText.shift();
    }

    return {
      type: "callout",
      callout: {
        rich_text: newRichText,
        icon: { type: "emoji", emoji },
        children: quote.children ?? [],
      },
    };
  }

  async notionBlocksToMarkdown(pageId: string): Promise<string> {
    if (!this.n2m) {
      throw new Error(
        "NotionToMarkdown이 초기화되지 않았습니다. initNotionToMd()를 먼저 호출하세요.",
      );
    }

    const mdBlocks = await this.n2m.pageToMarkdown(pageId);
    const result = this.n2m.toMarkdownString(mdBlocks);
    return result.parent ?? "";
  }
}

const NOTION_MAX_TABLE_ROWS = 100;
const NOTION_MAX_LIST_DEPTH = 3;

function normalizeBlocksForNotion(
  blocks: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  for (const block of blocks) {
    if (block.type === "table") {
      result.push(...normalizeTable(block));
    } else if (isListBlock(block)) {
      result.push(flattenListDepth(block, 0));
    } else {
      result.push(block);
    }
  }

  return result;
}

function normalizeTable(block: Record<string, unknown>): Array<Record<string, unknown>> {
  const table = block.table as
    | {
        table_width: number;
        has_column_header: boolean;
        has_row_header: boolean;
        children: Array<Record<string, unknown>>;
      }
    | undefined;
  if (!table?.children) return [block];

  const rows = table.children;
  if (rows.length === 0) return [block];

  let maxCells = table.table_width;
  for (const row of rows) {
    const tr = row.table_row as { cells: unknown[][] } | undefined;
    if (tr?.cells && tr.cells.length > maxCells) {
      maxCells = tr.cells.length;
    }
  }

  const normalizedRows = rows.map((row) => {
    const tr = row.table_row as { cells: unknown[][] } | undefined;
    if (!tr?.cells) return row;

    const cells = [...tr.cells];
    while (cells.length < maxCells) {
      cells.push([{ type: "text", text: { content: "" } }]);
    }
    if (cells.length > maxCells) {
      cells.length = maxCells;
    }

    return { ...row, table_row: { ...tr, cells } };
  });

  if (normalizedRows.length <= NOTION_MAX_TABLE_ROWS) {
    return [
      {
        ...block,
        table: { ...table, table_width: maxCells, children: normalizedRows },
      },
    ];
  }

  const tables: Array<Record<string, unknown>> = [];
  const headerRow = table.has_column_header ? normalizedRows[0] : null;
  const dataRows = table.has_column_header ? normalizedRows.slice(1) : normalizedRows;
  const chunkSize = headerRow ? NOTION_MAX_TABLE_ROWS - 1 : NOTION_MAX_TABLE_ROWS;

  for (let i = 0; i < dataRows.length; i += chunkSize) {
    const chunk = dataRows.slice(i, i + chunkSize);
    const children = headerRow ? [headerRow, ...chunk] : chunk;
    tables.push({
      type: "table",
      table: {
        table_width: maxCells,
        has_column_header: !!headerRow,
        has_row_header: table.has_row_header,
        children,
      },
    });
  }

  return tables;
}

function isListBlock(block: Record<string, unknown>): boolean {
  return (
    block.type === "bulleted_list_item" ||
    block.type === "numbered_list_item" ||
    block.type === "to_do"
  );
}

function flattenListDepth(block: Record<string, unknown>, depth: number): Record<string, unknown> {
  const blockType = block.type as string;
  const blockData = block[blockType] as
    | { children?: Array<Record<string, unknown>>; [key: string]: unknown }
    | undefined;
  if (!blockData?.children || blockData.children.length === 0) return block;

  if (depth >= NOTION_MAX_LIST_DEPTH - 1) {
    const flattened = collectAllDescendants(blockData.children);
    return {
      ...block,
      [blockType]: { ...blockData, children: flattened },
    };
  }

  const normalizedChildren = blockData.children.map((child) => {
    if (isListBlock(child)) {
      return flattenListDepth(child, depth + 1);
    }
    return child;
  });

  return {
    ...block,
    [blockType]: { ...blockData, children: normalizedChildren },
  };
}

function collectAllDescendants(
  blocks: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const block of blocks) {
    const blockType = block.type as string;
    const blockData = block[blockType] as
      | { children?: Array<Record<string, unknown>>; [key: string]: unknown }
      | undefined;
    const children = blockData?.children;
    const blockWithoutChildren = children
      ? { ...block, [blockType]: { ...blockData, children: undefined } }
      : block;
    result.push(blockWithoutChildren);
    if (children && children.length > 0) {
      result.push(...collectAllDescendants(children));
    }
  }
  return result;
}
