/**
 * Notion 에서 지운 폴더 페이지의 빈 폴더(P2).
 *
 * 하위 페이지가 있는 페이지는 볼트에서 폴더 노트(`상위/상위.md`)로 받는다. Notion 에서 그 페이지를 지우면 pull 이
 * 노트들은 지웠지만 폴더는 남겼다 — 볼트에 빈 폴더가 쌓였다. 이제 pull 이 마칠 때 지운 페이지의 폴더가 비었으면
 * 지운다. 사용자가 넣은 파일이 남아 있으면 둔다.
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

describe("Notion 에서 지운 폴더 페이지", () => {
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
  /** Notion 에서 사람이 휴지통에 넣는다 — 부모를 넣으면 그 아래도 휴지통이다(실측 2026-10-28). */
  const trash = (...ids: string[]): void => {
    for (const id of ids) {
      notion.edit(id, (page) => {
        page.archived = true;
      });
    }
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-deleted-folder-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  /** 상위 › 하위 › 손자 — 받은 뒤 폴더 둘이 생긴다. */
  async function pulledTree(orchestrator: SyncOrchestrator) {
    const parent = notion.add("root-page-id", "상위", "본문");
    const child = notion.add(parent.id, "하위", "본문");
    const grandchild = notion.add(child.id, "손자", "본문");
    notion.add("root-page-id", "남길 노트", "본문");
    expect(await orchestrator.pull()).toMatchObject({ created: 4, failed: [] });
    expect(vault.folders.has("상위")).toBe(true);
    expect(vault.folders.has("상위/하위")).toBe(true);
    return { parent, child, grandchild };
  }

  it("지운 폴더 페이지의 폴더를 안쪽부터 지운다", async () => {
    const orchestrator = build();
    const { parent, child, grandchild } = await pulledTree(orchestrator);

    trash(parent.id, child.id, grandchild.id);
    expect(await orchestrator.pull()).toMatchObject({ deleted: 3, failed: [] });

    expect([...vault.files.keys()]).toEqual(["남길 노트.md"]);
    expect(vault.folders.has("상위/하위")).toBe(false);
    expect(vault.folders.has("상위")).toBe(false);
  });

  it("사용자가 넣은 파일이 남은 폴더는 둔다", async () => {
    const orchestrator = build();
    const { parent, child, grandchild } = await pulledTree(orchestrator);
    vault.write("상위/스케치.png", "png");

    trash(parent.id, child.id, grandchild.id);
    expect(await orchestrator.pull()).toMatchObject({ deleted: 3, failed: [] });

    expect(vault.read("상위/스케치.png")).toBe("png");
    expect(vault.folders.has("상위")).toBe(true);
    expect(vault.folders.has("상위/하위")).toBe(false);
  });

  it("하위 페이지 하나만 지우면 상위 폴더는 그대로다", async () => {
    const orchestrator = build();
    const { child, grandchild } = await pulledTree(orchestrator);

    trash(child.id, grandchild.id);
    expect(await orchestrator.pull()).toMatchObject({ deleted: 2, failed: [] });

    expect(vault.read("상위/상위.md")).toBeDefined();
    expect(vault.folders.has("상위")).toBe(true);
    expect(vault.folders.has("상위/하위")).toBe(false);
  });

  it("dry-run 은 폴더를 지우지 않는다", async () => {
    const orchestrator = build();
    const { parent, child, grandchild } = await pulledTree(orchestrator);

    trash(parent.id, child.id, grandchild.id);
    await orchestrator.pull({ dryRun: true });

    expect(vault.folders.has("상위")).toBe(true);
    expect(vault.read("상위/상위.md")).toBeDefined();
  });
});
