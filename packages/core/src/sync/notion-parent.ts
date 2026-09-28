import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import type { NotionClient } from "../notion/client.js";

/**
 * 페이지를 품은 페이지 · DB 의 id. 부모가 블록(콜아웃 · 컬럼 등)이면 그 블록을 품은 페이지까지
 * 거슬러 오른다. 오르지 못하면 null.
 */
export async function extractParentId(
  notionClient: NotionClient,
  page: PageObjectResponse,
): Promise<string | null> {
  const parent = page.parent as {
    type: string;
    page_id?: string;
    database_id?: string;
    block_id?: string;
  };
  if (parent.type === "page_id") return parent.page_id ?? null;
  if (parent.type === "database_id") return parent.database_id ?? null;
  if (parent.type === "block_id" && parent.block_id) {
    return resolveBlockToPageId(notionClient, parent.block_id);
  }
  return null;
}

async function resolveBlockToPageId(
  notionClient: NotionClient,
  blockId: string,
): Promise<string | null> {
  for (let i = 0; i < 10; i++) {
    try {
      const block = await notionClient.getBlock(blockId);
      const bp = (
        block as unknown as { parent: { type: string; page_id?: string; block_id?: string } }
      ).parent;
      if (bp.type === "page_id") return bp.page_id ?? null;
      if (bp.type === "block_id" && bp.block_id) {
        blockId = bp.block_id;
        continue;
      }
      return null;
    } catch {
      return null;
    }
  }
  return null;
}
