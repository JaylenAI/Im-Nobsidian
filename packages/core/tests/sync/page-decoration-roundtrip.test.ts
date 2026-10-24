/**
 * 페이지의 아이콘 · 커버가 push · pull 을 거쳐 그대로 돌아오는지 끝까지 돌린다.
 *
 * 예전에는 페이지의 아이콘 · 커버를 받지도 보내지도 않았다 — 새 워크스페이스로 push 한 페이지에는 아이콘이
 * 없고, frontmatter 의 `icon` 은 본문 첫머리 속성 블록으로 갔다. 2026-10-23 라이브(nt 왕복): 별 · 노랑 아이콘의
 * 페이지를 받은 노트에 아이콘이 없었다.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { parseFrontmatter } from "../../src/utils/frontmatter.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const NOTE = `---
분류: 글
icon: star:yellow
cover: https://img.example/c.jpg
---
본문 한 줄.
`;

describe("페이지 아이콘 · 커버 왕복", () => {
  let tempDir: string;
  let notion: ReturnType<typeof memoryNotion>;
  const dbs: StateDB[] = [];

  const side = () => {
    const db = StateDB.open(join(tempDir, `state-${dbs.length}.db`));
    dbs.push(db);
    const vault = new MemoryVault();
    const orchestrator = new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases: [] },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );
    return { db, vault, orchestrator };
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-decoration-"));
    notion = memoryNotion();
  });

  afterEach(async () => {
    for (const db of dbs.splice(0)) db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("push 하면 페이지의 아이콘 · 커버가 되고 본문 속성 블록에는 없다", async () => {
    const a = side();
    a.vault.write("A.md", NOTE);
    expect(await a.orchestrator.push()).toMatchObject({ created: 1, failed: [] });

    const page = notion.pages.get(a.db.getByPath("A.md")!.notionPageId!)!;
    expect(page.icon).toEqual({ type: "icon", icon: { name: "star", color: "yellow" } });
    expect(page.cover).toEqual({
      type: "external",
      external: { url: "https://img.example/c.jpg" },
    });
    expect(page.body).toContain("분류: 글");
    expect(page.body).not.toContain("icon");
    expect(page.body).not.toContain("cover");
    expect(await a.orchestrator.push()).toMatchObject({ created: 0, updated: 0, failed: [] });
  });

  it("새 볼트로 받으면 같은 아이콘 · 커버가 frontmatter 에 적힌다", async () => {
    const a = side();
    a.vault.write("A.md", NOTE);
    await a.orchestrator.push();

    const b = side();
    expect(await b.orchestrator.pull()).toMatchObject({ created: 1, failed: [] });
    // 블록의 키 뒤에 아이콘 · 커버 — 행 노트와 같은 차례다.
    expect(parseFrontmatter(b.vault.read("A.md")!).data).toEqual({
      분류: "글",
      cover: "https://img.example/c.jpg",
      icon: "star:yellow",
    });
    expect(await b.orchestrator.push()).toMatchObject({ created: 0, updated: 0, failed: [] });
  });

  it("로컬에서 바꾸면 아이콘만 보내고, 지우면 지운다", async () => {
    const a = side();
    a.vault.write("A.md", NOTE);
    await a.orchestrator.push();
    const id = a.db.getByPath("A.md")!.notionPageId!;

    a.vault.write("A.md", NOTE.replace("star:yellow", "🥑"));
    expect(await a.orchestrator.push()).toMatchObject({ updated: 1, failed: [] });
    expect(notion.pages.get(id)!.icon).toEqual({ type: "emoji", emoji: "🥑" });

    a.vault.write("A.md", NOTE.replace("icon: star:yellow\n", ""));
    expect(await a.orchestrator.push()).toMatchObject({ updated: 1, failed: [] });
    expect(notion.pages.get(id)!.icon).toBeUndefined();
    expect(notion.pages.get(id)!.cover).toBeDefined();
  });

  it("Notion 에서 아이콘을 바꾸면 pull 이 받는다", async () => {
    const a = side();
    a.vault.write("A.md", NOTE);
    await a.orchestrator.push();
    const id = a.db.getByPath("A.md")!.notionPageId!;

    notion.edit(id, (page) => {
      page.icon = { type: "icon", icon: { name: "pizza", color: "gray" } };
    });
    expect(await a.orchestrator.pull()).toMatchObject({ updated: 1, failed: [] });
    expect(parseFrontmatter(a.vault.read("A.md")!).data.icon).toBe("pizza");
    expect(await a.orchestrator.push()).toMatchObject({ created: 0, updated: 0, failed: [] });
  });
});
