/**
 * rank10 — block-API fallback push 경로(preferMarkdownApi=false)가 I11 구조 제약을
 * **오케스트레이터 배선 수준**에서 무손실로 우회함을 잠근다.
 *
 * 기본 push 경로(preferMarkdownApi=true)는 Notion 네이티브 Markdown API 가 배치·중첩을
 * 알아서 처리한다. fallback 경로는 `markdownToNotionBlocks` → `appendChildren` 로 가며,
 * 이때 normalizeBlocksForNotion 의 평탄화·청킹이 실제로 적용되어 Notion 제약(리스트 3단계·
 * 테이블 100행)을 넘지 않아야 한다. 변환기 단독 테스트(structural-constraints.test.ts)와 달리
 * 본 테스트는 **오케스트레이터가 fallback 경로로 라우팅하고, append 되는 블록이 제약을 만족**
 * 함을 모킹된 NotionClient 의 호출 인자로 직접 검증한다(배선 회귀 잠금).
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

const NOTION_MAX_LIST_DEPTH = 3;
const NOTION_MAX_TABLE_ROWS = 100;

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

/** preferMarkdownApi=false 로 새 파일을 push 하고, append 된 모든 블록 배열을 모은다. */
async function pushFallbackAndCaptureBlocks(markdown: string): Promise<Block[]> {
  const config = createConfig({
    conversion: { ...DEFAULT_CONFIG.conversion, preferMarkdownApi: false },
  });
  const mockVaultFs = createMockVaultFs();
  const mockStateDb = createMockStateDb();
  const mockNotionClient = createMockNotionClient();
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

  // Markdown API 우회 → block-API 경로 확정(이 배선이 깨지면 평탄화가 적용되지 않는다).
  expect(mockNotionClient.createPageWithMarkdown).not.toHaveBeenCalled();
  expect(mockNotionClient.createPage).toHaveBeenCalled();
  expect(mockNotionClient.appendChildren).toHaveBeenCalled();

  // appendChildren(pageId, blocks) 호출들의 블록을 모두 모은다.
  return (mockNotionClient.appendChildren as ReturnType<typeof vi.fn>).mock.calls.flatMap(
    (c) => c[1] as Block[],
  );
}

describe("I11 block-API fallback push 배선 (preferMarkdownApi=false, rank10)", () => {
  it("5단계 중첩 리스트가 fallback push 에서 3단계로 평탄화되며 항목 손실 0", async () => {
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

    // 어떤 체인도 Notion 3단계 제약을 넘지 않는다.
    expect(Math.max(...listRoots.map((b) => maxEdgeDepth(b)))).toBeLessThanOrEqual(
      NOTION_MAX_LIST_DEPTH,
    );
    // 5개 항목 전수 보존(평탄화가 잘라내기로 퇴화하지 않았다).
    expect(collectListTexts(listRoots).sort()).toEqual(["L0", "L1", "L2", "L3", "L4"]);
  });

  it("150행 테이블이 fallback push 에서 ≤100행 table 들로 청킹되며 행 손실 0", async () => {
    const DATA_ROWS = 150;
    const header = "| A | B |\n| --- | --- |";
    const body = Array.from({ length: DATA_ROWS }, (_, i) => `| a${i} | b${i} |`).join("\n");
    const md = `# Big Table\n\n${header}\n${body}`;

    const appended = await pushFallbackAndCaptureBlocks(md);
    const tables = appended.filter((b) => b.type === "table");
    // 청킹이 실제로 일어났다(단일 테이블 아님).
    expect(tables.length).toBeGreaterThan(1);

    const dataFirstCells: string[] = [];
    for (const t of tables) {
      const table = t.table as { has_column_header: boolean; children: Block[] };
      expect(table.children.length).toBeLessThanOrEqual(NOTION_MAX_TABLE_ROWS);
      expect(table.has_column_header).toBe(true);
      for (const row of table.children.slice(1)) {
        const tr = (row as Block).table_row as {
          cells?: Array<Array<{ text?: { content?: string } }>>;
        };
        dataFirstCells.push(tr?.cells?.[0]?.[0]?.text?.content ?? "");
      }
    }

    // 데이터 행 전수 보존: a0..a149 정확히 1회씩.
    const expected = Array.from({ length: DATA_ROWS }, (_, i) => `a${i}`);
    expect(dataFirstCells.sort()).toEqual([...expected].sort());
    expect(dataFirstCells.length).toBe(DATA_ROWS);
    expect(new Set(dataFirstCells).size).toBe(DATA_ROWS);
  });
});
