/**
 * 제목 · 블록 링크의 push (P6) — 대상 페이지의 맨 위 블록을 읽어 Notion 블록 링크로 보낸다. 대상 페이지를 읽지
 * 못하면 예전처럼 글로 둔다. 읽는 페이지는 링크가 가리키는 페이지뿐이다.
 *
 * 실제 StateDB(임시 파일)와 메모리 볼트 · 메모리 Notion 으로(leading-divider-push 와 같은 하니스). 메모리 Notion
 * 은 블록을 모르므로 대상 페이지의 블록만 따로 준다.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

  it("새 노트의 다른 노트 제목 링크는 블록 링크로 — 자기 제목은 페이지가 생긴 뒤 고칠 때", async () => {
    vault.write("링크.md", "[[대상#둘째 제목]] [[#아래]]\n\n## 아래\n");
    await orchestrator.push();

    expect(bodyOf("링크.md")).toContain(
      `[대상 > 둘째 제목](https://www.notion.so/${compact("대상.md")}#${HEADING})`,
    );
    expect(bodyOf("링크.md")).toContain("[[#아래]]");

    vault.write("링크.md", "[[대상#둘째 제목]] [[#아래|여기]]\n\n## 아래\n");
    await orchestrator.push();

    expect(bodyOf("링크.md")).toContain(
      `[여기](https://www.notion.so/${compact("링크.md")}#${SELF_HEADING})`,
    );
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
