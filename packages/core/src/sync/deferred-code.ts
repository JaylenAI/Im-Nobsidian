import type { BlockObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import type { NotionClient } from "../notion/client.js";
import type { DeferredCode } from "../types/convert.js";

type DeferredCodeClient = Pick<NotionClient, "fetchAllChildren" | "updateCodeBlockText">;

/**
 * 본문을 쓴 뒤 자리표시로 보낸 코드를 채운다(S-22) — 자리표시를 글로 가진 코드 블록을 찾아 그 글을
 * 코드로 바꾼다. Notion Markdown API 는 코드에 ``` 로 시작하는 줄이 있으면 어떤 펜스로 보내도 그 줄에서
 * 블록을 가른다(`CodeLanguageGuard`).
 *
 * 컨테이너(콜아웃 · 토글 · 목록 · 칼럼) 안까지 찾되, 다 찾으면 더 읽지 않는다. 다른 페이지 · DB 와
 * 다른 곳이 원본인 동기화 블록 · 표 안은 이 페이지가 보낸 코드가 아니어서 들어가지 않는다.
 *
 * @returns 채웠으면 true — 본문이 바뀌었으니 호출측이 지문 · 수정 시각을 다시 받는다.
 * @throws 자리표시를 다 찾지 못했으면. 그 코드는 Notion 에 자리표시 글로 남아 있다 — 항목을 실패로
 *   남겨 다음 push 가 본문을 다시 보내게 한다.
 */
export async function fillDeferredCode(
  client: DeferredCodeClient,
  pageId: string,
  deferred: readonly DeferredCode[],
): Promise<boolean> {
  if (deferred.length === 0) return false;
  const pending = new Map(deferred.map((d) => [d.token, d.code]));

  const visit = async (parentId: string): Promise<void> => {
    for (const block of await client.fetchAllChildren(parentId)) {
      if (pending.size === 0) return;
      if (block.type === "code") {
        const token = block.code.rich_text
          .map((t) => t.plain_text)
          .join("")
          .trim();
        const code = pending.get(token);
        if (code === undefined) continue;
        await client.updateCodeBlockText(block.id, code, block.code.language);
        pending.delete(token);
      } else if (block.has_children && descends(block)) {
        await visit(block.id);
      }
    }
  };
  await visit(pageId);

  if (pending.size > 0) {
    throw new Error(
      `코드 블록 ${pending.size}개를 Notion 에 채우지 못함 — 코드 대신 자리표시 글이 남아 있어 ` +
        "다음 push 가 본문을 다시 보낸다",
    );
  }
  return true;
}

function descends(block: BlockObjectResponse): boolean {
  switch (block.type) {
    case "child_page":
    case "child_database":
    case "table":
      return false;
    case "synced_block":
      return block.synced_block.synced_from === null;
    default:
      return true;
  }
}
