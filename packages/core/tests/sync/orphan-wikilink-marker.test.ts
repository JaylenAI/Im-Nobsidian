/**
 * Notion 에서 지운 문단의 위키링크 보존 마커(P2).
 *
 * 볼트 밖 노트를 가리키는 위키링크(`[[없는 노트]]`)는 Notion 에 링크로 올라가고, 링크가 사라졌을 때를 위한 보존
 * 마커가 상태 DB 에 남는다. Notion 에서 그 문단을 지우면 pull 이 그 마커를 숨은 줄(`%% …wikilink:… %%`)로
 * 되살렸다 — 링크는 돌아오지 않고 볼 수 없는 찌꺼기만 남았다. 사람이 Notion 에서 지운 링크다.
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

describe("Notion 에서 지운 문단의 위키링크", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  const build = (): SyncOrchestrator =>
    new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases: [] },
        sync: { ...DEFAULT_CONFIG.sync, deleteSync: true },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-orphan-wikilink-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("문단과 함께 링크가 사라지면 마커 줄을 남기지 않는다", async () => {
    const orchestrator = build();
    vault.write(
      "노트.md",
      "첫 문단입니다.\n\n지울 문단 [[볼트에 없는 노트]] 입니다.\n\n끝 문단입니다.\n",
    );
    expect(await orchestrator.push()).toMatchObject({ created: 1, failed: [] });
    const id = db.getByPath("노트.md")!.notionPageId!;

    notion.edit(id, (page) => {
      page.body = page.body
        .split("\n")
        .filter((line) => !line.includes("지울 문단"))
        .join("\n");
    });
    expect(await orchestrator.pull()).toMatchObject({ updated: 1, failed: [] });

    const pulled = vault.read("노트.md")!;
    expect(pulled).not.toContain("지울 문단");
    expect(pulled).not.toContain("wikilink");
    expect(pulled).toContain("첫 문단입니다.");
    expect(pulled).toContain("끝 문단입니다.");

    // 다음 push 가 찌꺼기를 Notion 에 올리지 않는다.
    expect(await orchestrator.push()).toMatchObject({ updated: 0, failed: [] });
  });

  it("남은 문단의 위키링크는 그대로 돌아온다", async () => {
    const orchestrator = build();
    vault.write("노트.md", "첫 문단 [[볼트에 없는 노트]] 입니다.\n\n지울 문단입니다.\n");
    await orchestrator.push();
    const id = db.getByPath("노트.md")!.notionPageId!;

    notion.edit(id, (page) => {
      page.body = page.body
        .split("\n")
        .filter((line) => !line.includes("지울 문단"))
        .join("\n");
    });
    await orchestrator.pull();

    expect(vault.read("노트.md")).toContain("첫 문단 [[볼트에 없는 노트]] 입니다.");
    expect(vault.read("노트.md")).not.toContain("%%");
  });
});
