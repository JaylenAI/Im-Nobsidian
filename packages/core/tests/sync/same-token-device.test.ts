/**
 * 같은 토큰을 쓰는 다른 기기의 같은 분 쓰기 (P7) — 수정 시각은 분 단위라, 우리가 쓴 분 안에 다른 기기가 같은 토큰으로
 * 고치면 수정 시각 · 편집자가 우리 쓰기와 같다. 봇 규칙(«편집자가 그대로 이 봇이면 바뀌지 않았다», ADR-017)은 그 쓰기를
 * 놓쳐, pull 은 받지 않았고 push 는 그 위에 덮어썼다.
 *
 * 지난 본문 지문이 있으면 봇 규칙을 믿지 않고 내용으로 확인한다. 지문이 없으면(만든 뒤 다시 맞추지 않은 페이지) 예전처럼
 * 봇 규칙으로 가른다 — 확인할 것이 없다.
 *
 * 기기 둘: 볼트 · 상태 DB 는 따로, Notion(같은 토큰 · 같은 봇)은 하나.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { Config, DatabaseSyncConfig } from "../../src/types/config.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DAY = "2026-10-31";
const ROW_DB_ID = "db000000-0000-4000-8000-0000000000f4";
const ROW_DB: DatabaseSyncConfig = {
  databaseId: ROW_DB_ID,
  localFolder: "Tasks",
  titleProperty: "Name",
};

function at(hms: string): void {
  vi.setSystemTime(new Date(`${DAY}T${hms}.000Z`));
}

function config(): Config {
  return createConfig({
    notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases: [ROW_DB] },
    advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0, maxRetries: 0 },
  });
}

describe("같은 토큰을 쓰는 다른 기기의 같은 분 쓰기", () => {
  let tempDir: string;
  let notion: ReturnType<typeof memoryNotion>;
  const devices: { db: StateDB; vault: MemoryVault; sync: SyncOrchestrator }[] = [];

  function device() {
    const db = StateDB.open(join(tempDir, `state-${devices.length}.db`));
    const vault = new MemoryVault();
    const sync = new SyncOrchestrator(config(), db, notion.client as never, vault.fs());
    const made = { db, vault, sync };
    devices.push(made);
    return made;
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-same-token-"));
    notion = memoryNotion({ minuteClock: true });
    notion.client.getDatabaseSchema.mockResolvedValue({
      Name: { id: "title", type: "title" },
      Memo: { id: "memo", type: "rich_text" },
    });
    notion.client.getDatabaseViewsConfig.mockResolvedValue({
      databaseId: ROW_DB_ID,
      lastSynced: "",
      views: [],
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const made of devices.splice(0)) made.db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  /**
   * 기기 A 가 노트를 만들어 한 번 고쳐 올리고(지문을 적는다) · 기기 B 가 받아, 같은 분 안에 B 가 고쳐 올린다.
   * A 의 기록은 그 분 · 이 봇이 마지막으로 고쳤다고 적혀 있다.
   */
  async function deviceBWritesInSameMinute() {
    const a = device();
    const b = device();
    at("10:00:05");
    a.vault.write("Note.md", "첫 줄\n\n끝 줄\n");
    await a.sync.push();
    at("10:01:05");
    a.vault.write("Note.md", "첫 줄 A\n\n끝 줄\n");
    expect(await a.sync.push()).toMatchObject({ updated: 1, failed: [] });
    expect(a.db.getByPath("Note.md")!.notionBodyFingerprint).not.toBeNull();
    at("10:01:15");
    expect(await b.sync.pull()).toMatchObject({ created: 1, failed: [] });
    at("10:01:30");
    b.vault.write("Note.md", b.vault.read("Note.md")!.replace("끝 줄", "끝 줄 B"));
    expect(await b.sync.push()).toMatchObject({ updated: 1, failed: [] });
    const pageId = a.db.getByPath("Note.md")!.notionPageId!;
    expect(notion.pages.get(pageId)!.body).toContain("끝 줄 B");
    at("10:01:50");
    return { a, b, pageId };
  }

  it("A 의 pull 은 B 의 쓰기를 받는다", async () => {
    const { a } = await deviceBWritesInSameMinute();

    expect(await a.sync.pull()).toMatchObject({ updated: 1, conflicts: [], failed: [] });
    expect(a.vault.read("Note.md")).toContain("끝 줄 B");
  });

  it("A 의 push 는 B 의 쓰기를 덮지 않고 pull 을 먼저 하라 한다", async () => {
    const { a, pageId } = await deviceBWritesInSameMinute();
    a.vault.write("Note.md", "첫 줄 A 또\n\n끝 줄\n");

    const pushed = await a.sync.push();

    expect(pushed.failed).toEqual([
      expect.objectContaining({ path: "Note.md", error: expect.stringContaining("pull") }),
    ]);
    expect(notion.pages.get(pageId)!.body).toContain("끝 줄 B");
  });

  it("같은 분 안의 내 쓰기만 있으면 예전처럼 다시 받지 않고 바로 올린다", async () => {
    const a = device();
    at("10:00:05");
    a.vault.write("Note.md", "첫 줄\n\n끝 줄\n");
    await a.sync.push();
    at("10:01:05");
    a.vault.write("Note.md", "첫 줄 A\n\n끝 줄\n");
    await a.sync.push();
    at("10:01:20");

    expect(await a.sync.pull()).toMatchObject({ updated: 0, conflicts: [] });
    a.vault.write("Note.md", "첫 줄 A 또\n\n끝 줄\n");
    expect(await a.sync.push()).toMatchObject({ updated: 1, failed: [] });
  });

  /**
   * 두 기기가 같은 행을 받아 두고, 같은 분 안에 B 가 행을 고쳐 올린다. pull --dry-run 은 행 본문을 받지 않고 세므로
   * 실제 pull 처럼 내용으로 확인해야 같은 수를 낸다.
   */
  async function deviceBEditsRowInSameMinute(edit: ((content: string) => string) | null) {
    const a = device();
    const b = device();
    at("10:00:05");
    const row = notion.add(ROW_DB_ID, "Task", "행 본문", {
      properties: { Memo: { rich_text: [{ text: { content: "메모" } }] } },
    });
    at("10:00:10");
    expect(await a.sync.pull()).toMatchObject({ created: 1, failed: [] });
    expect(await b.sync.pull()).toMatchObject({ created: 1, failed: [] });
    const path = a.db.getByNotionId(row.id)!.obsidianPath;
    at("10:00:30");
    if (edit) {
      b.vault.write(path, edit(b.vault.read(path)!));
      expect(await b.sync.push()).toMatchObject({ updated: 1, failed: [] });
    }
    at("10:00:50");
    return { a, path };
  }

  it("DB 행 — B 가 같은 분에 고친 본문을 A 의 pull --dry-run 도 받을 것으로 센다", async () => {
    const { a, path } = await deviceBEditsRowInSameMinute((c) => c.replace("행 본문", "행 본문 B"));

    expect(await a.sync.pull({ dryRun: true })).toMatchObject({ updated: 1, failed: [] });
    expect(await a.sync.pull()).toMatchObject({ updated: 1, failed: [] });
    expect(a.vault.read(path)).toContain("행 본문 B");
  });

  it("DB 행 — B 가 같은 분에 속성만 고쳐도 A 의 pull --dry-run 이 센다", async () => {
    const { a, path } = await deviceBEditsRowInSameMinute((c) =>
      c.replace("Memo: 메모", "Memo: 메모 B"),
    );

    expect(await a.sync.pull({ dryRun: true })).toMatchObject({ updated: 1, failed: [] });
    expect(await a.sync.pull()).toMatchObject({ updated: 1, failed: [] });
    expect(a.vault.read(path)).toContain("메모 B");
  });

  it("DB 행 — 같은 분 안의 봇 쓰기가 받아 둔 그대로면 pull --dry-run 도 세지 않는다", async () => {
    const { a } = await deviceBEditsRowInSameMinute(null);

    expect(await a.sync.pull({ dryRun: true })).toMatchObject({ updated: 0, failed: [] });
    expect(await a.sync.pull()).toMatchObject({ updated: 0, failed: [] });
  });
});
