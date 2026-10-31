/**
 * push --dry-run 이 원격을 본다 (P7) — 실제 push 는 고치거나 지우기 전에 원격을 읽어 pull 하지 않은 Notion 편집 ·
 * Notion 에서 지운 페이지를 거절하는데, dry-run 은 원격을 읽지 않아 그런 노트도 «고칠 것 · 지울 것» 으로 셌다.
 * 미리 보기와 실제가 달랐다.
 *
 * dry-run 도 같은 판정으로 거절할 것을 실패로 보이고 세지 않는다. 상태 DB 와 원격은 건드리지 않는다.
 *
 * 실제 StateDB(임시 파일) · 메모리 볼트 · 메모리 Notion.
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
const ROW_DB_ID = "db000000-0000-4000-8000-0000000000f2";
const ROW_DB: DatabaseSyncConfig = {
  databaseId: ROW_DB_ID,
  localFolder: "Tasks",
  titleProperty: "Name",
};

function at(hms: string): void {
  vi.setSystemTime(new Date(`${DAY}T${hms}.000Z`));
}

function config(databases: DatabaseSyncConfig[] = []): Config {
  return createConfig({
    notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases },
    sync: { ...DEFAULT_CONFIG.sync, deleteSync: true },
    advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0, maxRetries: 0 },
  });
}

describe("push --dry-run 이 원격을 본다", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let orchestrator: SyncOrchestrator;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00:05");
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-push-dry-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
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
    orchestrator = new SyncOrchestrator(config([ROW_DB]), db, notion.client as never, vault.fs());
    vault.write("A.md", "가 본문\n");
    vault.write("B.md", "나 본문\n");
    vault.write("C.md", "다 본문\n");
    vault.write("D.md", "라 본문\n");
    await orchestrator.push();
    at("10:00:20");
    await orchestrator.pull();
  });

  afterEach(async () => {
    vi.useRealTimers();
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const pageOf = (path: string) => db.getByPath(path)!.notionPageId!;

  /** dry-run 이 상태 DB 와 원격을 건드리지 않았나 — 레코드 · 원격 수정 시각을 그대로 견준다. */
  async function dryRunUntouched() {
    const before = JSON.stringify(db.getAll());
    const remote = JSON.stringify([...notion.pages.values()]);
    const result = await orchestrator.push({ dryRun: true });
    expect(JSON.stringify(db.getAll())).toBe(before);
    expect(JSON.stringify([...notion.pages.values()])).toBe(remote);
    return result;
  }

  it("Notion 에서도 본문을 고친 노트 · 지운 페이지는 실패로 보이고 세지 않는다 — 실제 push 와 같다", async () => {
    at("10:02:00");
    vault.write("A.md", "가 본문 로컬\n"); // 그대로 올라간다
    vault.write("B.md", "나 본문 로컬\n");
    notion.edit(pageOf("B.md"), (page) => {
      page.body = "나 본문 원격";
    });
    vault.write("C.md", "다 본문 로컬\n");
    notion.edit(pageOf("C.md"), (page) => {
      page.archived = true;
    });
    vault.files.delete("D.md");
    notion.edit(pageOf("D.md"), (page) => {
      page.body = "라 본문 원격";
    });
    at("10:03:00");

    const preview = await dryRunUntouched();

    expect(preview).toMatchObject({ updated: 1, deleted: 0 });
    expect(preview.failed.map((f) => f.path).sort()).toEqual(["B.md", "C.md", "D.md"]);
    const reasons = Object.fromEntries(preview.failed.map((f) => [f.path, f]));
    expect(reasons["B.md"]).toMatchObject({ operation: "update" });
    expect(reasons["B.md"]!.error).toContain("pull");
    expect(reasons["C.md"]!.error).toContain("지운 페이지");
    expect(reasons["D.md"]).toMatchObject({ operation: "delete" });
    expect(reasons["D.md"]!.error).toContain("지우지 않음");

    const pushed = await orchestrator.push();
    expect(pushed).toMatchObject({ updated: preview.updated, deleted: preview.deleted });
    expect(pushed.failed.map((f) => f.path).sort()).toEqual(["B.md", "C.md", "D.md"]);
  });

  it("Notion 에서 본문 밖만 바뀐 노트는 실제 push 처럼 고칠 것으로 센다", async () => {
    // 만든 페이지는 지문을 적지 않는다 — 사람이 고친 본문을 한 번 받아 지문을 적어 둔다.
    notion.edit(pageOf("A.md"), (page) => {
      page.body = "가 본문 원격";
    });
    at("10:01:10");
    expect(await orchestrator.pull()).toMatchObject({ updated: 1 });
    at("10:02:00");
    vault.write("A.md", "가 본문 로컬\n");
    notion.edit(pageOf("A.md"), (page) => {
      page.title = "가 원격 제목";
    });
    at("10:03:00");

    const preview = await dryRunUntouched();

    expect(preview).toMatchObject({ updated: 1, failed: [] });
    expect(await orchestrator.push()).toMatchObject({ updated: 1, failed: [] });
  });

  it("원격을 덮는 충돌 해결(로컬 유지)은 원격 편집이 있어도 거절하지 않는다", async () => {
    at("10:02:00");
    vault.write("B.md", "나 본문 로컬\n");
    notion.edit(pageOf("B.md"), (page) => {
      page.body = "나 본문 원격";
    });
    at("10:03:00");
    const conflicts = (await orchestrator.pull()).conflicts;
    expect(conflicts).toHaveLength(1);

    // 충돌 노트는 push 에서 빠진다 — dry-run 도 원격을 읽어 거절로 올리지 않는다.
    const preview = await dryRunUntouched();
    expect(preview).toMatchObject({ updated: 0, failed: [] });
  });

  it("충돌 전략 local-first 는 원격 편집을 덮는다 — dry-run 도 거절로 보이지 않는다", async () => {
    at("10:02:00");
    vault.write("B.md", "나 본문 로컬\n");
    notion.edit(pageOf("B.md"), (page) => {
      page.body = "나 본문 원격";
    });
    at("10:03:00");
    const base = config([ROW_DB]);
    orchestrator = new SyncOrchestrator(
      { ...base, sync: { ...base.sync, conflictStrategy: "local-first" } },
      db,
      notion.client as never,
      vault.fs(),
    );

    const preview = await dryRunUntouched();

    expect(preview).toMatchObject({ updated: 1, failed: [] });
    expect(await orchestrator.push()).toMatchObject({ updated: 1, failed: [] });
    expect(notion.pages.get(pageOf("B.md"))!.body).toContain("나 본문 로컬");
  });

  it("DB 행 — 본문을 고친 행은 Notion 에서도 본문이 바뀌었으면 거절로 보인다", async () => {
    const row = notion.add(ROW_DB_ID, "Task", "행 본문", {});
    notion.edit(row.id, () => undefined);
    at("10:01:10");
    await orchestrator.pull();
    const path = db.getByNotionId(row.id)!.obsidianPath;
    const pulled = vault.read(path)!;

    at("10:02:00");
    vault.write(path, pulled.replace("행 본문", "행 본문 로컬"));
    notion.edit(row.id, (page) => {
      page.body = "행 본문 원격";
    });
    at("10:03:00");

    const preview = await dryRunUntouched();
    expect(preview.updated).toBe(0);
    expect(preview.failed).toEqual([
      expect.objectContaining({
        path,
        operation: "update",
        error: expect.stringContaining("pull"),
      }),
    ]);
    expect((await orchestrator.push()).failed.map((f) => f.path)).toEqual([path]);
  });

  it("DB 행 — 속성만 고친 행은 Notion 에서 본문이 바뀌어도 실제 push 처럼 고칠 것으로 센다", async () => {
    const row = notion.add(ROW_DB_ID, "Task", "행 본문", {});
    notion.edit(row.id, () => undefined);
    at("10:01:10");
    await orchestrator.pull();
    const path = db.getByNotionId(row.id)!.obsidianPath;
    const pulled = vault.read(path)!;
    expect(pulled.startsWith("---\n")).toBe(true);

    at("10:02:00");
    vault.write(path, pulled.replace("---\n", "---\nMemo: 로컬 메모\n"));
    notion.edit(row.id, (page) => {
      page.body = "행 본문 원격";
    });
    at("10:03:00");

    const preview = await dryRunUntouched();
    expect(preview).toMatchObject({ updated: 1, failed: [] });
    expect(await orchestrator.push()).toMatchObject({ updated: 1, failed: [] });
  });
});
