/**
 * S-06 — Markdown API 가 잘라 보낸 블록을 다시 받아 채운다.
 *
 * 실측(21,001블록 probe 페이지): 응답은 `truncated: true` 와 블록 ID 1,002개를 돌려주고, 잘린
 * 중첩 블록마다 `<unknown url="…#<32자리 ID>"/>` 태그가 부모 안 들여쓰기(탭) 그대로 자리를
 * 지킨다. 같은 엔드포인트에 블록 ID 를 주면 그 블록의 마크다운이 온다.
 *
 * 채우지 않던 때는 잘린 블록이 로컬에서 북마크 링크로 바뀌었고, 본문 상당수가 빠진 사본이
 * 동기화 완료로 기록됐다. 여기서 잠그는 것:
 *   1. 잘린 블록은 제자리에, 같은 깊이로 채운다 — 다시 받은 것이 또 잘렸어도.
 *   2. 권한이 닿지 않는 블록(404)만 태그로 남긴다. 다른 실패는 던진다.
 *   3. 상한을 넘으면 한 건도 받기 전에 멈춘다 — 한 페이지가 요청 한도를 붙잡지 못하게.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PageMarkdownResponse } from "@notionhq/client/build/src/api-endpoints.js";

import {
  completeTruncatedMarkdown,
  MarkdownCompletionTooLargeError,
} from "../../src/notion/markdown-completion.js";
import { NotionClient, isNotionObjectNotFound } from "../../src/notion/client.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { setLogger } from "../../src/utils/logger.js";

const PAGE = "11111111-1111-1111-1111-111111111111";
const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const compact = (id: string) => id.replace(/-/g, "");
/** 실측 모양 그대로 — url 의 # 뒤는 하이픈 없는 ID, alt 없음. */
const tag = (id: string) =>
  `<unknown url="https://app.notion.com/p/${compact(PAGE)}#${compact(id)}"/>`;

function response(
  id: string,
  markdown: string,
  unknown: string[] = [],
  truncated = unknown.length > 0,
): PageMarkdownResponse {
  return {
    object: "page_markdown",
    id,
    markdown,
    truncated,
    unknown_block_ids: unknown,
  } as PageMarkdownResponse;
}

function notFound(): Error {
  return Object.assign(new Error("Could not find block"), {
    status: 404,
    code: "object_not_found",
  });
}

const OPTIONS = { maxFetches: 100, isNotFound: isNotionObjectNotFound };

describe("잘린 블록을 제자리에 채운다", () => {
  it("잘린 곳이 없으면 받은 응답을 그대로 돌려주고 아무것도 다시 받지 않는다", async () => {
    const root = response(PAGE, "본문");
    const fetch = vi.fn();

    const { response: out, refetched } = await completeTruncatedMarkdown(root, fetch, OPTIONS);

    expect(out).toBe(root);
    expect(refetched).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("태그 자리에 같은 들여쓰기로 끼운다 — 목록의 하이픈 ID 와 태그의 32자리 ID 를 같은 블록으로 본다", async () => {
    const root = response(
      PAGE,
      ["<details>", "<summary>T1</summary>", "\tC0", `\t${tag(A)}`, "</details>", tag(B)].join(
        "\n",
      ),
      [A, B],
    );
    // 다시 받는 요청에는 태그와 같은 32자리 ID 가 간다.
    const bodies: Record<string, string> = { [compact(A)]: "C1\n", [compact(B)]: "마지막 문단" };

    const { response: out, refetched } = await completeTruncatedMarkdown(
      root,
      async (id) => response(id, bodies[id]!),
      OPTIONS,
    );

    expect(out.markdown).toBe(
      ["<details>", "<summary>T1</summary>", "\tC0", "\tC1", "</details>", "마지막 문단"].join(
        "\n",
      ),
    );
    expect(out.truncated).toBe(false);
    expect(out.unknown_block_ids).toEqual([]);
    expect(refetched).toBe(2);
  });

  it("여러 줄 블록은 줄마다 들여쓰고 빈 줄은 비워 둔다", async () => {
    const root = response(PAGE, `<details>\n<summary>T</summary>\n\t${tag(A)}\n</details>`, [A]);
    const toggle = "<details>\n<summary>안쪽</summary>\n\t문단 1\n\n\t문단 2\n</details>";

    const { response: out } = await completeTruncatedMarkdown(
      root,
      async (id) => response(id, toggle),
      OPTIONS,
    );

    expect(out.markdown).toBe(
      "<details>\n<summary>T</summary>\n" +
        "\t<details>\n\t<summary>안쪽</summary>\n\t\t문단 1\n\n\t\t문단 2\n\t</details>\n" +
        "</details>",
    );
  });

  it("다시 받은 블록이 또 잘렸으면 같은 규칙으로 채운다", async () => {
    const root = response(PAGE, tag(A), [A]);
    const fetch = vi.fn(async (id: string) =>
      id === compact(A) ? response(A, `앞\n${tag(B)}`, [B]) : response(id, "뒤"),
    );

    const { response: out, refetched } = await completeTruncatedMarkdown(root, fetch, OPTIONS);

    expect(out.markdown).toBe("앞\n뒤");
    expect(refetched).toBe(2);
  });

  it("같은 블록을 두 번 받지 않는다 — 자기 자신을 잘렸다고 돌려줘도 멈춘다", async () => {
    const root = response(PAGE, tag(A), [A]);
    const fetch = vi.fn(async (id: string) => response(id, tag(A), [A]));

    const { response: out } = await completeTruncatedMarkdown(root, fetch, OPTIONS);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(out.markdown).toBe(tag(A));
  });
});

describe("읽지 못한 블록 — 권한 없음만 태그로 남긴다", () => {
  it("404 는 태그를 그대로 두고 unknown_block_ids 로 알린다 — 되돌려 보낸 태그는 원래 블록을 지킨다", async () => {
    const root = response(PAGE, `${tag(A)}\n${tag(B)}`, [A, B]);

    const { response: out } = await completeTruncatedMarkdown(
      root,
      async (id) => {
        if (id === compact(A)) throw notFound();
        return response(id, "받음");
      },
      OPTIONS,
    );

    expect(out.markdown).toBe(`${tag(A)}\n받음`);
    expect(out.unknown_block_ids).toEqual([compact(A)]);
  });

  it("404 가 아닌 실패는 던진다 — 반쯤 채운 본문을 완성본처럼 돌려주지 않는다", async () => {
    const root = response(PAGE, `${tag(A)}\n${tag(B)}`, [A, B]);
    const serverError = Object.assign(new Error("HTTP 502"), { status: 502 });

    await expect(
      completeTruncatedMarkdown(
        root,
        async (id) => {
          if (id === compact(B)) throw serverError;
          return response(id, "받음");
        },
        OPTIONS,
      ),
    ).rejects.toBe(serverError);
  });

  it("받았는데 끼울 자리가 없으면(줄 가운데의 태그) 읽지 못한 것으로 알린다", async () => {
    const root = response(PAGE, `앞 ${tag(A)} 뒤`, [A]);

    const { response: out } = await completeTruncatedMarkdown(
      root,
      async (id) => response(id, "받음"),
      OPTIONS,
    );

    expect(out.markdown).toBe(`앞 ${tag(A)} 뒤`);
    expect(out.unknown_block_ids).toEqual([compact(A)]);
  });
});

describe("목록과 태그", () => {
  it("잘린 응답이면 목록에 없는 alt 없는 태그도 받는다 — 목록 상한(문서상 100개)에 기대지 않는다", async () => {
    const root = response(PAGE, `${tag(A)}\n${tag(B)}`, [A], true);
    const fetch = vi.fn(async (id: string) => response(id, `받음 ${id.slice(0, 1)}`));

    const { response: out } = await completeTruncatedMarkdown(root, fetch, OPTIONS);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(out.markdown).toBe("받음 a\n받음 b");
  });

  it("alt 가 붙은 태그(북마크 등)는 목록에 없으면 받지 않는다 — 다시 받아도 같은 태그가 온다", async () => {
    const bookmark = `<unknown url="https://app.notion.com/p/${compact(PAGE)}#${compact(C)}" alt="bookmark"/>`;
    const root = response(PAGE, `${bookmark}\n${tag(A)}`, [A], true);
    const fetch = vi.fn(async (id: string) => response(id, "받음"));

    const { response: out } = await completeTruncatedMarkdown(root, fetch, OPTIONS);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(compact(A));
    expect(out.markdown).toBe(`${bookmark}\n받음`);
  });

  it("잘렸다면서 잘린 곳을 알려 주지 않으면 던진다 — 완성본으로 쓸 수 없다", async () => {
    const root = response(PAGE, "앞부분만", [], true);

    await expect(completeTruncatedMarkdown(root, vi.fn(), OPTIONS)).rejects.toThrow(
      "잘린 블록을 알려 주지 않음",
    );
  });
});

describe("상한 — 한 페이지가 요청 한도를 오래 붙잡지 못하게", () => {
  it("잘린 블록이 상한보다 많으면 한 건도 받기 전에 멈춘다", async () => {
    const root = response(PAGE, `${tag(A)}\n${tag(B)}\n${tag(C)}`, [A, B, C]);
    const fetch = vi.fn();

    const error = await completeTruncatedMarkdown(root, fetch, {
      ...OPTIONS,
      maxFetches: 2,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MarkdownCompletionTooLargeError);
    expect(error).toMatchObject({ pageId: PAGE, required: 3, limit: 2 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("다시 받은 블록의 잘린 블록까지 합쳐 센다", async () => {
    const root = response(PAGE, tag(A), [A]);
    const fetch = vi.fn(async (id: string) =>
      id === compact(A) ? response(A, `${tag(B)}\n${tag(C)}`, [B, C]) : response(id, "x"),
    );

    await expect(
      completeTruncatedMarkdown(root, fetch, { ...OPTIONS, maxFetches: 2 }),
    ).rejects.toMatchObject({ required: 3, limit: 2 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("NotionClient.getPageMarkdown — 받은 그대로가 아니라 채운 본문을 돌려준다", () => {
  function newClient(options: { markdownCompletionMaxBlocks?: number } = {}): NotionClient {
    return new NotionClient({
      token: "ntn_test_fake_token",
      rateLimitIntervalMs: 0,
      retryBaseDelayMs: 1,
      ...options,
    });
  }

  function stubRetrieve(client: NotionClient, impl: (id: string) => PageMarkdownResponse) {
    const retrieveMarkdown = vi.fn(async ({ page_id }: { page_id: string }) => impl(page_id));
    (client as unknown as { client: { pages: unknown } }).client.pages = { retrieveMarkdown };
    return retrieveMarkdown;
  }

  beforeEach(() => {
    setLogger({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} });
  });

  it("잘린 블록을 같은 엔드포인트로 다시 받아 채운다", async () => {
    const client = newClient();
    const retrieve = stubRetrieve(client, (id) =>
      id === PAGE ? response(PAGE, `앞\n${tag(A)}`, [A]) : response(id, "잘렸던 문단"),
    );

    const out = await client.getPageMarkdown(PAGE);

    expect(out.markdown).toBe("앞\n잘렸던 문단");
    expect(retrieve.mock.calls.map(([arg]) => arg.page_id)).toEqual([PAGE, compact(A)]);
  });

  it("상한은 설정(advanced.markdownCompletionMaxBlocks)을 따른다", async () => {
    const client = newClient({ markdownCompletionMaxBlocks: 1 });
    stubRetrieve(client, (id) => (id === PAGE ? response(PAGE, "x", [A, B]) : response(id, "")));

    await expect(client.getPageMarkdown(PAGE)).rejects.toBeInstanceOf(
      MarkdownCompletionTooLargeError,
    );
  });

  it("설정의 기본 상한이 클라이언트 기본값이다 — 두 곳에 따로 적지 않는다", () => {
    const fromConfig = NotionClient.fromConfig({
      ...DEFAULT_CONFIG,
      notion: { ...DEFAULT_CONFIG.notion, token: "ntn_test" },
    });
    const direct = newClient();
    const limitOf = (c: NotionClient) =>
      (c as unknown as { markdownCompletionMaxBlocks: number }).markdownCompletionMaxBlocks;

    expect(limitOf(fromConfig)).toBe(DEFAULT_CONFIG.advanced.markdownCompletionMaxBlocks);
    expect(limitOf(direct)).toBe(DEFAULT_CONFIG.advanced.markdownCompletionMaxBlocks);
  });
});
