/**
 * F-09 — Markdown API 는 북마크를 주소 · 캡션 없는 자리 태그로만 보낸다. 주소와 캡션은 블록으로 따로
 * 읽는다. 읽지 못한 블록은 이유를 남기고 맵에서 뺀다 — 그 북마크는 Notion 블록 링크로 남는다.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { NotionClient } from "../../src/notion/client.js";
import { getLogger, setLogger } from "../../src/utils/logger.js";

const previous = getLogger();
afterEach(() => setLogger(previous));

const text = (s: string) => ({ type: "text", plain_text: s, text: { content: s } });

function makeClient() {
  const client = new NotionClient({
    token: "ntn_test_fake_token",
    concurrency: 1,
    rateLimitIntervalMs: 0,
    maxRetries: 0,
  });
  const retrieve = vi
    .spyOn(client.getInternalClient().blocks, "retrieve")
    .mockImplementation(async ({ block_id }) => {
      if (block_id === "b-gone") throw new Error("Could not find block with ID: b-gone.");
      if (block_id === "b-para") {
        return { object: "block", id: block_id, type: "paragraph", paragraph: {} } as never;
      }
      return {
        object: "block",
        id: block_id,
        type: "bookmark",
        bookmark: {
          url: `https://example.com/${block_id}`,
          caption: block_id === "b-cap" ? [text("캡션 "), text("둘")] : [],
        },
      } as never;
    });
  return { client, retrieve };
}

describe("NotionClient.getBookmarks", () => {
  it("북마크 블록의 주소와 캡션을 돌려주고 같은 블록은 한 번만 읽는다", async () => {
    const { client, retrieve } = makeClient();

    const bookmarks = await client.getBookmarks(["b-1", "b-cap", "b-1"]);

    expect([...bookmarks]).toEqual([
      ["b-1", { url: "https://example.com/b-1", caption: "" }],
      ["b-cap", { url: "https://example.com/b-cap", caption: "캡션 둘" }],
    ]);
    expect(retrieve).toHaveBeenCalledTimes(2);
  });

  it("읽지 못한 블록은 이유를 남기고 빼며, 북마크가 아닌 블록도 뺀다", async () => {
    const warn = vi.fn();
    setLogger({ ...previous, warn });
    const { client } = makeClient();

    const bookmarks = await client.getBookmarks(["b-gone", "b-para", "b-1"]);

    expect([...bookmarks.keys()]).toEqual(["b-1"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(
      "북마크 블록을 읽지 못해 Notion 블록 링크로 둠 (b-gone)",
    );
    expect(warn.mock.calls[0]![0]).toContain("Could not find block");
  });
});
