/**
 * 동기화 블록 참조가 든 노트를 올린다 — 2026-10-22 실데이터 E2E.
 *
 * Notion 은 `<synced_block_reference>` 가 든 markdown 으로 페이지를 만들지 못한다(`Block not found in record
 * map`). 볼트 사본을 새 루트로 올리자 참조가 든 폴더 노트 13개가 실패했고, 그 아래 노트 1,133개가 폴더
 * 페이지가 없어 함께 실패했다. 본문 교체로 보내면 만들어지지만, Notion 이 다른 페이지에 있는 원본 동기화
 * 블록을 보낸 내용으로 다시 쓴다(실측 — 사용자의 실제 페이지 넷이 다시 쓰였다). 참조는 Markdown API 로
 * 보내지 않고 본문을 쓴 뒤 블록으로 붙인다.
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
import { MemoryVault, SYNCED_ORIGINAL_TEXT, memoryNotion } from "../helpers/memory-sync.js";

const SOURCE =
  "https://www.notion.so/p/11111111111141118111111111111111#22222222222242228222222222222222";
const note = (lead: string) =>
  `${lead}${syncedStartMarker("ref", SOURCE)}\nShared text\n${SYNCED_END}\n\nAfter\n`;

const SOURCE_BLOCK = "22222222-2222-4222-8222-222222222222";

describe("동기화 블록 참조가 든 노트를 올린다", () => {
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

  /** Markdown API 로 보낸 본문 모두 — 참조가 들면 Notion 이 원본을 다시 쓴다. */
  const sentMarkdown = () => [
    ...notion.client.createPageWithMarkdown.mock.calls.map((c) => c[0].markdown as string),
    ...notion.client.replacePageMarkdown.mock.calls.map((c) => c[1] as string),
  ];

  it("참조를 보내지 않고 만든 뒤 블록으로 붙인다 — 원본을 다시 쓰지 않는다", async () => {
    vault.write("notes/S.md", note("Intro\n\n"));

    const result = await orchestrator.push();

    expect(result).toMatchObject({ created: 1, failed: [] });
    for (const markdown of sentMarkdown()) {
      expect(markdown).not.toContain("synced_block_reference");
      expect(markdown).not.toContain("Shared text");
    }
    expect(notion.client.appendChildren).toHaveBeenCalledWith(
      pageOf("notes/S.md").id,
      [
        {
          type: "synced_block",
          synced_block: { synced_from: { type: "block_id", block_id: SOURCE_BLOCK } },
        },
      ],
      { after: expect.stringContaining("deferred-synced-ref:0") },
    );
    const body = pageOf("notes/S.md").body;
    expect(body).toContain(`#${SOURCE_BLOCK.replace(/-/g, "")}">\n\t${SYNCED_ORIGINAL_TEXT}`);
    expect(body).not.toContain("deferred-synced-ref");
    expect(body.indexOf("Intro")).toBeLessThan(body.indexOf("synced_block_reference"));
    expect(body.indexOf("synced_block_reference")).toBeLessThan(body.indexOf("After"));
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

  it("고친 노트를 올려도 참조 안은 보내지 않는다 — 참조 안의 글은 원본이 주인이다", async () => {
    vault.write("notes/S.md", note("Intro\n\n"));
    await orchestrator.push();
    notion.client.replacePageMarkdown.mockClear();
    notion.client.appendChildren.mockClear();

    vault.write(
      "notes/S.md",
      `Intro 2\n\n${syncedStartMarker("ref", SOURCE)}\nLocal edit\n${SYNCED_END}\n\nAfter\n`,
    );
    const result = await orchestrator.push();

    expect(result).toMatchObject({ updated: 1, failed: [] });
    for (const markdown of sentMarkdown()) {
      expect(markdown).not.toContain("synced_block_reference");
      expect(markdown).not.toContain("Local edit");
    }
    expect(notion.client.appendChildren).toHaveBeenCalledTimes(1);
    expect(pageOf("notes/S.md").body).toContain("Intro 2");
    expect(pageOf("notes/S.md").body).toContain(SYNCED_ORIGINAL_TEXT);
    expect(await orchestrator.push()).toMatchObject({ created: 0, updated: 0, failed: [] });
  });

  it("참조가 없는 노트는 예전처럼 한 번에 만든다", async () => {
    vault.write("notes/P.md", "Plain\n");

    await orchestrator.push();

    expect(notion.client.createPageWithMarkdown.mock.calls[0]![0].markdown).toContain("Plain");
    expect(notion.client.replacePageMarkdown).not.toHaveBeenCalled();
  });
});
