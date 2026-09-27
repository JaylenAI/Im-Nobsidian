import type { PageMarkdownResponse } from "@notionhq/client/build/src/api-endpoints.js";

import { compactNotionId } from "../utils/id.js";

/**
 * S-06 — Markdown API 가 잘라 보낸 블록을 다시 받아 제자리에 채운다.
 *
 * 블록이 많은 페이지는 뒤쪽이 잘린다(실측: 21,001블록 페이지에서 약 2만 번째 뒤의 중첩 블록
 * 1,002개). 잘린 블록마다 `<unknown url="…#<블록 ID>"/>` 태그가 자리를 지키고, 응답은
 * `truncated: true` · `unknown_block_ids` 로 알린다. 같은 엔드포인트에 블록 ID 를 주면 그
 * 블록(과 자식)의 마크다운이 온다 — 그것을 태그 자리에 같은 들여쓰기로 끼운다.
 *
 * 채우지 않으면 잘린 블록은 로컬에서 북마크 링크로 바뀌어 보이고, 본문 상당수가 빠진 사본이
 * 동기화 완료로 기록된다.
 *
 * 404 는 권한이 닿지 않는 블록이다 — 태그를 그대로 둔다. 되돌려 보낸 태그는 Notion 이 원래
 * 블록을 남기는 신호다(북마크 태그로 실측). 그 밖의 실패는 던진다 — 반쯤 채운 본문을
 * 완성본처럼 쓰지 않는다.
 */

export interface MarkdownCompletionOptions {
  /** 다시 받는 블록 수 상한 — 한 페이지가 요청 한도를 오래 붙잡지 못하게 한다. */
  readonly maxFetches: number;
  /** 권한이 닿지 않는 블록(404)인가 — 이 실패만 태그로 남기고 나머지는 던진다. */
  readonly isNotFound: (error: unknown) => boolean;
}

/** 잘린 블록이 상한보다 많다. 호출측은 블록 API 로 폴백하거나 그 항목을 실패로 남긴다. */
export class MarkdownCompletionTooLargeError extends Error {
  constructor(
    readonly pageId: string,
    readonly required: number,
    readonly limit: number,
  ) {
    super(`Markdown API 가 잘라 보낸 블록이 상한보다 많음 (${required}개 > ${limit}개): ${pageId}`);
    this.name = "MarkdownCompletionTooLargeError";
  }
}

/**
 * 줄 하나를 통째로 차지하는 블록 자리 태그. 들여쓰기는 부모 블록 안의 깊이다.
 * url 의 `#` 뒤가 블록 ID 다(하이픈 없는 32자리 — 실측).
 */
const UNKNOWN_BLOCK_TAG_RE =
  /^([ \t]*)<unknown url="[^"]*#([0-9a-fA-F-]{32,36})"([^>]*)\/>[ \t]*$/gm;

export interface CompletedMarkdown {
  /** 채운 응답. 채울 것이 없었으면 받은 응답 그대로다. `unknown_block_ids` 는 끝내 읽지 못한 블록이다. */
  readonly response: PageMarkdownResponse;
  /** 다시 받은 블록 수 — 0 이면 잘린 곳이 없었다. */
  readonly refetched: number;
}

/** 잘린 블록을 모두 다시 받아 채운다. */
export async function completeTruncatedMarkdown(
  root: PageMarkdownResponse,
  fetchMarkdown: (id: string) => Promise<PageMarkdownResponse>,
  options: MarkdownCompletionOptions,
): Promise<CompletedMarkdown> {
  const state: CompletionState = {
    fetchMarkdown,
    options,
    rootId: root.id,
    fetched: 0,
    visited: new Set([compactNotionId(root.id)]),
  };
  const { markdown, unresolved } = await complete(root, state);
  if (state.fetched === 0) return { response: root, refetched: 0 };
  return {
    response: { ...root, markdown, truncated: false, unknown_block_ids: unresolved.sort() },
    refetched: state.fetched,
  };
}

interface CompletionState {
  readonly fetchMarkdown: (id: string) => Promise<PageMarkdownResponse>;
  readonly options: MarkdownCompletionOptions;
  readonly rootId: string;
  fetched: number;
  readonly visited: Set<string>;
}

async function complete(
  response: PageMarkdownResponse,
  state: CompletionState,
): Promise<{ markdown: string; unresolved: string[] }> {
  const candidates = collectCandidates(response).filter((id) => !state.visited.has(id));
  if (candidates.length === 0) {
    if (response.truncated && (response.unknown_block_ids ?? []).length === 0) {
      // 잘렸다면서 어디가 잘렸는지 말하지 않는다 — 이 본문을 완성본으로 쓸 수 없다.
      throw new Error(`Markdown API 가 본문을 잘랐지만 잘린 블록을 알려 주지 않음: ${response.id}`);
    }
    return { markdown: response.markdown, unresolved: [] };
  }

  const required = state.fetched + candidates.length;
  if (required > state.options.maxFetches) {
    throw new MarkdownCompletionTooLargeError(state.rootId, required, state.options.maxFetches);
  }
  state.fetched = required;
  for (const id of candidates) state.visited.add(id);

  const unresolved: string[] = [];
  const filled = new Map<string, string>();
  await Promise.all(
    candidates.map(async (id) => {
      let sub: PageMarkdownResponse;
      try {
        sub = await state.fetchMarkdown(id);
      } catch (error) {
        if (!state.options.isNotFound(error)) throw error;
        unresolved.push(id);
        return;
      }
      // 다시 받은 블록도 잘릴 수 있다 — 같은 규칙으로 채운다.
      const inner = await complete(sub, state);
      unresolved.push(...inner.unresolved);
      filled.set(id, inner.markdown.replace(/\n+$/, ""));
    }),
  );

  const spliced = new Set<string>();
  const markdown = response.markdown.replace(
    UNKNOWN_BLOCK_TAG_RE,
    (tag, indent: string, rawId: string) => {
      const id = compactNotionId(rawId);
      const body = filled.get(id);
      if (body === undefined) return tag;
      spliced.add(id);
      return indentLines(body, indent);
    },
  );
  // 받았는데 끼울 자리(줄을 통째로 차지한 태그)를 못 찾은 블록은 태그로 남아 있다 — 읽지 못한 것과 같다.
  for (const id of filled.keys()) if (!spliced.has(id)) unresolved.push(id);
  return { markdown, unresolved };
}

/**
 * 다시 받을 블록 ID. `unknown_block_ids` 가 기본이고, 잘린 응답이면 `alt` 없는 태그도 더한다.
 * 문서는 목록을 100개까지라고 하지만 실측은 1,002개였다 — 목록이 잘려도 태그로 찾는다.
 * `alt` 가 붙은 태그(북마크 · 버튼 등)는 Markdown 이 표현하지 못하는 블록이라 다시 받아도
 * 같은 태그가 온다(실측) — 목록에 없으면 받지 않는다.
 */
function collectCandidates(response: PageMarkdownResponse): string[] {
  const ids = new Set((response.unknown_block_ids ?? []).map(compactNotionId));
  if (response.truncated) {
    for (const match of response.markdown.matchAll(UNKNOWN_BLOCK_TAG_RE)) {
      if (!/\balt="/.test(match[3] ?? "")) ids.add(compactNotionId(match[2]!));
    }
  }
  return [...ids];
}

function indentLines(body: string, indent: string): string {
  if (!indent) return body;
  return body
    .split("\n")
    .map((line) => (line.length > 0 ? indent + line : line))
    .join("\n");
}
