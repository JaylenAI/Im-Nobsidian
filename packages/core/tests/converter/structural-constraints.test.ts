/**
 * I11 구조 제약 무손실 push — 오프라인 결정론 잠금.
 *
 * Notion API 는 두 가지 구조 제약을 강제한다:
 *  1) table 은 append 당 최대 100 행(child block) 까지만 받는다.
 *  2) 리스트(bulleted/numbered/to_do)는 3 단계까지만 중첩을 허용한다.
 *
 * BlockConverter.markdownToNotionBlocks 의 normalizeBlocksForNotion 이 이 제약을
 * **무손실로 우회**한다: 100 행 초과 테이블은 헤더를 반복하며 여러 table 블록으로 청킹하고,
 * 3 단계 초과 중첩 리스트는 한계 깊이에서 더 깊은 후손을 형제로 평탄화한다. 어느 쪽도
 * 행·항목을 잘라내지 않아야 한다(잘라내면 Notion 에 침묵 유실).
 *
 * 이 테스트는 합성 블록 트리가 아니라 **실제 push 변환 경로(markdownToNotionBlocks)** 를
 * 그대로 태워 산출 블록을 검사한다 → 라이브 deep-nesting.invariant.test.ts 의 오프라인
 * 결정론 대응물. 가드 유효성: 제약 우회가 잘라내기로 퇴화하면(행/항목 손실) 개수 단언이
 * 깨진다. 청킹/평탄화 자체가 일어나지 않으면(>100행 단일 테이블 / 4단계 잔존) 구조 단언이
 * 깨진다.
 */
import { describe, it, expect } from "vitest";
import { BlockConverter } from "../../src/converter/block-converter.js";

// Notion 제약 상수(블록 변환기 내부 NOTION_MAX_* 와 동일 계약을 잠근다).
const NOTION_MAX_TABLE_ROWS = 100;
const NOTION_MAX_LIST_DEPTH = 3;

type Block = Record<string, unknown>;

/** 리스트 블록의 텍스트(첫 rich_text content)를 추출한다. */
function listText(block: Block): string {
  const data = block[block["type"] as string] as {
    rich_text?: Array<{ text?: { content?: string } }>;
  };
  return data?.rich_text?.[0]?.text?.content ?? "";
}

/** 리스트 트리를 순회하며 모든 항목 텍스트를 수집한다(평탄화 후 손실 검출용). */
function collectListTexts(blocks: Block[], acc: string[] = []): string[] {
  for (const b of blocks) {
    if (typeof b["type"] !== "string") continue;
    acc.push(listText(b));
    const data = b[b["type"] as string] as { children?: Block[] } | undefined;
    if (Array.isArray(data?.children)) collectListTexts(data!.children!, acc);
  }
  return acc;
}

/** 리스트 children 체인의 최대 간선 깊이(루트=0). 4 이상이면 3단계 제약 위반. */
function maxEdgeDepth(block: Block, depth = 0): number {
  const data = block[block["type"] as string] as { children?: Block[] } | undefined;
  if (!Array.isArray(data?.children) || data!.children!.length === 0) return depth;
  return Math.max(...data!.children!.map((c) => maxEdgeDepth(c, depth + 1)));
}

/** table_row 의 셀별 첫 텍스트를 추출한다. */
function rowCells(row: Block): string[] {
  const tr = row["table_row"] as
    | { cells?: Array<Array<{ text?: { content?: string } }>> }
    | undefined;
  return (tr?.cells ?? []).map((cell) => cell?.[0]?.text?.content ?? "");
}

describe("I11 구조 제약 무손실 push (오프라인 결정론)", () => {
  const conv = new BlockConverter();

  // ── 테이블 100행 초과 → 헤더 반복 청킹·행 손실 0 ─────────────────────────────
  it("150행 테이블은 헤더를 반복하며 ≤100행 table 블록들로 청킹되고 데이터 행을 잃지 않는다", () => {
    const DATA_ROWS = 150;
    const header = "| A | B |\n| --- | --- |";
    const body = Array.from({ length: DATA_ROWS }, (_, i) => `| a${i} | b${i} |`).join("\n");
    const blocks = conv.markdownToNotionBlocks(`${header}\n${body}`) as Block[];

    const tables = blocks.filter((b) => b["type"] === "table");
    // 청킹이 실제로 일어났다(단일 테이블 아님) — 150 > 100 이므로 2개 이상.
    expect(tables.length).toBeGreaterThan(1);

    const dataFirstCells: string[] = [];
    for (const t of tables) {
      const table = t["table"] as {
        table_width: number;
        has_column_header: boolean;
        children: Block[];
      };
      // 각 청크는 Notion 한계(100행) 이내.
      expect(table.children.length).toBeLessThanOrEqual(NOTION_MAX_TABLE_ROWS);
      // 헤더가 각 청크에 반복돼 표 의미가 보존된다.
      expect(table.has_column_header).toBe(true);
      expect(rowCells(table.children[0] as Block)).toEqual(["A", "B"]);
      expect(table.table_width).toBe(2);
      // 헤더를 제외한 데이터 행의 첫 셀을 모은다.
      for (const row of table.children.slice(1)) {
        dataFirstCells.push(rowCells(row as Block)[0] ?? "");
      }
    }

    // 데이터 행 전수 보존: a0..a149 정확히 1회씩, 손실·중복 0.
    const expected = Array.from({ length: DATA_ROWS }, (_, i) => `a${i}`);
    expect(dataFirstCells.sort()).toEqual([...expected].sort());
    expect(dataFirstCells.length).toBe(DATA_ROWS);
    expect(new Set(dataFirstCells).size).toBe(DATA_ROWS);
  });

  // ── 리스트 3단계 초과 중첩 → 한계 깊이에서 형제로 평탄화·항목 손실 0 ───────────
  it("5단계 중첩 리스트는 3단계로 평탄화되며 어떤 항목도 잃지 않는다", () => {
    const md = [
      "- L0",
      "    - L1",
      "        - L2",
      "            - L3",
      "                - L4",
    ].join("\n");
    const blocks = conv.markdownToNotionBlocks(md) as Block[];

    const listRoots = blocks.filter((b) => b["type"] === "bulleted_list_item");
    expect(listRoots.length).toBe(1);

    // 어떤 체인도 Notion 3단계 제약을 넘지 않는다(평탄화 전 원본은 4 간선).
    const depth = Math.max(...listRoots.map((b) => maxEdgeDepth(b)));
    expect(depth).toBeLessThanOrEqual(NOTION_MAX_LIST_DEPTH);

    // 5개 항목 L0..L4 전수 보존(평탄화가 잘라내기로 퇴화하지 않았다).
    const texts = collectListTexts(listRoots);
    expect(texts.sort()).toEqual(["L0", "L1", "L2", "L3", "L4"]);

    // 평탄화가 실제로 일어났다: 한계 깊이 노드가 후손(L3·L4)을 형제로 들고 있다.
    function hasSiblingFlatten(block: Block): boolean {
      const data = block[block["type"] as string] as { children?: Block[] } | undefined;
      const children = data?.children ?? [];
      const labels = children.map((c) => listText(c));
      if (labels.includes("L3") && labels.includes("L4")) return true;
      return children.some((c) => hasSiblingFlatten(c));
    }
    expect(hasSiblingFlatten(listRoots[0])).toBe(true);
  });
});
