import { anchorBlockOf, anchorOfBlock } from "../converter/anchor-links.js";
import type { NotionClient } from "../notion/client.js";
import { compactNotionId } from "../utils/id.js";

/**
 * 블록 링크가 가리키는 블록을 읽어 그 앵커(제목 글자 · `^블록id`)를 낸다 — 키는 줄인 블록 id. 앵커가 없는 블록 · 읽지
 * 못한 블록(휴지통 · 권한 밖)은 빠진다 — 그 링크는 Notion 링크로 남는다.
 */
export async function readBlockAnchors(
  client: Pick<NotionClient, "getBlock">,
  blockIds: readonly string[],
): Promise<Map<string, string>> {
  const anchors = new Map<string, string>();
  for (const id of new Set(blockIds.map(compactNotionId))) {
    try {
      const anchor = anchorOfBlock(anchorBlockOf(await client.getBlock(id)));
      if (anchor) anchors.set(id, anchor);
    } catch {
      // 읽지 못한 블록 — 링크를 그대로 둔다.
    }
  }
  return anchors;
}
