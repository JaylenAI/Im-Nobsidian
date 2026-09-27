/**
 * N-06 — 충돌 해결이 Notion 에 닿지 않은 채 «해결됨» 으로 남으면 다음 sync 가 고른 것을 되돌린다.
 *
 * 해결은 지난 동기화 사본을 해결 결과로 바꿔 둔다. 그 결과가 Notion 에 없으면, 다음 pull 은 로컬을
 * «바뀌지 않은 것» 으로 보고 바뀐 원격으로 덮는다 — 사용자가 고른 로컬 · 병합 결과가 사라진다.
 *
 * - 해결은 오케스트레이터(`resolveConflict`)로 한다 — 고른 결과를 Notion 에 올린다. 플러그인은
 *   ConflictResolver 만 불러 올리지 않았다.
 * - 올리다 실패하면 충돌로 되돌린다 — 다음 pull 이 다시 충돌로 본다.
 * - 원격을 읽지 못하면 빈 원격으로 충돌을 만들지 않는다 — 빈 원격과 병합하면 원격이 모든 줄을
 *   지운 것이 된다.
 *
 * 실제 StateDB(임시 파일) · 메모리 볼트 · 메모리 Notion 으로 다음 sync 까지 돌린다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { Conflict } from "../../src/types/sync.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DAY = "2026-09-04";
const BASE = "첫 줄\n\n가운데\n\n끝 줄\n";
const LOCAL = "첫 줄 로컬\n\n가운데\n\n끝 줄\n";
const REMOTE = "첫 줄\n\n가운데\n\n끝 줄 원격";

/** 이 기기 시계를 `DAY` 의 그 시각으로 — 메모리 Notion 의 수정 시각도 이 시계를 따른다. */
function at(hms: string): void {
  vi.setSystemTime(new Date(`${DAY}T${hms}.000Z`));
}

const badGateway = () => Object.assign(new Error("bad gateway"), { status: 502 });

describe("N-06 충돌 해결은 Notion 에 닿아야 해결이다", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let orchestrator: SyncOrchestrator;
  let pageId: string;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00:05");
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-resolve-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion({ minuteClock: true });
    const config = createConfig({
      notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases: [] },
      sync: { ...DEFAULT_CONFIG.sync, deleteSync: true },
      advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0, maxRetries: 0 },
    });
    orchestrator = new SyncOrchestrator(config, db, notion.client as never, vault.fs());

    // 올리고 받아 둔 노트를 양쪽에서 고친다 — manual(기본) 이라 pull 이 충돌로 남긴다.
    vault.write("Note.md", BASE);
    await orchestrator.push();
    at("10:00:20");
    await orchestrator.pull();
    pageId = db.getByPath("Note.md")!.notionPageId!;
    at("10:02:00");
    vault.write("Note.md", LOCAL);
    notion.edit(pageId, (page) => {
      page.body = REMOTE;
    });
    at("10:03:00");
    expect((await orchestrator.pull()).conflicts).toHaveLength(1);
  });

  afterEach(async () => {
    vi.useRealTimers();
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function listed(): Promise<Conflict> {
    const conflicts = await orchestrator.listConflicts();
    expect(conflicts).toHaveLength(1);
    return conflicts[0]!;
  }

  /** 다음 sync — 플러그인의 자동 동기화 · Sync 버튼. */
  async function nextSync() {
    at("10:05:00");
    return orchestrator.sync();
  }

  it.each([
    ["local", LOCAL],
    ["duplicate", LOCAL],
  ] as const)("%s 로 고른 로컬은 Notion 에 올라가고 다음 sync 가 덮지 않는다", async (choice) => {
    await orchestrator.resolveConflict(await listed(), choice);

    const after = await nextSync();

    expect(vault.read("Note.md")).toBe(LOCAL);
    expect(notion.pages.get(pageId)!.body).toContain("첫 줄 로컬");
    expect(after.pull).toMatchObject({ updated: 0, conflicts: [] });
    expect(db.getByPath("Note.md")!.status).toBe("synced");
  });

  it("merge 로 합친 결과는 Notion 에 올라가고 다음 sync 가 덮지 않는다", async () => {
    const result = await orchestrator.resolveConflict(await listed(), "merge");
    expect(result.success).toBe(true);
    const merged = vault.read("Note.md")!;
    expect(merged).toContain("첫 줄 로컬");
    expect(merged).toContain("끝 줄 원격");

    const after = await nextSync();

    expect(vault.read("Note.md")).toBe(merged);
    expect(notion.pages.get(pageId)!.body).toContain("첫 줄 로컬");
    expect(after.pull).toMatchObject({ updated: 0, conflicts: [] });
  });

  it("remote 로 고르면 원격을 받고 다음 sync 는 할 일이 없다", async () => {
    await orchestrator.resolveConflict(await listed(), "remote");

    const after = await nextSync();

    expect(vault.read("Note.md")).toContain("끝 줄 원격");
    expect(vault.read("Note.md")).not.toContain("첫 줄 로컬");
    expect(after.pull).toMatchObject({ updated: 0, conflicts: [] });
    expect(after.push).toMatchObject({ created: 0, updated: 0, deleted: 0 });
  });

  it("Notion 에 올리지 못하면 충돌로 남고, 다음 sync 가 로컬 편집을 덮지 않는다", async () => {
    notion.client.replacePageMarkdown.mockRejectedValueOnce(badGateway());

    await expect(orchestrator.resolveConflict(await listed(), "local")).rejects.toThrow(
      "bad gateway",
    );
    expect(db.getByPath("Note.md")!.status).toBe("conflict");

    const after = await nextSync();

    expect(vault.read("Note.md")).toBe(LOCAL);
    expect(after.conflicts.map((c) => c.syncRecord.obsidianPath)).toEqual(["Note.md"]);
    // 다시 고르면 이번에는 올라간다.
    await orchestrator.resolveConflict(await listed(), "local");
    expect(notion.pages.get(pageId)!.body).toContain("첫 줄 로컬");
  });

  it("병합 결과를 올리지 못하면 충돌로 남고, 병합한 파일은 다음 sync 가 덮지 않는다", async () => {
    notion.client.replacePageMarkdown.mockRejectedValueOnce(badGateway());

    await expect(orchestrator.resolveConflict(await listed(), "merge")).rejects.toThrow(
      "bad gateway",
    );
    const merged = vault.read("Note.md")!;

    const after = await nextSync();

    expect(vault.read("Note.md")).toBe(merged);
    expect(after.conflicts).toHaveLength(1);
  });

  it("원격을 읽지 못하면 빈 원격으로 충돌을 만들지 않고 이유와 함께 실패한다", async () => {
    notion.client.getPage.mockRejectedValue(badGateway());

    await expect(orchestrator.listConflicts()).rejects.toThrow(/Note\.md.*bad gateway/);
    expect(vault.read("Note.md")).toBe(LOCAL);
    expect(db.getByPath("Note.md")!.status).toBe("conflict");
  });
});
