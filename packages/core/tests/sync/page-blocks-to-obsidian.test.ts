/**
 * 블록 폴백 pull — 블록 트리를 읽어 Markdown API 경로와 같은 변환을 거치는지.
 *
 * 블록 트리는 자식까지 읽고(자식 페이지 · DB 는 열지 않는다), 하나라도 읽지 못하면 던진다 — 빠진 채로
 * 노트를 쓰면 다음 push 가 그 블록을 Notion 에서 지운다. 코드 글 · 북마크는 트리에서 꺼내 다시 묻지 않는다.
 */
import { describe, it, expect, vi } from "vitest";
import { NotionClient, type BlockTreeNode } from "../../src/notion/client.js";
import { pageBlocksToObsidian } from "../../src/sync/page-body.js";

const PAGE = "11111111-2222-4333-8444-555555555555";

function makeClient(children: Record<string, unknown[]>): {
  client: NotionClient;
  list: ReturnType<typeof vi.fn>;
} {
  const client = new NotionClient({
    token: "ntn_test_fake_token",
    concurrency: 1,
    rateLimitIntervalMs: 0,
    maxRetries: 0,
  });
  const list = vi
    .spyOn(client.getInternalClient().blocks.children, "list")
    .mockImplementation(async ({ block_id }) => {
      const results = children[block_id];
      if (results === undefined) throw new Error(`Could not find block with ID: ${block_id}.`);
      return { results, next_cursor: null, has_more: false } as never;
    });
  return { client, list: list as unknown as ReturnType<typeof vi.fn> };
}

const text = (content: string) => ({
  type: "text",
  plain_text: content,
  text: { content, link: null },
  annotations: {},
});
const node = (id: string, type: string, body: Record<string, unknown>, hasChildren = false) => ({
  object: "block",
  id,
  type,
  has_children: hasChildren,
  [type]: body,
});

describe("NotionClient.getBlockTree", () => {
  it("자식이 있는 블록은 children 에 담고, 자식 페이지 · DB 는 열지 않는다", async () => {
    const { client, list } = makeClient({
      [PAGE]: [
        node("t-1", "toggle", { rich_text: [text("t")] }, true),
        node("p-1", "child_page", { title: "c" }, true),
        node("d-1", "child_database", { title: "d" }, true),
      ],
      "t-1": [node("c-1", "paragraph", { rich_text: [text("안")] })],
    });

    const tree = await client.getBlockTree(PAGE);

    expect(tree.map((b) => [b.id, b.children?.map((c) => c.id)])).toEqual([
      ["t-1", ["c-1"]],
      ["p-1", undefined],
      ["d-1", undefined],
    ]);
    expect(list.mock.calls.map(([arg]) => (arg as { block_id: string }).block_id)).toEqual([
      PAGE,
      "t-1",
    ]);
  });

  it("자식을 하나라도 읽지 못하면 던진다", async () => {
    const { client } = makeClient({
      [PAGE]: [node("t-gone", "toggle", { rich_text: [] }, true)],
    });

    await expect(client.getBlockTree(PAGE)).rejects.toThrow("Could not find block");
  });
});

describe("pageBlocksToObsidian", () => {
  function fakeClient(tree: unknown[]) {
    return {
      getBlockTree: vi.fn().mockResolvedValue(tree as BlockTreeNode[]),
      getUserNames: vi.fn(async (ids: readonly string[]) => new Map(ids.map((id) => [id, "이름"]))),
    };
  }

  it("Markdown API 경로처럼 볼트 마크다운으로 — 토글 · 콜아웃 자식이 남는다", async () => {
    const client = fakeClient([
      {
        ...node("t-1", "toggle", { rich_text: [text("접힘")] }, true),
        children: [node("c-1", "paragraph", { rich_text: [text("안쪽")] })],
      },
      {
        ...node("co-1", "callout", {
          rich_text: [text("머리")],
          icon: { type: "emoji", emoji: "💡" },
        }),
        has_children: true,
        children: [node("c-2", "paragraph", { rich_text: [text("콜아웃 자식")] })],
      },
    ]);

    const { markdown, content } = await pageBlocksToObsidian(client, PAGE);

    expect(markdown).toContain("<details>\n<summary>접힘</summary>\n\t안쪽\n</details>");
    expect(content).toContain("안쪽");
    expect(content).toContain("> 콜아웃 자식");
  });

  it("사용자 멘션의 이름을 묻고, 토글 속 코드 글 · 북마크도 트리에서 꺼낸다", async () => {
    const bookmarkId = "3f713b18-d382-81d1-8f3f-d3725bb3dbcf";
    const userId = "00000000-0000-4000-8000-000000000001";
    // 코드 속 ``` 줄 때문에 NFM 만으로는 코드 범위를 가를 수 없다(S-22) — 코드 블록 글로 맞춘다.
    const code = "```\n```\n```python";
    const client = fakeClient([
      node("p-1", "paragraph", {
        rich_text: [
          { type: "mention", plain_text: "@u", mention: { type: "user", user: { id: userId } } },
        ],
      }),
      {
        ...node("t-1", "toggle", { rich_text: [text("접힘")] }, true),
        children: [
          node(bookmarkId, "bookmark", { url: "https://example.com/b", caption: [text("캡션")] }),
        ],
      },
      node("code-1", "code", { rich_text: [text(code)], language: "markdown" }),
    ]);

    const { content } = await pageBlocksToObsidian(client, PAGE);

    expect(client.getUserNames).toHaveBeenCalledWith([userId]);
    expect(content).toContain("@이름");
    expect(content).toContain(`\`\`\`\`markdown\n${code}\n\`\`\`\``);
    expect(content).toContain("[🔖 캡션](https://example.com/b)");
  });

  it("블록 트리를 읽지 못하면 던진다 — 빈 본문으로 쓰지 않는다", async () => {
    const client = fakeClient([]);
    client.getBlockTree.mockRejectedValue(new Error("rate limited"));

    await expect(pageBlocksToObsidian(client, PAGE)).rejects.toThrow("rate limited");
  });
});
