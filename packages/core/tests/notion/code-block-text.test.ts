/**
 * 코드 블록의 글 — 블록 API 로 쓰고 읽는다(S-22). Markdown API 로 보낼 수 없는 코드(코드 속 ``` 줄)를
 * 채우고, 받은 markdown 만으로 코드 범위를 가를 수 없을 때 블록의 글을 읽는다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NotionClient } from "../../src/notion/client.js";
import { richTextChunks } from "../../src/notion/rich-text.js";
import { RICH_TEXT_ARRAY_MAX, RICH_TEXT_CONTENT_MAX } from "../../src/constants/notion-limits.js";
import { setLogger } from "../../src/utils/logger.js";

function newClient(): NotionClient {
  return new NotionClient({
    token: "ntn_test_fake_token",
    concurrency: 1,
    maxRetries: 3,
    retryBaseDelayMs: 1,
    rateLimitIntervalMs: 0,
  });
}

function sdk(client: NotionClient): Record<string, unknown> {
  return (client as unknown as { client: Record<string, unknown> }).client;
}

beforeEach(() => {
  setLogger({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("richTextChunks", () => {
  it("rich text 하나의 한도마다 가른다", () => {
    const text = "a".repeat(RICH_TEXT_CONTENT_MAX * 2 + 1);
    expect(richTextChunks(text)!.map((c) => c.length)).toEqual([
      RICH_TEXT_CONTENT_MAX,
      RICH_TEXT_CONTENT_MAX,
      1,
    ]);
  });

  it("서로게이트 쌍을 가르지 않는다", () => {
    const text = "a".repeat(RICH_TEXT_CONTENT_MAX - 1) + "😀";
    expect(richTextChunks(text)).toEqual(["a".repeat(RICH_TEXT_CONTENT_MAX - 1), "😀"]);
  });

  it("빈 글은 조각이 없다", () => {
    expect(richTextChunks("")).toEqual([]);
  });

  it("배열 한도를 넘을 만큼 길면 담을 수 없다", () => {
    expect(richTextChunks("a".repeat(RICH_TEXT_CONTENT_MAX * RICH_TEXT_ARRAY_MAX))).toHaveLength(
      RICH_TEXT_ARRAY_MAX,
    );
    expect(richTextChunks("a".repeat(RICH_TEXT_CONTENT_MAX * RICH_TEXT_ARRAY_MAX + 1))).toBeNull();
  });
});

describe("NotionClient.updateCodeBlockText", () => {
  it("코드를 rich text 조각으로 나눠 언어와 함께 보낸다", async () => {
    const client = newClient();
    const update = vi.fn().mockResolvedValue({});
    sdk(client).blocks = { update };
    const code = "```js\n" + "x".repeat(RICH_TEXT_CONTENT_MAX) + "\n```";

    await client.updateCodeBlockText("block-1", code, "markdown");

    expect(update).toHaveBeenCalledTimes(1);
    const [request] = update.mock.calls[0]!;
    expect(request.block_id).toBe("block-1");
    expect(request.code.language).toBe("markdown");
    expect(request.code.rich_text).toHaveLength(2);
    expect(
      request.code.rich_text.map((t: { text: { content: string } }) => t.text.content).join(""),
    ).toBe(code);
    expect(request.code.rich_text[0].type).toBe("text");
  });

  it("같은 글로 다시 보내도 같다 — 모호한 실패는 다시 보낸다", async () => {
    const client = newClient();
    const error = Object.assign(new Error("HTTP 502"), { status: 502 });
    const update = vi.fn().mockRejectedValueOnce(error).mockResolvedValue({});
    sdk(client).blocks = { update };

    await client.updateCodeBlockText("block-1", "x", "plain text");

    expect(update).toHaveBeenCalledTimes(2);
  });

  it("코드 블록 하나에 담을 수 없으면 보내지 않고 던진다", async () => {
    const client = newClient();
    const update = vi.fn();
    sdk(client).blocks = { update };

    await expect(
      client.updateCodeBlockText(
        "block-1",
        "a".repeat(RICH_TEXT_CONTENT_MAX * RICH_TEXT_ARRAY_MAX + 1),
        "plain text",
      ),
    ).rejects.toThrow("코드가 너무 길어");
    expect(update).not.toHaveBeenCalled();
  });
});

describe("NotionClient.getCodeBlockTexts", () => {
  it("컨테이너 안까지 코드 블록의 글을 — 나뉜 rich text 는 이어 붙여", async () => {
    const client = newClient();
    vi.spyOn(client, "fetchAllChildrenDeep").mockResolvedValue([
      { id: "p", type: "paragraph", paragraph: { rich_text: [{ plain_text: "본문" }] } },
      {
        id: "c1",
        type: "code",
        code: { rich_text: [{ plain_text: "a\n```" }, { plain_text: "\nb" }] },
      },
      { id: "c2", type: "code", code: { rich_text: [] } },
    ] as never);

    expect(await client.getCodeBlockTexts("page")).toEqual(["a\n```\nb", ""]);
    expect(client.fetchAllChildrenDeep).toHaveBeenCalledWith("page");
  });
});
