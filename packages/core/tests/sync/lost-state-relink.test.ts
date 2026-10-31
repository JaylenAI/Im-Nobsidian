/**
 * 상태 DB 를 잃었을 때 다시 세우기 (P7) — 볼트에는 받은 노트가 그대로 있는데 상태 기록이 비었다(상태 파일을 지웠거나 다른
 * 기기로 볼트만 옮겼다). 예전에는 pull 이 모든 노트를 id 를 붙인 이름으로 또 받고(`A (00000000).md`), push 는 모든 페이지를
 * Notion 에 또 만들었다.
 *
 * - pull 은 같은 자리의 노트를 그 페이지와 다시 잇는다 — 글이 같으면 쓰지 않고, 다르면 충돌로(전략을 따라) 남긴다
 * - 이은 노트가 있는 볼트에서는 자연 이름에 있는 다른 글의 노트를 잇지 않는다(예전처럼 id 를 붙인 이름) — 이 페이지 id 를
 *   단 이름이면 잇는다
 * - push 는 상태 기록이 비었는데 만들 노트가 Notion 에 있는 것과 이름이 겹치면 올리지 않고 pull 을 먼저 하라고 알린다
 *
 * 실제 StateDB(임시 파일) · 메모리 볼트 · 메모리 Notion 으로 돈다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { Config, DatabaseSyncConfig } from "../../src/types/config.js";
import { UnlinkedVaultError } from "../../src/sync/lost-state-guard.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DAY = "2026-10-31";
const ROW_DB_ID = "db000000-0000-4000-8000-0000000000f6";
const ROW_DB: DatabaseSyncConfig = {
  databaseId: ROW_DB_ID,
  localFolder: "Tasks",
  titleProperty: "Name",
};

function at(hms: string): void {
  vi.setSystemTime(new Date(`${DAY}T${hms}.000Z`));
}

function config(sync: Partial<Config["sync"]> = {}): Config {
  return createConfig({
    notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases: [ROW_DB] },
    sync: { ...DEFAULT_CONFIG.sync, ...sync },
    advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0, maxRetries: 0 },
  });
}

describe("상태 DB 를 잃은 볼트 다시 잇기", () => {
  let tempDir: string;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let dbs = 0;
  // 연 상태 DB 는 모두 닫고 지운다 — Windows 는 열린 파일을 지우지 못한다(EBUSY).
  let opened: StateDB[] = [];

  const open = (sync: Partial<Config["sync"]> = {}) => {
    const db = StateDB.open(join(tempDir, `state-${++dbs}.db`));
    opened.push(db);
    return {
      db,
      orchestrator: new SyncOrchestrator(config(sync), db, notion.client as never, vault.fs()),
    };
  };
  const notes = () => [...vault.files.keys()].filter((path) => path.endsWith(".md")).sort();
  const livePages = () =>
    [...notion.pages.values()]
      .filter((page) => !page.archived)
      .map((page) => page.title)
      .sort();

  /** 볼트 A 가 올리고 행 하나를 받은 뒤 상태 DB 를 잃는다 — 볼트 파일은 그대로. */
  async function syncedThenLost(): Promise<string[]> {
    const first = open();
    vault.write("A.md", "가\n");
    vault.write("dir/B.md", "나\n");
    vault.write("dir/dir.md", "폴더 노트\n");
    notion.add(ROW_DB_ID, "R", "행 본문", {});
    await first.orchestrator.pull();
    at("10:00:20");
    await first.orchestrator.push();
    at("10:00:40");
    await first.orchestrator.pull();
    first.db.close();
    at("10:03:00");
    return [...vault.files.keys()].sort();
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00:05");
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-relink-"));
    vault = new MemoryVault();
    notion = memoryNotion({ minuteClock: true });
    notion.client.getDatabaseSchema.mockResolvedValue({ Name: { id: "title", type: "title" } });
    notion.client.getDatabaseViewsConfig.mockResolvedValue({
      databaseId: ROW_DB_ID,
      lastSynced: "",
      views: [],
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const db of opened) {
      try {
        db.close();
      } catch {
        // 시험이 이미 닫았다
      }
    }
    opened = [];
    await rm(tempDir, { recursive: true, force: true });
  });

  it("pull 이 같은 글의 노트 · 폴더 노트 · 행을 다시 잇는다 — 새 파일 · 쓰기 없음, 이어지는 push · pull 0", async () => {
    const before = await syncedThenLost();
    const pages = livePages();
    const { orchestrator } = open();

    const pulled = await orchestrator.pull();
    expect(pulled.created).toBe(0);
    expect(pulled.updated).toBe(0);
    expect(pulled.conflicts).toHaveLength(0);
    expect([...(pulled.relinkedPaths ?? [])].sort()).toEqual([
      "A.md",
      "Tasks/R.md",
      "dir/B.md",
      "dir/dir.md",
    ]);
    expect([...vault.files.keys()].sort()).toEqual(before);

    const pushed = await orchestrator.push();
    expect(pushed.created + pushed.updated).toBe(0);
    expect(livePages()).toEqual(pages);
    at("10:04:00");
    const again = await orchestrator.pull();
    expect(again.created + again.updated).toBe(0);
  });

  it("서로 가리키는 노트 · 폴더 노트 없는 폴더도 충돌 · 생성 없이 잇는다(라이브 실측)", async () => {
    // 이을 때 링크 대상이 아직 이어지지 않아 받은 글의 링크가 `[[notion:<id>]]` 로 남는다 — 그것만 다른 노트가
    // 충돌이 됐고, 이미 있던 폴더를 «생성» 으로 셌다.
    const first = open();
    vault.write("links/P.md", "[[Q]] 로 가기\n");
    vault.write("links/Q.md", "[[P]] 로 돌아가기\n");
    await first.orchestrator.push();
    at("10:00:40");
    await first.orchestrator.pull();
    first.db.close();
    at("10:03:00");
    const before = [...vault.files.keys()].sort();
    const pages = livePages();

    const { orchestrator } = open();
    const pulled = await orchestrator.pull();
    expect(pulled.conflicts).toHaveLength(0);
    expect(pulled.created).toBe(0);
    expect([...(pulled.relinkedPaths ?? [])].sort()).toEqual(["links/P.md", "links/Q.md"]);
    expect([...vault.files.keys()].sort()).toEqual(before);
    expect(vault.read("links/P.md")).toBe("[[Q]] 로 가기\n");
    const pushed = await orchestrator.push();
    expect(pushed.created + pushed.updated).toBe(0);
    expect(livePages()).toEqual(pages);
  });

  it("sync 도 받으며 다시 잇고 올리는 것이 없다", async () => {
    const before = await syncedThenLost();
    const pages = livePages();
    const { orchestrator } = open();

    const result = await orchestrator.sync();
    expect(result.pull.created).toBe(0);
    expect(result.push.created + result.push.updated).toBe(0);
    expect([...vault.files.keys()].sort()).toEqual(before);
    expect(livePages()).toEqual(pages);
  });

  it("잃은 뒤 볼트에서 고친 노트 · 행은 충돌로 잇고 노트를 지킨다 — 로컬을 고르면 같은 페이지를 고친다", async () => {
    await syncedThenLost();
    vault.write("A.md", "가 로컬에서 고침\n");
    vault.write("Tasks/R.md", "행 로컬에서 고침\n");
    const pages = livePages();
    const { orchestrator } = open();

    const pulled = await orchestrator.pull();
    expect(pulled.conflicts.map((c) => c.localChange.path).sort()).toEqual(["A.md", "Tasks/R.md"]);
    expect(pulled.conflicts.every((c) => c.baseContent === null)).toBe(true);
    expect(vault.read("A.md")).toBe("가 로컬에서 고침\n");
    expect(vault.read("Tasks/R.md")).toBe("행 로컬에서 고침\n");
    expect(pulled.created).toBe(0);
    // 충돌 노트는 해소 전에 올리지 않는다 — 새 페이지도 만들지 않는다.
    const held = await orchestrator.push();
    expect(held.created).toBe(0);
    expect(livePages()).toEqual(pages);

    at("10:04:00");
    for (const conflict of pulled.conflicts) {
      const resolved = await orchestrator.resolveConflict(conflict, "local");
      expect(resolved.success).toBe(true);
    }
    expect(livePages()).toEqual(pages);
    const pageA = [...notion.pages.values()].find((page) => page.title === "A")!;
    expect(pageA.body).toContain("가 로컬에서 고침");
  });

  it("merge 전략도 공통 조상이 없어 합치지 않고 충돌로 남긴다", async () => {
    await syncedThenLost();
    vault.write("A.md", "가 로컬에서 고침\n");
    const { orchestrator } = open({ conflictStrategy: "merge" });

    const pulled = await orchestrator.pull();
    expect(pulled.conflicts.map((c) => c.localChange.path)).toEqual(["A.md"]);
    expect(vault.read("A.md")).toBe("가 로컬에서 고침\n");
  });

  it("자연 이름의 다른 글은 local-first · remote-first 여도 덮거나 올리지 않고 충돌로 남긴다 — 다른 노트일 수 있다", async () => {
    await syncedThenLost();
    vault.write("A.md", "가 로컬에서 고침\n");
    const pages = livePages();
    const bodyA = [...notion.pages.values()].find((page) => page.title === "A")!.body;
    for (const conflictStrategy of ["local-first", "remote-first"] as const) {
      const { orchestrator } = open({ conflictStrategy });
      const pulled = await orchestrator.pull();
      expect(pulled.conflicts.map((c) => c.localChange.path)).toEqual(["A.md"]);
      expect(vault.read("A.md")).toBe("가 로컬에서 고침\n");
      at("10:04:00");
      const pushed = await orchestrator.push();
      expect(pushed.created + pushed.updated).toBe(0);
      expect(livePages()).toEqual(pages);
      expect([...notion.pages.values()].find((page) => page.title === "A")!.body).toBe(bodyA);
    }
  });

  it("이 페이지 id 를 단 이름의 다른 글은 전략을 따른다 — local-first 는 같은 페이지를 고치고 remote-first 는 덮는다", async () => {
    // 이은 볼트에 아직 올리지 않은 C.md 가 있어 pull 이 Notion 의 C 를 id 를 붙인 이름으로 받았다 — 그 뒤 상태 DB 를 잃었다.
    // (메모리 Notion 의 id 는 앞 8자리가 모두 같아 Notion 에 C 가 둘이면 접미사가 겹친다 — 볼트의 C 는 올리지 않는다.)
    const first = open();
    vault.write("A.md", "가\n");
    await first.orchestrator.push();
    at("10:01:00");
    vault.write("C.md", "볼트의 다른 C\n");
    const page = notion.add("root-page-id", "C", "원격 C");
    at("10:02:00");
    await first.orchestrator.pull();
    const own = `C (${page.id.replace(/-/g, "").slice(0, 8)}).md`;
    expect(vault.read(own)).toContain("원격 C");
    first.db.close();
    vault.write(own, vault.read(own)!.replace("원격 C", "로컬 C"));
    at("10:03:00");

    const local = open({ conflictStrategy: "local-first" });
    const pulled = await local.orchestrator.pull();
    expect(pulled.conflicts).toHaveLength(0);
    expect([...(pulled.relinkedPaths ?? [])].sort()).toEqual(["A.md", own]);
    expect(vault.read(own)).toContain("로컬 C");
    expect(vault.read("C.md")).toBe("볼트의 다른 C\n");
    at("10:04:00");
    // 이은 페이지는 고치고, 올리지 않았던 C.md 는 새 페이지로 만든다.
    const pushed = await local.orchestrator.push();
    expect(pushed).toMatchObject({ created: 1, updated: 1 });
    expect(notion.pages.get(page.id)!.title).toBe("C");
    expect(notion.pages.get(page.id)!.body).toContain("로컬 C");
    local.db.close();

    vault.write(own, vault.read(own)!.replace("로컬 C", "다시 로컬"));
    at("10:05:00");
    const remote = open({ conflictStrategy: "remote-first" });
    const again = await remote.orchestrator.pull();
    expect(again.relinkedPaths).toContain(own);
    expect(vault.read(own)).toContain("로컬 C");
    expect(vault.read(own)).not.toContain("다시 로컬");
  });

  it("이은 노트가 있는 볼트에서는 자연 이름의 다른 글 노트를 잇지 않는다 — 예전처럼 id 를 붙여 받는다", async () => {
    const { orchestrator } = open();
    vault.write("A.md", "가\n");
    await orchestrator.push();
    // 다른 기기가 Notion 에 만든 «B» 와, 이 볼트에서 아직 올리지 않은 다른 글의 B.md.
    at("10:01:00");
    notion.add("root-page-id", "B", "원격 B");
    vault.write("B.md", "로컬 B — 아직 올리지 않음\n");
    at("10:02:00");

    const pulled = await orchestrator.pull();
    expect(pulled.conflicts).toHaveLength(0);
    expect(pulled.relinkedPaths ?? []).toHaveLength(0);
    expect(pulled.created).toBe(1);
    expect(vault.read("B.md")).toBe("로컬 B — 아직 올리지 않음\n");
    const suffixed = [...vault.files.keys()].filter((path) => path.startsWith("B ("));
    expect(suffixed).toHaveLength(1);
  });

  it("이은 노트가 있는 볼트에서도 같은 글이면 잇는다", async () => {
    const { orchestrator } = open();
    vault.write("A.md", "가\n");
    await orchestrator.push();
    at("10:01:00");
    notion.add("root-page-id", "B", "같은 글");
    vault.write("B.md", "같은 글\n");
    at("10:02:00");

    const pulled = await orchestrator.pull();
    expect(pulled.relinkedPaths).toEqual(["B.md"]);
    expect(pulled.created).toBe(0);
    expect(notes()).toEqual(["A.md", "B.md"]);
    at("10:03:00");
    const pushed = await orchestrator.push();
    expect(pushed.created + pushed.updated).toBe(0);
  });

  it("이 페이지 id 를 단 이름의 노트(지난번에 받은 이름)는 다시 잇는다", async () => {
    const page = notion.add("root-page-id", "C", "원격 C");
    const own = `C (${page.id.replace(/-/g, "").slice(0, 8)}).md`;
    vault.write("C.md", "다른 C\n");
    vault.write(own, "원격 C\n");
    const { orchestrator } = open();

    const pulled = await orchestrator.pull();
    expect(pulled.relinkedPaths).toEqual([own]);
    expect(pulled.created).toBe(0);
    expect(notes()).toEqual(["C.md", own].sort());
  });

  it("push 는 상태 기록이 비었는데 Notion 과 이름이 겹치면 올리지 않는다 — 겹친 노트를 알린다", async () => {
    await syncedThenLost();
    const pages = livePages();
    const { orchestrator } = open();

    const error = await orchestrator.push().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnlinkedVaultError);
    expect((error as UnlinkedVaultError).clashes).toEqual([
      "A.md",
      "Tasks/R.md",
      "dir/B.md",
      "dir/dir.md",
    ]);
    expect(livePages()).toEqual(pages);
  });

  it("처음 올리는 볼트는 Notion 에 다른 이름만 있으면 그대로 올린다", async () => {
    notion.add("root-page-id", "원래 있던 페이지", "본문");
    notion.add(ROW_DB_ID, "원래 행", "행", {});
    vault.write("새 노트.md", "새 글\n");
    vault.write("Tasks/새 행.md", "새 행\n");
    const { orchestrator } = open();

    const pushed = await orchestrator.push();
    expect(pushed.created).toBe(2);
    expect(pushed.failed).toHaveLength(0);
  });

  it("push 만 하는 연결은 막지 않는다 — 받을 수 없다", async () => {
    notion.add("root-page-id", "A", "원격 A");
    vault.write("A.md", "가\n");
    const { orchestrator } = open({ direction: "push" });

    const pushed = await orchestrator.push();
    expect(pushed.created).toBe(1);
  });

  it("dry-run 은 쓰지 않고 다시 이을 것이라고 알린다 — sync dry-run 도 push 장치에 막히지 않는다", async () => {
    const before = await syncedThenLost();
    const pages = livePages();
    const { db, orchestrator } = open();

    const pulled = await orchestrator.pull({ dryRun: true });
    expect(pulled.relinkPending).toBe(true);
    const synced = await orchestrator.sync({ dryRun: true });
    expect(synced.pull.relinkPending).toBe(true);
    expect(db.getAll()).toHaveLength(0);
    expect([...vault.files.keys()].sort()).toEqual(before);
    expect(livePages()).toEqual(pages);
    // 이은 뒤에는 알리지 않는다.
    await orchestrator.pull();
    at("10:04:00");
    expect((await orchestrator.pull({ dryRun: true })).relinkPending).toBeUndefined();
  });
});
