import { markdownToBlocks } from "@tryfabric/martian";
import { NotionToMarkdown } from "notion-to-md";
import type { Client } from "@notionhq/client";

const UNSUPPORTED_BLOCK_TYPES = [
  "unsupported",
  "table_of_contents",
  "breadcrumb",
  "link_preview",
  "link_to_page",
  "child_database",
  "template",
  "synced_block",
  "column_list",
  "column",
] as const;

export class BlockConverter {
  private n2m: NotionToMarkdown | null = null;

  initNotionToMd(client: Client): void {
    this.n2m = new NotionToMarkdown({ notionClient: client });
    this.registerUnsupportedTransformers();
  }

  private registerUnsupportedTransformers(): void {
    if (!this.n2m) return;
    for (const blockType of UNSUPPORTED_BLOCK_TYPES) {
      this.n2m.setCustomTransformer(blockType, (block) => {
        const id = block.id ?? "unknown";
        return Promise.resolve(
          `> [!obsinotion-unsupported] Notion 전용 블록\n> type: ${blockType}, id: ${id}\n> %%obsinotion:unsupported:type=${blockType}&id=${id}%%`,
        );
      });
    }
  }

  markdownToNotionBlocks(markdown: string): unknown[] {
    return markdownToBlocks(markdown);
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
