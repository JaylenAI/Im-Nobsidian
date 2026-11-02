/**
 * 볼트 맨 위 파일 — 페이지 모드의 루트 페이지 끝에 「📁 이름」 으로 왕복한다(ADR-056 을 볼트 맨 위로). 0.21 까지는 둘 곳이
 * 없다며 경고만 냈다. 루트는 사용자의 페이지라 노트 페이지처럼 이 도구가 올린 블록만 다루고, 다른 블록(사용자가 붙인 같은
 * 이름의 파일 포함)은 받지도 지우지도 않는다. DB 모드의 루트는 DB 라 여전히 경고다.
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
import type { Config } from "../../src/types/config.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion, type MemoryPage } from "../helpers/memory-sync.js";
import { setLogger } from "../../src/utils/logger.js";

const DAY = "2026-11-02";

function at(hms: string): void {
  vi.setSystemTime(new Date(`${DAY}T${hms}.000Z`));
}

describe("볼트 맨 위 파일 왕복", () => {
  let tempDir: string;
  let notion: ReturnType<typeof memoryNotion>;
  let root: MemoryPage;
  let warnings: string[];
  const devices: { db: StateDB; vault: MemoryVault; sync: SyncOrchestrator }[] = [];

  const config = (): Config =>
    createConfig({
      notion: { token: "ntn_test_token", rootPageId: root.id, parentMode: "page", databases: [] },
      sync: { ...DEFAULT_CONFIG.sync, deleteSync: true },
      advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0, maxRetries: 0 },
    });

  function device() {
    const db = StateDB.open(join(tempDir, `state-${devices.length}.db`));
    const vault = new MemoryVault();
    const fetchFn = vi.fn(async (url: string | URL) => {
      const bytes = notion.downloadOf(String(url));
      return bytes ? new Response(bytes) : new Response("gone", { status: 404 });
    });
    const sync = new SyncOrchestrator(
      config(),
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
  const marked = () => root.body.match(/📁 top\.csv/g)?.length ?? 0;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00:05");
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-root-files-"));
    notion = memoryNotion({ minuteClock: true });
    root = notion.add("workspace", "볼트 루트", "루트에 쓴 글");
    warnings = [];
    setLogger({ warn: (m) => warnings.push(m), error: () => {}, info: () => {}, debug: () => {} });
  });

  afterEach(async () => {
    vi.useRealTimers();
    setLogger({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} });
    for (const made of devices.splice(0)) made.db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function seeded() {
    const a = device();
    at("10:01:05");
    a.vault.write("A.md", "노트\n");
    a.vault.write("top.csv", "a,b\n1,2\n");
    expect((await a.sync.push()).failed).toEqual([]);
    return a;
  }

  it("push: 루트 페이지 끝에 「📁 이름」 으로 붙인다 · 경고하지 않는다 · 루트의 글은 그대로 · 다시 올리지 않는다", async () => {
    const a = await seeded();
    expect(uploads()).toBe(1);
    expect(marked()).toBe(1);
    expect(root.body).toContain("루트에 쓴 글");
    expect(warnings.join("\n")).not.toContain("top.csv");
    at("10:03:05");
    await a.sync.pull();
    expect(csvs(a.vault)).toEqual(["top.csv"]);
    at("10:05:05");
    expect(await a.sync.push()).toMatchObject({ created: 0, updated: 0, failed: [] });
    expect(uploads()).toBe(1);
  });

  it("pull: 다른 볼트가 볼트 맨 위에 같은 바이트로 받고 · 고침 · 지우기도 따른다 · 루트의 글은 노트로 받지 않는다", async () => {
    const a = await seeded();
    const b = device();
    at("10:03:05");
    expect((await b.sync.pull()).failed).toEqual([]);
    expect(b.vault.read("top.csv")).toBe("a,b\n1,2\n");
    expect(csvs(b.vault)).toEqual(["top.csv"]);
    expect([...b.vault.files.keys()].filter((p) => p.endsWith(".md")).sort()).toEqual(["A.md"]);
    at("10:05:05");
    expect(await b.sync.push()).toMatchObject({ created: 0, updated: 0, failed: [] });
    expect(uploads()).toBe(1);

    at("10:07:05");
    a.vault.write("top.csv", "a,b\n1,2\n3,4\n");
    expect((await a.sync.push()).failed).toEqual([]);
    expect(uploads()).toBe(2);
    expect(marked()).toBe(1);
    at("10:09:05");
    await b.sync.pull();
    expect(b.vault.read("top.csv")).toBe("a,b\n1,2\n3,4\n");

    at("10:11:05");
    a.vault.files.delete("top.csv");
    expect((await a.sync.push()).failed).toEqual([]);
    expect(marked()).toBe(0);
    expect(root.body).toContain("루트에 쓴 글");
    at("10:13:05");
    await b.sync.pull();
    expect(csvs(b.vault)).toEqual([]);
  });

  it("루트에 사용자가 붙인 같은 이름의 파일(표시 없음)은 받지도 지우지도 않는다", async () => {
    const a = await seeded();
    let uploadsBefore = 0;
    // 사용자가 Notion 에서 루트에 붙인 같은 이름의 파일 — 캡션 없음
    at("10:03:05");
    const upload = await notion.client.uploadFile(new Blob(["user\n"]), "top.csv");
    const [userBlock] = await notion.client.appendChildBlocks(root.id, [
      { type: "file", file: { type: "file_upload", file_upload: { id: upload } } },
    ]);
    const users = root.body.split("\n").at(-1)!;
    expect(users).not.toContain("📁");
    uploadsBefore = uploads();
    const b = device();
    at("10:04:05");
    await b.sync.pull();
    expect(csvs(b.vault)).toEqual(["top.csv"]);

    at("10:06:05");
    a.vault.write("top.csv", "a,b\n9,9\n");
    expect((await a.sync.push()).failed).toEqual([]);
    expect(root.body).toContain(users);
    expect(marked()).toBe(1);
    at("10:08:05");
    a.vault.files.delete("top.csv");
    expect((await a.sync.push()).failed).toEqual([]);
    expect(root.body).toContain(users);
    expect(marked()).toBe(0);
    expect(notion.client.deleteBlock.mock.calls.map(([id]) => id)).not.toContain(userBlock!.id);
    expect(uploads()).toBe(uploadsBefore + 1);
    at("10:10:05");
    const c = device();
    await c.sync.pull();
    expect(csvs(c.vault)).toEqual([]);
  });
});
