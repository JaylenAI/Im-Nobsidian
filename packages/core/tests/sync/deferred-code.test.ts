/**
 * 자리표시로 보낸 코드 채우기(S-22) — 본문을 쓴 뒤 자리표시를 글로 가진 코드 블록을 찾아 그 글을
 * 코드로 바꾼다. 컨테이너 안까지 찾고, 이 페이지가 보낸 코드가 아닌 곳(자식 페이지 · DB · 다른 곳이
 * 원본인 동기화 블록 · 표)에는 들어가지 않는다.
 */
import { describe, it, expect, vi } from "vitest";
import { fillDeferredCode } from "../../src/sync/deferred-code.js";
import { deferredCodeMarker } from "../../src/constants/markers.js";

type Block = Record<string, unknown> & { id: string };

const code = (id: string, text: string, language = "markdown"): Block => ({
  id,
  type: "code",
  has_children: false,
  code: { language, rich_text: [{ plain_text: text }] },
});
const container = (id: string, type: string, extra: Record<string, unknown> = {}): Block => ({
  id,
  type,
  has_children: true,
  [type]: extra,
});

function fakeClient(tree: Record<string, Block[]>) {
  return {
    fetchAllChildren: vi.fn(async (parentId: string) => tree[parentId] ?? []),
    updateCodeBlockText: vi.fn(async () => undefined),
  };
}

const T0 = deferredCodeMarker(0);
const T1 = deferredCodeMarker(1);

describe("fillDeferredCode", () => {
  it("넘길 코드가 없으면 아무것도 읽지 않는다", async () => {
    const client = fakeClient({});
    expect(await fillDeferredCode(client as never, "page", [])).toBe(false);
    expect(client.fetchAllChildren).not.toHaveBeenCalled();
  });

  it("맨 위 · 콜아웃 안 자리표시를 찾아 블록의 언어 그대로 코드를 채운다", async () => {
    const client = fakeClient({
      page: [code("c0", T0), container("callout", "callout"), code("plain", "const x = 1;")],
      callout: [code("c1", `  ${T1}\n`, "python")],
    });

    const filled = await fillDeferredCode(client as never, "page", [
      { token: T0, code: "```js\nx\n```" },
      { token: T1, code: "```py\ny\n```" },
    ]);

    expect(filled).toBe(true);
    expect(client.updateCodeBlockText.mock.calls).toEqual([
      ["c0", "```js\nx\n```", "markdown"],
      ["c1", "```py\ny\n```", "python"],
    ]);
  });

  it("다 찾으면 더 읽지 않는다", async () => {
    const client = fakeClient({
      page: [code("c0", T0), container("toggle", "toggle")],
      toggle: [code("other", "x")],
    });

    await fillDeferredCode(client as never, "page", [{ token: T0, code: "```\n```" }]);

    expect(client.fetchAllChildren).toHaveBeenCalledTimes(1);
  });

  it("자식 페이지 · DB · 표 · 다른 곳이 원본인 동기화 블록에는 들어가지 않는다", async () => {
    const client = fakeClient({
      page: [
        container("child", "child_page"),
        container("db", "child_database"),
        container("table", "table"),
        container("copy", "synced_block", { synced_from: { block_id: "elsewhere" } }),
        container("original", "synced_block", { synced_from: null }),
      ],
      original: [code("c0", T0)],
    });

    await fillDeferredCode(client as never, "page", [{ token: T0, code: "```\n```" }]);

    expect(client.fetchAllChildren.mock.calls.map(([id]) => id)).toEqual(["page", "original"]);
    expect(client.updateCodeBlockText).toHaveBeenCalledWith("c0", "```\n```", "markdown");
  });

  it("자리표시를 다 찾지 못하면 남은 수와 함께 던진다", async () => {
    const client = fakeClient({ page: [code("c0", T0)] });

    await expect(
      fillDeferredCode(client as never, "page", [
        { token: T0, code: "a" },
        { token: T1, code: "b" },
      ]),
    ).rejects.toThrow("코드 블록 1개를 Notion 에 채우지 못함");
    expect(client.updateCodeBlockText).toHaveBeenCalledTimes(1);
  });
});
