import { markdownToBlocks } from "@tryfabric/martian";
import { NotionToMarkdown } from "notion-to-md";
import type { Client } from "@notionhq/client";

export class BlockConverter {
  private n2m: NotionToMarkdown | null = null;

  initNotionToMd(client: Client): void {
    this.n2m = new NotionToMarkdown({ notionClient: client });
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
