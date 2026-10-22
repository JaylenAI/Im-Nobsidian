/**
 * 동기화 블록 참조가 든 노트를 새로 만든다 — 2026-10-22 실데이터 E2E.
 *
 * Notion 은 `<synced_block_reference>` 가 든 markdown 으로 페이지를 만들지 못한다(`Block not found in record
 * map`). 본문 교체(`replace_content`)는 받고 참조도 남긴다(실측). 볼트 사본을 새 루트로 올리자 참조가 든
 * 폴더 노트 13개가 실패했고, 그 아래 노트 1,133개가 폴더 페이지가 없어 함께 실패했다.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { SYNCED_END, syncedStartMarker } from "../../src/constants/markers.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const SOURCE =
  "https://www.notion.so/p/11111111111141118111111111111111#22222222222242228222222222222222";
const note = (lead: string) =>
  `${lead}${syncedStartMarker("ref", SOURCE)}\nShared text\n${SYNCED_END}\n\nAfter\n`;

describe("동기화 블록 참조가 든 노트를 새로 만든다", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let orchestrator: SyncOrchestrator;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-synced-ref-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
    orchestrator = new SyncOrchestrator(
      createConfig({ advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 } }),
      db,
      notion.client as never,
      vault.fs(),
    );
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const pageOf = (path: string) => notion.pages.get(db.getByPath(path)!.notionPageId!)!;

  it("빈 페이지로 만든 뒤 본문 교체로 채워 참조를 남긴다", async () => {
    vault.write("notes/S.md", note("Intro\n\n"));

    const result = await orchestrator.push();

    expect(result).toMatchObject({ created: 1, failed: [] });
    expect(pageOf("notes/S.md").body).toContain(`<synced_block_reference url="${SOURCE}">`);
    expect(pageOf("notes/S.md").body).toContain("After");
    expect(notion.client.createPageWithMarkdown.mock.calls[0]![0].markdown).toBe("");
    expect(db.getByPath("notes/S.md")).toMatchObject({ status: "synced" });
    expect(db.getByPath("notes/S.md")!.notionLastEdited).toBe(pageOf("notes/S.md").lastEdited);
    expect(await orchestrator.push()).toMatchObject({ created: 0, updated: 0, failed: [] });
  });

  it("폴더 노트가 참조를 담아도 그 아래 노트까지 만든다", async () => {
    vault.write("Folder/Folder.md", note("# Folder\n\n"));
    vault.write("Folder/Child.md", "Child body\n");

    const result = await orchestrator.push();

    expect(result).toMatchObject({ created: 2, failed: [] });
    expect(pageOf("Folder/Folder.md").body).toMatch(/^# Folder\n/);
    expect(pageOf("Folder/Child.md").parent).toBe(pageOf("Folder/Folder.md").id);
  });

  it("참조가 없는 노트는 예전처럼 한 번에 만든다", async () => {
    vault.write("notes/P.md", "Plain\n");

    await orchestrator.push();

    expect(notion.client.createPageWithMarkdown.mock.calls[0]![0].markdown).toContain("Plain");
    expect(notion.client.replacePageMarkdown).not.toHaveBeenCalled();
  });
});
