import { markdownToBlocks } from "@tryfabric/martian";
import { NotionToMarkdown } from "notion-to-md";
import type { Client } from "@notionhq/client";
import type { BlockObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";

const TRULY_UNSUPPORTED_BLOCK_TYPES = ["unsupported", "template"] as const;

type RichTextItem = { plain_text: string; href?: string | null };

function richTextToPlain(richText: RichTextItem[] | undefined): string {
  if (!richText) return "";
  return richText.map((t) => t.plain_text).join("");
}

function richTextToMarkdown(
  richText:
    | Array<
        RichTextItem & {
          annotations?: Record<string, boolean>;
          type?: string;
          equation?: { expression: string };
        }
      >
    | undefined,
): string {
  if (!richText) return "";
  return richText
    .map((t) => {
      if (t.type === "equation" && t.equation) {
        return `$${t.equation.expression}$`;
      }
      let text = t.plain_text;
      const a = t.annotations;
      if (a?.code) text = `\`${text}\``;
      if (a?.bold) text = `**${text}**`;
      if (a?.italic) text = `*${text}*`;
      if (a?.strikethrough) text = `~~${text}~~`;
      if (t.href) text = `[${text}](${t.href})`;
      return text;
    })
    .join("");
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
          `> [!obsinotion-unsupported] Notion 전용 블록\n> type: ${blockType}, id: ${id}\n> %%obsinotion:unsupported:type=${blockType}&id=${id}%%`,
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
        .map((line: string) => (line ? `  ${line}` : ""))
        .join("\n")
        .trimEnd();
      return `- ${title}\n${indented}`;
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
        parts.push(childMd.trimEnd());
      }

      return parts.join("\n\n---\n\n");
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
      return `> [!database] ${title}\n> %%obsinotion:child-database:id=${b.id}&title=${encodeURIComponent(title)}%%`;
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
      return `%%obsinotion:toc%%`;
    });
  }

  private registerBreadcrumbTransformer(): void {
    if (!this.n2m) return;
    this.n2m.setCustomTransformer("breadcrumb", async () => "");
  }

  private registerLinkPreviewTransformer(): void {
    if (!this.n2m) return;
    this.n2m.setCustomTransformer("link_preview", async (block) => {
      const b = block as unknown as { link_preview: { url: string } };
      const url = b.link_preview?.url ?? "";
      return `[${url}](${url})`;
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
          .map((l: string) => `> ${l}`);
        result += "\n" + lines.join("\n");
      }
      return result;
    });
  }

  markdownToNotionBlocks(markdown: string): unknown[] {
    const blocks = markdownToBlocks(markdown) as Array<Record<string, unknown>>;
    return this.postProcessBlocks(blocks);
  }

  private postProcessBlocks(blocks: Array<Record<string, unknown>>): unknown[] {
    const result: unknown[] = [];

    for (const block of blocks) {
      const converted = this.convertQuoteToCallout(block);
      result.push(converted);
    }

    return result;
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
