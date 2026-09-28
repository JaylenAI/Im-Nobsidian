/**
 * 변경 패널의 「되돌리기」 — 로컬 변경 하나를 지난 동기화 때의 글로 되돌린다(Git `restore`).
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

describe("SyncOrchestrator.discardLocalChange", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let orchestrator: SyncOrchestrator;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-discard-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
    orchestrator = new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases: [] },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );
    vault.write("Note.md", "# 노트\n\n처음 본문\n");
    await orchestrator.push();
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const changedPaths = async () =>
    (await orchestrator.statusLocal()).localChanges.map((c) => `${c.type} ${c.path}`);

  it("고친 노트를 지난 동기화 때의 글로 되돌린다 — 변경 목록에서 사라지고 Notion 은 그대로다", async () => {
    const pageId = db.getByPath("Note.md")!.notionPageId!;
    const remoteBefore = notion.pages.get(pageId)!.body;
    vault.write("Note.md", "# 노트\n\n실수로 고친 본문\n");
    expect(await changedPaths()).toEqual(["modified Note.md"]);

    await orchestrator.discardLocalChange("Note.md");

    expect(vault.read("Note.md")).toBe("# 노트\n\n처음 본문\n");
    expect(await changedPaths()).toEqual([]);
    expect(notion.pages.get(pageId)!.body).toBe(remoteBefore);
    await expect(orchestrator.push()).resolves.toMatchObject({ created: 0, updated: 0 });
  });

  it("되돌릴 원본이 없으면 이유와 함께 거절하고 파일을 건드리지 않는다", async () => {
    vault.write("New.md", "새 노트");
    await expect(orchestrator.discardLocalChange("New.md")).rejects.toThrow(
      /추적하지 않는 새 노트/,
    );
    expect(vault.read("New.md")).toBe("새 노트");
  });

  it("옮긴 노트의 새 자리는 새 노트라 하지 않고 옛 자리를 알린다 — 파일은 그대로다", async () => {
    vault.rename("Note.md", "Moved/Note.md");
    expect(await changedPaths()).toEqual(["moved Moved/Note.md"]);

    await expect(orchestrator.discardLocalChange("Moved/Note.md")).rejects.toThrow(
      "옮긴 노트는 되돌리기가 제자리로 돌리지 않습니다 — 파일을 Note.md 로 다시 옮기세요 (Moved/Note.md)",
    );
    expect(vault.read("Moved/Note.md")).toBe("# 노트\n\n처음 본문\n");
    expect(vault.files.has("Note.md")).toBe(false);

    // 옮긴 노트가 있어도 다른 새 노트는 새 노트라고 한다.
    vault.write("New.md", "새 노트");
    await expect(orchestrator.discardLocalChange("New.md")).rejects.toThrow(
      /추적하지 않는 새 노트/,
    );
  });

  it("지운 노트는 지난 동기화 때의 글로 되살린다", async () => {
    vault.files.delete("Note.md");
    expect(await changedPaths()).toEqual(["deleted Note.md"]);

    await orchestrator.discardLocalChange("Note.md");

    expect(vault.read("Note.md")).toBe("# 노트\n\n처음 본문\n");
    expect(await changedPaths()).toEqual([]);
  });

  it("도는 작업과 겹치지 않는다 — 되돌리기도 한 줄에 선다", async () => {
    vault.write("Note.md", "고침");
    const pushing = orchestrator.push();
    await expect(orchestrator.discardLocalChange("Note.md")).rejects.toMatchObject({
      running: "push",
      requested: "discard",
    });
    await pushing;
  });
});
