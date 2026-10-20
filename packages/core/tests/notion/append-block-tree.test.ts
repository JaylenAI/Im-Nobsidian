/**
 * C14 — `appendBlockTree` 가 깊이 제한 없는 블록 트리를 블록 API 의 요청 한도 안으로 나눠 보내고,
 * 다 보낸 뒤 Notion 의 트리가 보낸 트리와 같은지.
 *
 * 가짜 SDK 가 요청마다 한도를 검사한다(SDK 요청 타입 · Notion 문서): 자식은 요청에 담은 블록 아래로 두
 * 단계까지(칼럼 묶음의 칼럼은 세지 않는다), 배열 하나에 100 개, 요청 하나에 블록 1000 개. 칼럼 묶음은
 * 요청의 맨 위에만, 표 · 탭은 자식(행 · 탭)이 들어갈 깊이가 남은 곳에만.
 */
import { describe, it, expect, vi } from "vitest";
import { NotionClient } from "../../src/notion/client.js";
import { shapeBlock, type BlockRequest } from "../../src/notion/block-tree.js";
import {
  BLOCK_CHILDREN_MAX,
  BLOCK_NESTING_MAX,
  REQUEST_BLOCKS_MAX,
} from "../../src/constants/notion-limits.js";
import { blockOutline } from "../helpers/block-outline.js";

const PAGE = "11111111-2222-4333-8444-555555555555";

type Json = Record<string, unknown>;
interface Stored {
  readonly id: string;
  readonly type: string;
  readonly body: Json;
  readonly children: Stored[];
}

function childrenOf(block: Json): Json[] {
  return ((block[block.type as string] as Json).children as Json[] | undefined) ?? [];
}

/** 요청 한도를 검사하고 블록을 쌓는 가짜 Notion. */
function fakeNotion() {
  const client = new NotionClient({
    token: "ntn_test_fake_token",
    concurrency: 1,
    rateLimitIntervalMs: 0,
    maxRetries: 0,
  });
  const nodes = new Map<string, Stored>([
    [PAGE, { id: PAGE, type: "page", body: {}, children: [] }],
  ]);
  const requests: Json[][] = [];
  let seq = 0;

  const check = (blocks: Json[], level: number): number => {
    expect(blocks.length).toBeLessThanOrEqual(BLOCK_CHILDREN_MAX);
    let count = 0;
    for (const block of blocks) {
      count += 1;
      const kids = childrenOf(block);
      if (block.type === "column_list") {
        expect(level, "칼럼 묶음은 요청의 맨 위에만").toBe(0);
        for (const column of kids) {
          count += 1;
          expect(childrenOf(column).length, "칼럼은 자식이 있어야 한다").toBeGreaterThan(0);
          count += check(childrenOf(column), level + 1);
        }
        continue;
      }
      if (block.type === "table" || block.type === "tab") {
        expect(kids.length, `${block.type as string} 는 자식과 함께 만든다`).toBeGreaterThan(0);
      }
      if (kids.length > 0) {
        expect(level + 1, "자식은 두 단계까지").toBeLessThanOrEqual(BLOCK_NESTING_MAX);
        count += check(kids, level + 1);
      }
    }
    return count;
  };

  const store = (parent: Stored, blocks: Json[]): Stored[] =>
    blocks.map((block) => {
      const type = block.type as string;
      const { children: _kids, ...body } = block[type] as Json;
      const node: Stored = { id: `blk-${++seq}`, type, body, children: [] };
      nodes.set(node.id, node);
      parent.children.push(node);
      store(node, childrenOf(block));
      return node;
    });

  vi.spyOn(client.getInternalClient().blocks.children, "append").mockImplementation((async ({
    block_id,
    children,
  }: {
    block_id: string;
    children: Json[];
  }) => {
    requests.push(children);
    expect(check(children, 0)).toBeLessThanOrEqual(REQUEST_BLOCKS_MAX);
    const parent = nodes.get(block_id);
    if (!parent) throw new Error(`Could not find block with ID: ${block_id}.`);
    const created = store(parent, children);
    return { results: created.map((n) => ({ object: "block", id: n.id, type: n.type })) };
  }) as never);
  vi.spyOn(client.getInternalClient().blocks.children, "list").mockImplementation((async ({
    block_id,
  }: {
    block_id: string;
  }) => {
    const parent = nodes.get(block_id)!;
    return {
      results: parent.children.map((n) => ({ object: "block", id: n.id, type: n.type })),
      next_cursor: null,
      has_more: false,
    };
  }) as never);

  const tree = (node: Stored): Json[] =>
    node.children.map((n) => ({ type: n.type, [n.type]: { ...n.body, children: tree(n) } }));
  return { client, requests, tree: () => tree(nodes.get(PAGE)!) };
}

const text = (content: string) => [{ type: "text", text: { content } }];
const para = (content: string, children: BlockRequest[] = []): BlockRequest => ({
  type: "paragraph",
  paragraph: { rich_text: text(content), ...(children.length ? { children } : {}) },
});
const bullet = (content: string, children: BlockRequest[] = []): BlockRequest => ({
  type: "bulleted_list_item",
  bulleted_list_item: { rich_text: text(content), ...(children.length ? { children } : {}) },
});
const toggle = (content: string, children: BlockRequest[]): BlockRequest => ({
  type: "toggle",
  toggle: { rich_text: text(content), children },
});
const table = (rows: number): BlockRequest => ({
  type: "table",
  table: {
    table_width: 1,
    has_column_header: false,
    has_row_header: false,
    children: Array.from({ length: rows }, (_, i) => ({
      type: "table_row",
      table_row: { cells: [text(`r${i}`)] },
    })),
  },
});
const columns = (...cols: BlockRequest[][]): BlockRequest => ({
  type: "column_list",
  column_list: { children: cols.map((children) => ({ type: "column", column: { children } })) },
});
const tab = (...items: BlockRequest[]): BlockRequest => ({ type: "tab", tab: { children: items } });

/** 깊이 n 의 목록 사슬. */
const chain = (depth: number, at = 0): BlockRequest =>
  bullet(`L${at}`, at + 1 < depth ? [chain(depth, at + 1)] : []);

async function roundTrip(blocks: BlockRequest[]) {
  const notion = fakeNotion();
  await notion.client.appendBlockTree(PAGE, blocks);
  expect(blockOutline(notion.tree())).toEqual(blockOutline(blocks as never));
  return notion.requests;
}

describe("NotionClient.appendBlockTree — 요청 한도 안으로 나눠 보내고 트리는 그대로", () => {
  it("깊은 목록 — 두 단계씩 만들고 나머지는 만든 블록 아래에 붙인다", async () => {
    const requests = await roundTrip([chain(8), para("뒤")]);
    expect(requests.length).toBeGreaterThan(1);
  });

  it("형제 250 개 — 100 개씩", async () => {
    const requests = await roundTrip(Array.from({ length: 250 }, (_, i) => para(`p${i}`)));
    expect(requests.map((r) => r.length)).toEqual([100, 100, 50]);
  });

  it("150행 표 — 100행으로 만들고 나머지 행을 표에 붙인다", async () => {
    await roundTrip([table(150)]);
  });

  it("목록 속 토글 속 표 · 탭 — 놓을 수 없는 깊이면 부모를 만든 뒤 붙인다(순서 그대로)", async () => {
    await roundTrip([
      bullet("바깥", [
        toggle("토글", [para("앞"), table(3), tab(para("탭1", [para("탭 본문")])), para("뒤")]),
      ]),
    ]);
  });

  it("칼럼 묶음 — 맨 위가 아니면 부모를 만든 뒤 붙이고, 칼럼 속 깊은 블록도 남는다", async () => {
    await roundTrip([
      columns([chain(5)], [table(2), para("오른쪽")]),
      toggle("토글", [columns([para("안 왼쪽")], [para("안 오른쪽")])]),
    ]);
  });

  it("칼럼에 자식이 100 개를 넘으면 나머지는 그 칼럼 아래에 붙인다", async () => {
    await roundTrip([
      columns(
        [para("왼쪽")],
        Array.from({ length: 150 }, (_, i) => para(`오른쪽 ${i}`)),
      ),
    ]);
  });

  it("블록 하나가 요청 한도보다 크면 담는 깊이를 줄인다", async () => {
    const big = toggle(
      "큰 토글",
      Array.from({ length: 30 }, (_, n) =>
        toggle(
          `t${n}`,
          Array.from({ length: 40 }, (_, i) => para(`${n}-${i}`)),
        ),
      ),
    );
    const requests = await roundTrip([big]);
    expect(requests[0]).toHaveLength(1);
  });

  it("요청 하나가 블록 1000 개를 넘지 않는다", async () => {
    const wide = (n: number) => Array.from({ length: 30 }, (_, i) => para(`${n}-${i}`));
    await roundTrip(
      Array.from({ length: 40 }, (_, n) =>
        toggle(
          `t${n}`,
          wide(n).map((p) => ({ ...p })),
        ),
      ),
    );
  });
});

describe("shapeBlock — 칼럼", () => {
  it("첫 자식을 놓을 수 없는 칼럼은 빈 문단을 품고, 그 자식은 그 칼럼 아래에 붙인다", () => {
    const shaped = shapeBlock(columns([table(2)], [para("오른쪽")]), 0, 1);
    expect(blockOutline([shaped.body] as never)).toEqual([
      "column_list {} ",
      "  column {} ",
      "    paragraph {} ",
      "  column {} ",
      '    paragraph {} T"오른쪽"',
    ]);
    expect(shaped.pending.map((p) => [p.path, p.children.map((c) => c.type)])).toEqual([
      [[0], ["table"]],
    ]);
  });
});
