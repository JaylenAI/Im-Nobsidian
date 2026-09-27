import { baseEmbedPaths, extractChildTags, restoreChildTags } from "../converter/child-tags.js";
import { isNotionValidationError, type NotionClient } from "../notion/client.js";
import { getLogger } from "../utils/logger.js";

type PageBodyClient = Pick<NotionClient, "replacePageMarkdown" | "getPageMarkdown">;

export interface ReplacePageBodyOptions {
  /**
   * 볼트의 `.base` 가 어느 Notion DB 의 것인지(하이픈 유무 무관). 본문의 `.base` 임베드를
   * 자식 DB 와 id 로 맞추는 데 쓴다 — 없으면 제목으로만 맞춘다. 자식 DB 가 있는 페이지를
   * 다시 보낼 때만 부른다.
   */
  readonly databaseIdsOfBase?: (basePath: string) => Promise<readonly string[]>;
}

/**
 * 페이지 본문을 통째로 바꾸되, 그 페이지의 자식 페이지 · 자식 DB 는 제자리에 둔다(S-03).
 *
 * 먼저 그대로 보낸다. 자식이 없는 페이지(대부분)는 여기서 끝나 추가 요청이 없다. 자식이
 * 있으면 Notion 이 삭제를 거절하므로(`validation_error`, 적용 안 됨) 지금 본문에서 자식
 * 태그를 받아 push 본문의 자식 자리에 되돌려 놓고 한 번 더 보낸다.
 *
 * 예전에는 자식이 있는 페이지의 본문 push 를 통째로 건너뛰고도 동기화됨으로 기록해,
 * 폴더 노트에서 고친 내용이 Notion 에 영영 가지 않았다.
 */
export async function replacePageBody(
  client: PageBodyClient,
  pageId: string,
  markdown: string,
  options: ReplacePageBodyOptions = {},
): Promise<void> {
  try {
    await client.replacePageMarkdown(pageId, markdown);
    return;
  } catch (error) {
    if (!isNotionValidationError(error)) throw error;

    const children = extractChildTags((await client.getPageMarkdown(pageId)).markdown);
    const baseIds = new Map<string, readonly string[]>();
    if (options.databaseIdsOfBase && children.some((c) => c.kind === "database")) {
      for (const path of baseEmbedPaths(markdown)) {
        baseIds.set(path, await options.databaseIdsOfBase(path));
      }
    }
    const restored = restoreChildTags(markdown, children, {
      databaseIdsOfBase: (path) => baseIds.get(path) ?? [],
    });
    // 되돌릴 자식이 없으면 거절 사유가 자식이 아니다 — Notion 이 말한 그대로 올린다.
    if (restored.markdown === markdown) throw error;

    try {
      await client.replacePageMarkdown(pageId, restored.markdown);
    } catch (retryError) {
      if (!isNotionValidationError(retryError)) throw retryError;
      throw new Error(
        `Notion 이 본문 교체를 거절해 보내지 않음 (자식 페이지 · DB 는 그대로 둠) — ${messageOf(retryError)}`,
      );
    }

    if (restored.appended.length > 0) {
      getLogger().warn(
        `[Im-Nobsidian] 본문에 자리가 없는 자식을 Notion 페이지 끝으로 옮김 (${pageId}): ` +
          restored.appended.map((c) => c.title.replace(/\*\*/g, "").trim()).join(", "),
      );
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
