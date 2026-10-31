/**
 * 끊긴 갱신 이어 하기 (P7) — 본문을 보낸 뒤 응답을 받지 못하거나 프로세스가 죽으면 원격에는 이 도구가 쓴 본문이
 * 있지만 상태 DB 는 지난번 그대로다. 지난번 편집자가 사람이면 봇 규칙(같은 봇이 이어 고침)이 가르지 못해, 다음
 * push 는 «Notion 에서도 바뀌었다» 며 pull 을 먼저 하라 했고 그 pull 은 이 도구가 쓴 본문을 로컬 편집과 부딪는
 * 충돌로 올렸다.
 *
 * 본문을 보내기 전에 갱신 WAL 을 적고, 다음 실행이 «이 도구가 보내던 그 글» 과 «마지막 편집자가 이 봇» 으로
 * 끊긴 쓰기를 알아본다.
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
import { deferredCodeMarker } from "../../src/constants/markers.js";

const DAY = "2026-10-31";
/** 펜스 줄이 든 코드 — 본문은 자리표시로 가고 뒤에 블록으로 채운다(ADR-029). */
const CODE = "```js\nnested();\n```";
const NOTE = ["첫 줄", "", "````md", CODE, "````", "", "끝 줄", ""].join("\n");
const EDITED = NOTE.replace("첫 줄", "첫 줄 로컬").replace("끝 줄", "끝 줄 사람");
const ROW_DB_ID = "db000000-0000-4000-8000-0000000000f1";
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
    advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0, maxRetries: 0 },
  });
}

describe("끊긴 갱신 이어 하기", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00:05");
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-interrupted-"));
    db = StateDB.open(join(tempDir, "state.db"));
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
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  /**
   * 이번 push 내내 본문은 Notion 에 들어가고 응답만 잃는다 — 쓰고 죽은 것과 같다(같은 실행의 재시도도 끊긴다).
   * 끝나면 되돌린다.
   */
  async function pushDyingAfterBody(orchestrator: SyncOrchestrator) {
    const replace = notion.client.replacePageMarkdown.getMockImplementation()!;
    notion.client.replacePageMarkdown.mockImplementation(async (...args: never[]) => {
      await replace(...args);
      throw new Error("socket hang up");
    });
    try {
      return await orchestrator.push();
    } finally {
      notion.client.replacePageMarkdown.mockImplementation(replace);
    }
  }

  const incompleteUpdates = () =>
    db.getIncompletePendingOperations().filter((op) => op.operation === "update");

  describe("페이지", () => {
    let orchestrator: SyncOrchestrator;
    let pageId: string;
    const body = () => notion.pages.get(pageId)!.body;

    /**
     * 사람이 Notion 에서 마지막으로 고친 노트를 받아 두고, 로컬을 고쳐 올리다 끊긴다. 코드에 펜스 줄이 있어 본문은
     * 자리표시로 가고 채우기 전에 죽는다 — 원격은 이 도구가 쓴 글이지만 노트와 다르다(ADR-029).
     */
    beforeEach(async () => {
      orchestrator = new SyncOrchestrator(config(), db, notion.client as never, vault.fs());
      vault.write("Note.md", NOTE);
      await orchestrator.push();
      pageId = db.getByPath("Note.md")!.notionPageId!;
      expect(body()).toContain(CODE);
      at("10:01:00");
      notion.edit(pageId, (page) => {
        page.body = page.body.replace("끝 줄", "끝 줄 사람");
      });
      at("10:02:10");
      expect(await orchestrator.pull()).toMatchObject({ updated: 1, conflicts: [] });
      expect(db.getByPath("Note.md")!.notionLastEditedBy).not.toBeNull();

      at("10:03:00");
      vault.write("Note.md", EDITED);
      const interrupted = await pushDyingAfterBody(orchestrator);
      expect(interrupted.failed).toHaveLength(1);
      expect(body()).toContain("첫 줄 로컬");
      expect(body()).toContain(deferredCodeMarker(0));
      expect(incompleteUpdates()).toHaveLength(1);
      at("10:05:00");
    });

    it("다음 push 는 pull 을 먼저 하라 하지 않고 마저 올린다", async () => {
      const resumed = await orchestrator.push();

      expect(resumed).toMatchObject({ updated: 1, failed: [] });
      expect(body()).toContain(CODE);
      expect(body()).not.toContain("deferred-code");
      expect(incompleteUpdates()).toEqual([]);
      expect(db.getByPath("Note.md")!.status).toBe("synced");
      at("10:07:00");
      expect(await orchestrator.pull()).toMatchObject({ updated: 0, conflicts: [] });
      expect(vault.read("Note.md")).toBe(EDITED);
    });

    it("그 사이 pull 은 이 도구가 쓰다 만 본문을 받지도 충돌로 올리지도 않는다", async () => {
      expect(await orchestrator.pull({ dryRun: true })).toMatchObject({
        updated: 0,
        conflicts: [],
      });
      const pulled = await orchestrator.pull();

      expect(pulled).toMatchObject({ updated: 0, conflicts: [], failed: [] });
      expect(vault.read("Note.md")).toBe(EDITED);
      expect(await orchestrator.push()).toMatchObject({ updated: 1, failed: [] });
      expect(body()).toContain(CODE);
      expect(incompleteUpdates()).toEqual([]);
    });

    it("끊긴 뒤 사람이 Notion 에서 고쳤으면 예전처럼 덮어쓰지 않는다", async () => {
      notion.edit(pageId, (page) => {
        page.body = page.body.replace("끝 줄 사람", "끝 줄 사람 또");
      });
      at("10:06:10");

      const pushed = await orchestrator.push();

      expect(pushed.failed).toEqual([
        expect.objectContaining({ error: expect.stringContaining("pull") }),
      ]);
      expect(body()).toContain("끝 줄 사람 또");
    });

    it("끊긴 뒤 로컬을 더 고쳤으면 끊긴 쓰기로 보지 않는다 — pull 은 지난 사본과 견준다", async () => {
      vault.write("Note.md", EDITED.replace("첫 줄 로컬", "첫 줄 로컬 또"));

      const pulled = await orchestrator.pull();

      expect(pulled.conflicts).toHaveLength(1);
      expect(vault.read("Note.md")).toBe(EDITED.replace("첫 줄 로컬", "첫 줄 로컬 또"));
    });
  });

  describe("DB 행", () => {
    it("다음 push 가 마저 올리고, 그 사이 pull 은 충돌로 올리지 않는다", async () => {
      const orchestrator = new SyncOrchestrator(
        config([ROW_DB]),
        db,
        notion.client as never,
        vault.fs(),
      );
      const row = notion.add(ROW_DB_ID, "Task", NOTE.trimEnd(), {}); // 사람이 만든 행처럼
      notion.edit(row.id, () => undefined);
      at("10:01:10");
      expect(await orchestrator.pull()).toMatchObject({ created: 1, failed: [] });
      const path = db.getByNotionId(row.id)!.obsidianPath;

      at("10:02:00");
      const edited = vault.read(path)!.replace("첫 줄", "첫 줄 로컬");
      vault.write(path, edited);
      expect((await pushDyingAfterBody(orchestrator)).failed).toHaveLength(1);
      expect(notion.pages.get(row.id)!.body).toContain("첫 줄 로컬");
      expect(notion.pages.get(row.id)!.body).toContain(deferredCodeMarker(0));
      at("10:04:00");

      expect(await orchestrator.pull({ dryRun: true })).toMatchObject({
        updated: 0,
        conflicts: [],
      });
      expect(await orchestrator.pull()).toMatchObject({ updated: 0, conflicts: [] });
      expect(vault.read(path)).toBe(edited);
      expect(await orchestrator.push()).toMatchObject({ updated: 1, failed: [] });
      expect(notion.pages.get(row.id)!.body).toContain(CODE);
      expect(notion.pages.get(row.id)!.body).not.toContain("deferred-code");
      expect(incompleteUpdates()).toEqual([]);
    });
  });
});
