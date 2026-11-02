/**
 * 제목 · 블록 링크의 push (P6 · P14) — 대상 페이지의 블록을 읽어 Notion 블록 링크로 보낸다. 맨 위에 없으면 콜아웃 ·
 * 목록 자식까지. 같은 push 에서 생긴 대상 · 새 노트의 자기 링크는 push 뒤 패스가 다시 보낸다. 대상 페이지를 읽지
 * 못하면 예전처럼 글로 둔다. 읽는 페이지는 링크가 가리키는 페이지뿐이다.
 *
 * 실제 StateDB(임시 파일)와 메모리 볼트 · 메모리 Notion 으로(leading-divider-push 와 같은 하니스). 메모리 Notion
 * 은 블록을 모르므로 대상 페이지의 블록만 따로 준다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const HEADING = "a".repeat(32);
const SELF_HEADING = "b".repeat(32);
const NESTED_HEADING = "c".repeat(32);
const LATER_HEADING = "d".repeat(32);

describe("제목 · 블록 링크의 push", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let orchestrator: SyncOrchestrator;
  let unreadable: boolean;

  const compact = (path: string) => db.getByPath(path)!.notionPageId!.replace(/-/g, "");
  const bodyOf = (path: string) => notion.pages.get(db.getByPath(path)!.notionPageId!)!.body;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-anchor-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
    unreadable = false;
    const children = notion.client.fetchAllChildren.getMockImplementation()!;
    notion.client.fetchAllChildren.mockImplementation(async (parentId: string) => {
      const record = db
        .getAll()
        .find((r) => r.notionPageId?.replace(/-/g, "") === parentId.replace(/-/g, ""));
      if (record?.obsidianPath === "대상.md") {
        if (unreadable) throw new Error("Could not find block");
        return [
          {
            id: HEADING,
            type: "heading_2",
            heading_2: { rich_text: [{ plain_text: "둘째 제목" }] },
          },
        ];
      }
      if (record?.obsidianPath === "나중.md") {
        return [
          {
            id: LATER_HEADING,
            type: "heading_1",
            heading_1: { rich_text: [{ plain_text: "나중 제목" }] },
          },
        ];
      }
      if (record?.obsidianPath === "링크.md") {
        return [
          {
            id: SELF_HEADING,
            type: "heading_2",
            heading_2: { rich_text: [{ plain_text: "아래" }] },
          },
        ];
      }
      return children(parentId);
    });
    // 대상.md 의 콜아웃 속 제목 — 맨 위 블록에는 콜아웃만 보인다
    Object.assign(notion.client, {
      getBlockTree: vi.fn(async (parentId: string) => [
        ...(await notion.client.fetchAllChildren(parentId)),
        ...(db.getByPath("대상.md")?.notionPageId?.replace(/-/g, "") === parentId.replace(/-/g, "")
          ? [
              {
                id: "e".repeat(32),
                type: "callout",
                has_children: true,
                callout: { rich_text: [] },
                children: [
                  {
                    id: NESTED_HEADING,
                    type: "heading_3",
                    heading_3: { rich_text: [{ plain_text: "콜아웃 속" }] },
                  },
                ],
              },
            ]
          : []),
      ]),
    });
    orchestrator = new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: "root-page-id" },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );
    vault.write("대상.md", "## 둘째 제목\n\n본문\n");
    await orchestrator.push();
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("새 노트의 다른 노트 제목 링크는 블록 링크로 — 자기 제목은 같은 push 가 페이지를 만든 뒤 다시 보낸다", async () => {
    vault.write("링크.md", "[[대상#둘째 제목]] [[#아래]]\n\n## 아래\n");
    await orchestrator.push();

    expect(bodyOf("링크.md")).toContain(
      `[대상 > 둘째 제목](https://www.notion.so/${compact("대상.md")}#${HEADING})`,
    );
    expect(bodyOf("링크.md")).toContain(
      `[아래](https://www.notion.so/${compact("링크.md")}#${SELF_HEADING})`,
    );

    vault.write("링크.md", "[[대상#둘째 제목]] [[#아래|여기]]\n\n## 아래\n");
    await orchestrator.push();

    expect(bodyOf("링크.md")).toContain(
      `[여기](https://www.notion.so/${compact("링크.md")}#${SELF_HEADING})`,
    );
  });

  it("같은 push 에서 뒤에 만든 노트의 제목 링크도 블록 링크로", async () => {
    // 가.md 가 나중.md 보다 먼저 올라간다
    vault.write("가.md", "[[나중#나중 제목]]\n");
    vault.write("나중.md", "# 나중 제목\n");
    await orchestrator.push();

    expect(bodyOf("가.md")).toContain(
      `[나중 > 나중 제목](https://www.notion.so/${compact("나중.md")}#${LATER_HEADING})`,
    );
  });

  it("콜아웃 속 제목은 맨 위에 없으면 블록 트리에서 찾는다", async () => {
    vault.write("링크.md", "[[대상#콜아웃 속]] [[대상#둘째 제목]]\n");
    await orchestrator.push();

    expect(bodyOf("링크.md")).toContain(
      `[대상 > 콜아웃 속](https://www.notion.so/${compact("대상.md")}#${NESTED_HEADING})`,
    );
  });

  it("맨 위에서 모두 찾으면 블록 트리를 읽지 않는다", async () => {
    vault.write("링크.md", "[[대상#둘째 제목]]\n");
    await orchestrator.push();

    expect(
      (notion.client as unknown as { getBlockTree: ReturnType<typeof vi.fn> }).getBlockTree,
    ).not.toHaveBeenCalled();
  });

  it("없는 제목으로 가는 링크는 다시 보내지 않는다 — push 마다 되풀지 않는다", async () => {
    vault.write("링크.md", "[[대상#없는 제목]] [[#없는 자기 제목]]\n");
    expect(await orchestrator.push()).toMatchObject({ created: 1, updated: 0 });
    expect(bodyOf("링크.md")).toContain("[[대상#없는 제목]]");

    expect(await orchestrator.push()).toMatchObject({ created: 0, updated: 0 });
  });

  it("대상 페이지를 읽지 못하면 글로 남기고 push 는 성공한다", async () => {
    unreadable = true;
    vault.write("링크.md", "[[대상#둘째 제목]]\n");

    expect(await orchestrator.push()).toMatchObject({ created: 1, failed: [] });
    expect(bodyOf("링크.md")).toContain("[[대상#둘째 제목]]");
  });

  it("앵커 링크가 없으면 블록을 읽지 않는다", async () => {
    notion.client.fetchAllChildren.mockClear();
    vault.write("링크.md", "[[대상]] 그냥 링크\n");
    await orchestrator.push();

    const read = notion.client.fetchAllChildren.mock.calls.map(([id]) => id);
    expect(read).not.toContain(compact("대상.md"));
  });
});
