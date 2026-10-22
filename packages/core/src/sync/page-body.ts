import type { PageMarkdownResponse } from "@notionhq/client/build/src/api-endpoints.js";
import {
  baseEmbedPaths,
  childLayout,
  extractChildTags,
  restoreChildTags,
} from "../converter/child-tags.js";
import { blocksToNfm, type NfmSourceBlock } from "../converter/blocks-to-nfm.js";
import { bookmarkBlockIds } from "../converter/bookmark.js";
import { notionEnhancedToObsidian } from "../converter/enhanced-md-converter.js";
import { replaceMissingUnknownTags, unknownTagKeys } from "../converter/unknown-tag-fallback.js";
import { mentionUserIds } from "../converter/mention.js";
import { needsCodeBlockTexts } from "../converter/nested-code-fence.js";
import { isNotionValidationError, type NotionClient } from "../notion/client.js";
import type { BookmarkTarget } from "../types/convert.js";
import { compactNotionId } from "../utils/id.js";
import { getLogger } from "../utils/logger.js";

type PageBodyClient = Pick<NotionClient, "replacePageMarkdown" | "getPageMarkdown">;

export interface ReplacePageBodyOptions {
  /**
   * 볼트의 `.base` 가 어느 Notion DB 의 것인지(하이픈 유무 무관). 본문의 `.base` 임베드를
   * 자식 DB 와 id 로 맞추는 데 쓴다 — 없으면 제목으로만 맞춘다. 자식 DB 가 있는 페이지를
   * 다시 보낼 때만 부른다.
   */
  readonly databaseIdsOfBase?: (basePath: string) => Promise<readonly string[]>;
  /**
   * 볼트 노트의 자리 블록이 Notion 에 없을 때 보낼 모양(`unknownTagFallbacks`). 주면 거절된 본문의
   * 자리 태그 가운데 지금 본문에 없는 블록의 것을 이 모양으로 바꿔 다시 보낸다(N6).
   */
  readonly unknownTagFallbacks?: ReadonlyMap<string, string>;
}

/**
 * 페이지 본문을 통째로 바꾸되, 그 페이지의 자식 페이지 · 자식 DB 는 제자리에 둔다(S-03).
 *
 * 먼저 그대로 보낸다. 자식이 없는 페이지(대부분)는 여기서 끝나 추가 요청이 없다. 자식이
 * 있으면 Notion 이 삭제를 거절하므로(`validation_error`, 적용 안 됨) 지금 본문에서 자식
 * 태그를 받아 push 본문의 자식 자리에 되돌려 놓고 한 번 더 보낸다. 지금 본문에 없는 블록을
 * 가리키는 자리 태그도 Notion 이 거절한다 — 그 태그는 볼트에 보이는 모양으로 바꾼다(N6).
 *
 * 예전에는 자식이 있는 페이지의 본문 push 를 통째로 건너뛰고도 동기화됨으로 기록해,
 * 폴더 노트에서 고친 내용이 Notion 에 영영 가지 않았다.
 *
 * @returns 본문을 바꾼 요청의 응답 — 바꾼 뒤의 본문을 싣는다.
 */
export async function replacePageBody(
  client: PageBodyClient,
  pageId: string,
  markdown: string,
  options: ReplacePageBodyOptions = {},
): Promise<PageMarkdownResponse> {
  try {
    return await client.replacePageMarkdown(pageId, markdown);
  } catch (error) {
    if (!isNotionValidationError(error)) throw error;

    const remote = (await client.getPageMarkdown(pageId)).markdown;
    const sendable = options.unknownTagFallbacks
      ? replaceMissingUnknownTags(markdown, unknownTagKeys(remote), options.unknownTagFallbacks)
      : { nfm: markdown, replaced: 0 };
    if (sendable.replaced > 0) {
      getLogger().warn(
        `[Im-Nobsidian] Notion 페이지에 없는 블록을 가리키는 자리 ${sendable.replaced}개를 볼트의 링크 · 북마크로 보냄 (${pageId})`,
      );
    }
    const children = extractChildTags(remote);
    const baseIds = new Map<string, readonly string[]>();
    if (options.databaseIdsOfBase && children.some((c) => c.kind === "database")) {
      for (const path of baseEmbedPaths(markdown)) {
        baseIds.set(path, await options.databaseIdsOfBase(path));
      }
    }
    const restored = restoreChildTags(sendable.nfm, children, {
      databaseIdsOfBase: (path) => baseIds.get(path) ?? [],
    });
    // 되돌릴 자식도 바꿀 자리 태그도 없으면 거절 사유가 그것이 아니다 — Notion 이 말한 그대로 올린다.
    if (restored.markdown === markdown) throw error;

    let written: PageMarkdownResponse;
    try {
      written = await client.replacePageMarkdown(pageId, restored.markdown);
      // 자식이 다른 컨테이너로 옮겨 가거나 차례가 바뀌면 Notion 이 그 자식을 품은 콜아웃 · 토글을 페이지
      // 맨 위에 두는 일이 있다 — 같은 본문을 한 번 더 보내면 제자리로 갔다(2026-10-04 실측, S-28). 어느
      // 이동이 어긋나는지 Notion 이 밝히지 않아, 자식의 배치가 바뀐 교체는 모두 한 번 더 보낸다.
      if (childLayout(remote).join("\n") !== childLayout(restored.markdown).join("\n")) {
        written = await client.replacePageMarkdown(pageId, restored.markdown);
      }
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
    return written;
  }
}

/**
 * 받은 본문(Markdown API)을 볼트 마크다운으로 바꾼다 — 사용자 멘션에 보일 이름을 물어 함께 넘긴다
 * (`converter/mention.ts`). 페이지와 DB 행이 같은 길로 받아야 같은 멘션이 같은 글이 된다.
 *
 * 코드 속 ``` 줄 때문에 코드 범위를 markdown 만으로 가를 수 없으면 그 페이지의 코드 블록 글을 블록으로
 * 읽어 맞춘다(S-22). 읽지 못하면 던진다 — 짐작한 범위로 쓰면 코드 뒷부분이 본문으로 새어 노트가
 * 바뀐다. 북마크는 블록을 읽어 주소 · 캡션을 보인다(F-09) — 읽지 못한 북마크는 Notion 의 블록을
 * 가리키는 링크로 남고 블록은 마커로 보존된다. 사용자 멘션 · 그런 코드 · 북마크가 없으면 묻지 않는다.
 */
export async function notionBodyToObsidian(
  client: Pick<NotionClient, "getUserNames" | "getCodeBlockTexts" | "getBookmarks">,
  markdown: string,
  pageId: string,
): Promise<string> {
  const ids = mentionUserIds(markdown);
  const userNames = ids.length > 0 ? await client.getUserNames(ids) : undefined;
  const codeTexts = needsCodeBlockTexts(markdown)
    ? new Set(await client.getCodeBlockTexts(pageId))
    : undefined;
  const bookmarkIds = bookmarkBlockIds(markdown);
  const bookmarks = bookmarkIds.length > 0 ? await client.getBookmarks(bookmarkIds) : undefined;
  return notionEnhancedToObsidian(markdown, { userNames, codeTexts, bookmarks });
}

/**
 * 블록 API 로 받은 본문을 볼트 마크다운으로 — Markdown API 로 받지 못한 페이지(잘린 export · 오류 ·
 * `preferMarkdownApi: false`)의 폴백.
 *
 * 블록을 Notion 이 내보내는 것과 같은 NFM 으로 옮긴 뒤({@link blocksToNfm}) Markdown API 경로와 같은 변환을
 * 거친다 — 받는 길에 따라 같은 페이지가 다른 노트가 되면, 그 노트를 push 할 때 차이만큼 Notion 이 바뀐다.
 * 코드 글 · 북마크는 블록에 이미 있어 다시 묻지 않는다. 블록을 하나라도 읽지 못하면 던진다.
 *
 * @returns `markdown` 은 옮긴 NFM(인라인 DB 수집 · 압축형 판정용), `content` 는 볼트 마크다운.
 */
export async function pageBlocksToObsidian(
  client: Pick<NotionClient, "getBlockTree" | "getUserNames">,
  pageId: string,
): Promise<{ markdown: string; content: string }> {
  const tree = await client.getBlockTree(pageId);
  const markdown = blocksToNfm(tree, { pageId });
  const content = await notionBodyToObsidian(
    {
      getUserNames: (ids) => client.getUserNames(ids),
      getCodeBlockTexts: () => Promise.resolve(blocksOfType(tree, "code").map(plainTextOf)),
      getBookmarks: () => Promise.resolve(bookmarksOf(tree)),
    },
    markdown,
    pageId,
  );
  return { markdown, content };
}

function blocksOfType(blocks: readonly NfmSourceBlock[], type: string): NfmSourceBlock[] {
  return blocks.flatMap((b) => [
    ...(b.type === type ? [b] : []),
    ...blocksOfType(b.children ?? [], type),
  ]);
}

function bodyOf(block: NfmSourceBlock): Record<string, unknown> {
  return ((block as unknown as Record<string, unknown>)[block.type] ?? {}) as Record<
    string,
    unknown
  >;
}

function plainTextOf(block: NfmSourceBlock): string {
  const items = (bodyOf(block).rich_text ?? []) as Array<{ plain_text?: string }>;
  return items.map((t) => t.plain_text ?? "").join("");
}

/** 북마크 블록의 주소 · 캡션 — 하이픈 없는 블록 id 로({@link bookmarkBlockIds} 와 같은 열쇠). */
function bookmarksOf(blocks: readonly NfmSourceBlock[]): Map<string, BookmarkTarget> {
  return new Map(
    blocksOfType(blocks, "bookmark").map((b) => {
      const body = bodyOf(b);
      const caption = (body.caption ?? []) as Array<{ plain_text?: string }>;
      return [
        compactNotionId(b.id),
        { url: String(body.url ?? ""), caption: caption.map((t) => t.plain_text ?? "").join("") },
      ];
    }),
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
