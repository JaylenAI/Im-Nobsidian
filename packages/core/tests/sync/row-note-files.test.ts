/**
 * 행 이름의 폴더(`DB/행/`)의 파일 — 행 페이지 끝에 「📁 이름」 으로 왕복한다(ADR-056 을 행으로). 0.21 까지는 둘 곳이 없다며
 * 경고만 냈다. 행도 본문이 있는 페이지라 노트 이름의 폴더(`N.md` 옆 `N/`)와 같은 규칙을 쓴다. DB 폴더 바로 아래 파일은 여전히
 * 경고다 — Notion 의 DB 는 본문이 없다.
 *
 * 실제 StateDB(임시 파일) · 메모리 볼트 · 메모리 Notion 으로 두 볼트를 끝까지 돌린다.
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
import { setLogger } from "../../src/utils/logger.js";

const DAY = "2026-11-02";
const ROW_DB_ID = "db000000-0000-4000-8000-0000000000a1";
const ROW_DB: DatabaseSyncConfig = {
  databaseId: ROW_DB_ID,
  localFolder: "Tasks",
  titleProperty: "Name",
};

function at(hms: string): void {
  vi.setSystemTime(new Date(`${DAY}T${hms}.000Z`));
}

function config(renameOnTitleChange = false): Config {
  return createConfig({
    notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases: [ROW_DB] },
    sync: { ...DEFAULT_CONFIG.sync, deleteSync: true, renameOnTitleChange },
    advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0, maxRetries: 0 },
  });
}

describe("행 이름의 폴더의 파일 왕복", () => {
  let tempDir: string;
  let notion: ReturnType<typeof memoryNotion>;
  let warnings: string[];
  const devices: { db: StateDB; vault: MemoryVault; sync: SyncOrchestrator }[] = [];

  function device(renameOnTitleChange = false) {
    const db = StateDB.open(join(tempDir, `state-${devices.length}.db`));
    const vault = new MemoryVault();
    const fetchFn = vi.fn(async (url: string | URL) => {
      const bytes = notion.downloadOf(String(url));
      return bytes ? new Response(bytes) : new Response("gone", { status: 404 });
    });
    const sync = new SyncOrchestrator(
      config(renameOnTitleChange),
      db,
      notion.client as never,
      vault.fs(),
      fetchFn as unknown as typeof globalThis.fetch,
    );
    const made = { db, vault, sync };
    devices.push(made);
    return made;
  }
  const uploads = () => notion.client.uploadFile.mock.calls.length;
  const csvs = (vault: MemoryVault) =>
    [...vault.files.keys()].filter((p) => p.endsWith(".csv")).sort();

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00:05");
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-row-note-files-"));
    notion = memoryNotion({ minuteClock: true });
    notion.client.getDatabaseSchema.mockResolvedValue({ Name: { id: "title", type: "title" } });
    warnings = [];
    setLogger({ warn: (m) => warnings.push(m), error: () => {}, info: () => {}, debug: () => {} });
  });

  afterEach(async () => {
    vi.useRealTimers();
    setLogger({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} });
    for (const made of devices.splice(0)) made.db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  /** Notion 의 행 하나를 A 가 받아 그 행 이름의 폴더에 파일을 두고 올린다. */
  async function seeded() {
    const row = notion.add(ROW_DB_ID, "Task", "행 본문", {});
    const a = device();
    at("10:00:20");
    expect(await a.sync.pull()).toMatchObject({ created: 1, failed: [] });
    expect(a.vault.read("Tasks/Task.md")).toContain("행 본문");
    at("10:01:05");
    a.vault.write("Tasks/Task/data.csv", "a,b\n1,2\n");
    expect((await a.sync.push()).failed).toEqual([]);
    return { a, row };
  }

  it("push: 행 페이지 끝에 「📁 이름」 으로 붙인다 · 경고하지 않는다 · 행 본문을 고쳐 올려도 블록을 지킨다", async () => {
    const { a, row } = await seeded();
    expect(uploads()).toBe(1);
    expect(notion.pages.get(row.id)!.body).toContain("📁 data.csv");
    expect(warnings.join("\n")).not.toContain("Tasks/Task/data.csv");

    at("10:03:05");
    a.vault.write(
      "Tasks/Task.md",
      a.vault.read("Tasks/Task.md").replace("행 본문", "고친 행 본문"),
    );
    expect(await a.sync.push()).toMatchObject({ updated: 1, failed: [] });
    const body = notion.pages.get(row.id)!.body;
    expect(body).toContain("고친 행 본문");
    expect(body.match(/📁 data\.csv/g)).toHaveLength(1);
    expect(uploads()).toBe(1);
    at("10:05:05");
    expect(await a.sync.push()).toMatchObject({ created: 0, updated: 0, failed: [] });
    expect(uploads()).toBe(1);
  });

  it("pull: 다른 볼트가 행에서 떼어 행 이름의 폴더에 같은 바이트로 받고 · 고침 · 지우기도 따른다 · 다시 돌려도 바뀌는 것이 없다", async () => {
    const { a } = await seeded();
    const b = device();
    at("10:03:05");
    expect((await b.sync.pull()).failed).toEqual([]);
    expect(b.vault.read("Tasks/Task/data.csv")).toBe("a,b\n1,2\n");
    expect(b.vault.read("Tasks/Task.md")).not.toContain("data.csv");
    expect(csvs(b.vault)).toEqual(["Tasks/Task/data.csv"]);
    at("10:05:05");
    expect(await b.sync.push()).toMatchObject({ created: 0, updated: 0, failed: [] });
    expect(uploads()).toBe(1);

    // A 가 받아도 노트에 새지 않는다
    at("10:06:05");
    await a.sync.pull();
    expect(a.vault.read("Tasks/Task.md")).not.toContain("data.csv");
    expect(csvs(a.vault)).toEqual(["Tasks/Task/data.csv"]);

    // 고침
    at("10:07:05");
    a.vault.write("Tasks/Task/data.csv", "a,b\n1,2\n3,4\n");
    expect((await a.sync.push()).failed).toEqual([]);
    expect(uploads()).toBe(2);
    at("10:09:05");
    await b.sync.pull();
    expect(b.vault.read("Tasks/Task/data.csv")).toBe("a,b\n1,2\n3,4\n");
    expect(csvs(b.vault)).toEqual(["Tasks/Task/data.csv"]);

    // 지우기
    at("10:11:05");
    a.vault.files.delete("Tasks/Task/data.csv");
    expect((await a.sync.push()).failed).toEqual([]);
    const row = [...notion.pages.values()].find((p) => p.title === "Task")!;
    expect(row.body).not.toContain("data.csv");
    expect(row.body).toContain("행 본문");
    at("10:13:05");
    await b.sync.pull();
    expect(csvs(b.vault)).toEqual([]);
    expect(b.vault.read("Tasks/Task.md")).toContain("행 본문");
  });

  it("Notion 의 행 이름 바꾸기를 따르는 볼트는 파일 폴더째 옮기고 · 다시 올리지 않는다", async () => {
    const { a, row } = await seeded();
    const b = device(true);
    at("10:03:05");
    await b.sync.pull();
    expect(csvs(b.vault)).toEqual(["Tasks/Task/data.csv"]);

    at("10:05:05");
    notion.edit(row.id, (page) => {
      page.title = "Job";
    });
    at("10:06:05");
    expect((await b.sync.pull()).failed).toEqual([]);
    expect(b.vault.files.has("Tasks/Job.md")).toBe(true);
    expect(csvs(b.vault)).toEqual(["Tasks/Job/data.csv"]);
    expect(b.vault.read("Tasks/Job/data.csv")).toBe("a,b\n1,2\n");
    at("10:08:05");
    expect((await b.sync.push()).failed).toEqual([]);
    expect(uploads()).toBe(1);
    expect(notion.pages.get(row.id)!.body.match(/📁 data\.csv/g)).toHaveLength(1);
    void a;
  });

  it("DB 폴더 바로 아래 파일은 둘 곳이 없어 여전히 경고한다", async () => {
    const { a } = await seeded();
    at("10:03:05");
    a.vault.write("Tasks/loose.csv", "x\n");
    await a.sync.push();
    expect(uploads()).toBe(1);
    expect(warnings.join("\n")).toContain("Tasks/loose.csv");
  });
});
