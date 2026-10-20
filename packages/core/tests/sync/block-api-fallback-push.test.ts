/**
 * rank10 — block-API fallback push 경로(preferMarkdownApi=false)가 깊은 목록 · 큰 표를 잃지 않고
 * **오케스트레이터 배선 수준**에서 블록 트리로 넘기는지 잠근다.
 *
 * 블록 방식은 Markdown API 경로와 같은 NFM 을 블록으로 만들어(`nfmToBlocks`) `appendBlockTree` 로
 * 보낸다(ADR-035). 깊이 · 개수 한도는 보내는 쪽(`appendBlockTree`)이 요청을 나눠 지키므로 여기서는
 * 트리가 원래 모양 그대로(목록 5단계 · 표 150행 한 개) 넘어가는지 본다. 요청 나누기는
 * `tests/notion/append-block-tree.test.ts` 가 본다.
 */
import { describe, it, expect, vi } from "vitest";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import {
  createMockVaultFs,
  createMockStateDb,
  createMockNotionClient,
  createConfig,
} from "../helpers/mock-orchestrator.js";

type Block = Record<string, unknown>;

/** 리스트 블록의 첫 rich_text content. */
function listText(block: Block): string {
  const data = block[block.type as string] as {
    rich_text?: Array<{ text?: { content?: string } }>;
  };
  return data?.rich_text?.[0]?.text?.content ?? "";
}
/** 리스트 트리 전체 항목 텍스트 수집(평탄화 후 손실 검출). */
function collectListTexts(blocks: Block[], acc: string[] = []): string[] {
  for (const b of blocks) {
    if (typeof b.type !== "string") continue;
    if (b.type.includes("list_item")) acc.push(listText(b));
    const data = b[b.type as string] as { children?: Block[] } | undefined;
    if (Array.isArray(data?.children)) collectListTexts(data!.children!, acc);
  }
  return acc;
}
/** children 체인 최대 간선 깊이(루트=0). */
function maxEdgeDepth(block: Block, depth = 0): number {
  const data = block[block.type as string] as { children?: Block[] } | undefined;
  if (!Array.isArray(data?.children) || data!.children!.length === 0) return depth;
  return Math.max(...data!.children!.map((c) => maxEdgeDepth(c, depth + 1)));
}

/** preferMarkdownApi=false 로 새 파일을 push 하고, 보낸 블록 트리를 모은다. */
async function pushFallbackAndCaptureBlocks(
  markdown: string,
  setup: (stateDb: ReturnType<typeof createMockStateDb>) => void = () => {},
): Promise<Block[]> {
  const config = createConfig({
    conversion: { ...DEFAULT_CONFIG.conversion, preferMarkdownApi: false },
  });
  const mockVaultFs = createMockVaultFs();
  const mockStateDb = createMockStateDb();
  const mockNotionClient = createMockNotionClient();
  setup(mockStateDb);
  const orchestrator = new SyncOrchestrator(
    config,
    mockStateDb as never,
    mockNotionClient as never,
    mockVaultFs,
  );

  const now = "2026-05-30T00:00:00.000Z";
  (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
    { path: "deep.md", mtime: now, size: markdown.length },
  ]);
  (mockVaultFs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(markdown);

  const result = await orchestrator.push();
  expect(result.created).toBe(1);

  // Markdown API 우회 → block-API 경로 확정.
  expect(mockNotionClient.createPageWithMarkdown).not.toHaveBeenCalled();
  expect(mockNotionClient.createPage).toHaveBeenCalled();
  expect(mockNotionClient.appendBlockTree).toHaveBeenCalled();

  return (mockNotionClient.appendBlockTree as ReturnType<typeof vi.fn>).mock.calls.flatMap(
    (c) => c[1] as Block[],
  );
}

describe("I11 block-API fallback push 배선 (preferMarkdownApi=false, rank10)", () => {
  it("5단계 중첩 목록이 그 모양 그대로 넘어가며 항목 손실 0", async () => {
    const md = [
      "# Deep Page",
      "",
      "- L0",
      "    - L1",
      "        - L2",
      "            - L3",
      "                - L4",
    ].join("\n");

    const appended = await pushFallbackAndCaptureBlocks(md);
    const listRoots = appended.filter((b) => b.type === "bulleted_list_item");
    expect(listRoots.length).toBe(1);

    // 평탄화하지 않는다 — 깊이는 appendBlockTree 가 나눠 보낸다.
    expect(maxEdgeDepth(listRoots[0]!)).toBe(4);
    expect(collectListTexts(listRoots)).toEqual(["L0", "L1", "L2", "L3", "L4"]);
  });

  it("150행 표가 표 하나로 넘어가며 행 손실 0", async () => {
    const DATA_ROWS = 150;
    const header = "| A | B |\n| --- | --- |";
    const body = Array.from({ length: DATA_ROWS }, (_, i) => `| a${i} | b${i} |`).join("\n");
    const md = `# Big Table\n\n${header}\n${body}`;

    const appended = await pushFallbackAndCaptureBlocks(md);
    const tables = appended.filter((b) => b.type === "table");
    expect(tables).toHaveLength(1);

    const table = tables[0]!.table as { has_column_header: boolean; children: Block[] };
    expect(table.has_column_header).toBe(true);
    const dataFirstCells = table.children.slice(1).map((row) => {
      const tr = (row as Block).table_row as {
        cells?: Array<Array<{ text?: { content?: string } }>>;
      };
      return tr?.cells?.[0]?.[0]?.text?.content ?? "";
    });
    expect(dataFirstCells).toEqual(Array.from({ length: DATA_ROWS }, (_, i) => `a${i}`));
  });

  it("위키링크는 페이지 멘션으로 넘어간다 — 글로 바뀌지 않는다 (C14)", async () => {
    const target = "3f713b18-d382-813e-9b95-c74b7d393a1d";
    const appended = await pushFallbackAndCaptureBlocks("[[콜아웃]] 링크", (stateDb) =>
      stateDb.resolveWikilink.mockImplementation((title: string) =>
        title === "콜아웃"
          ? { obsidianPath: "콜아웃.md", notionPageId: target, title: "콜아웃", aliases: [] }
          : null,
      ),
    );
    const paragraph = appended.find((b) => b.type === "paragraph")!;
    const [first] = (paragraph.paragraph as { rich_text: Block[] }).rich_text;
    expect(first).toMatchObject({ type: "mention", mention: { page: { id: target } } });
  });
});
