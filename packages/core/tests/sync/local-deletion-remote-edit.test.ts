/**
 * F-f — 로컬에서 지운 노트를 push 가 Notion 에서도 지울 때 원격을 보지 않았다.
 *
 * 지난 동기화 뒤 Notion 에서 고친 페이지도 그대로 휴지통으로 보냈다 — pull 하지 않은 그 편집은
 * 볼트에도 Notion 에도 보이지 않게 됐다. 본문을 바꿀 때는 원격을 보고 거절하는데(N-05) 지울 때만
 * 빠져 있었다. 원격 삭제가 로컬 편집을 지우던 D 의 거울이다.
 *
 * 고친 뒤: 지우기 전에 원격을 본다. 바뀌었거나 바뀌었는지 모르면 지우지 않고 이유를 남긴다 — 이어지는
 * pull 이 되살려 받는다. local-first 는 예전처럼 지운다. 이미 사라진 페이지는 추적만 놓는다.
 *
 * 실제 StateDB(임시 파일) · 메모리 볼트 · 메모리 Notion 으로 끝까지 돌린다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { ConflictStrategy } from "../../src/types/sync.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DAY = "2026-09-04";

/** 이 기기 시계를 `DAY` 의 그 시각으로 — 메모리 Notion 의 수정 시각도 이 시계를 따른다. */
function at(hms: string): void {
  vi.setSystemTime(new Date(`${DAY}T${hms}.000Z`));
}

describe("F-f 로컬에서 지운 노트의 pull 하지 않은 Notion 편집", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  /** 플러그인과 같은 설정 — 페이지 모드 · deleteSync 켬 · 전략만 바꾼다. */
  const build = (strategy: ConflictStrategy = "manual"): SyncOrchestrator =>
    new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases: [] },
        sync: { ...DEFAULT_CONFIG.sync, deleteSync: true, conflictStrategy: strategy },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00:05");
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-local-deletion-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion({ minuteClock: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  /** 올리고 한 번 받아 둔 노트. */
  async function syncedNote(orchestrator: SyncOrchestrator): Promise<string> {
    vault.write("Note.md", "원본\n");
    expect(await orchestrator.push()).toMatchObject({ created: 1, failed: [] });
    at("10:00:20");
    await orchestrator.pull();
    return db.getByPath("Note.md")!.notionPageId!;
  }

  /** Notion 에서 고친 것을 한 번 받아 둔 노트 — 본문 지문이 있어 무엇이 바뀌었는지 가른다. */
  async function pulledRemoteEdit(orchestrator: SyncOrchestrator): Promise<string> {
    const pageId = await syncedNote(orchestrator);
    at("10:01:00");
    notion.edit(pageId, (page) => {
      page.body = "원본\n\n첫 편집";
    });
    at("10:01:30");
    expect(await orchestrator.pull()).toMatchObject({ updated: 1, failed: [] });
    return pageId;
  }

  /** Notion 에서 사람이 본문을 고친 뒤 로컬 파일을 지운다. */
  function remoteEditThenLocalDelete(pageId: string): void {
    at("10:02:00");
    notion.edit(pageId, (page) => {
      page.body = "원본\n\nNotion 에서 더함";
    });
    vault.files.delete("Note.md");
    at("10:03:00");
  }

  it("Notion 에서 고친 페이지는 지우지 않고 이유를 남긴다 — 이어지는 pull 이 되살려 받는다", async () => {
    const orchestrator = build();
    const pageId = await syncedNote(orchestrator);
    remoteEditThenLocalDelete(pageId);

    const push = await orchestrator.push();

    expect(push).toMatchObject({ deleted: 0 });
    // push 로 만든 페이지는 본문 지문이 없다 — 사람이 고친 것은 알지만 본문까지는 가르지 못한다(N-05).
    expect(push.failed).toEqual([
      {
        path: "Note.md",
        operation: "delete",
        error: expect.stringContaining(
          "Notion 에서 바뀌었는지 확인하지 못한 페이지라 지우지 않음 — pull 이 되살려 받습니다",
        ),
      },
    ]);
    expect(notion.pages.get(pageId)?.archived).toBe(false);
    expect(db.getByPath("Note.md")?.notionPageId).toBe(pageId);

    const pull = await orchestrator.pull();

    expect(pull).toMatchObject({ failed: [] });
    expect(vault.read("Note.md")).toContain("Notion 에서 더함");
  });

  it("본문을 받아 둔 페이지는 Notion 에서 바뀐 것을 가려 알린다", async () => {
    const orchestrator = build();
    const pageId = await pulledRemoteEdit(orchestrator);
    remoteEditThenLocalDelete(pageId);

    const push = await orchestrator.push();

    expect(push.failed).toEqual([
      {
        path: "Note.md",
        operation: "delete",
        error: expect.stringContaining("Notion 에서도 바뀐 페이지라 지우지 않음"),
      },
    ]);
    expect(notion.pages.get(pageId)?.archived).toBe(false);
  });

  it("Notion 에서 제목만 바꾼 페이지도 지우지 않는다 — 본문 밖의 편집도 편집이다", async () => {
    const orchestrator = build();
    const pageId = await pulledRemoteEdit(orchestrator);
    at("10:02:00");
    notion.edit(pageId, (page) => {
      page.title = "새 제목";
    });
    vault.files.delete("Note.md");
    at("10:03:00");

    const push = await orchestrator.push();

    expect(push).toMatchObject({ deleted: 0 });
    expect(push.failed).toEqual([
      {
        path: "Note.md",
        operation: "delete",
        error: expect.stringContaining("Notion 에서도 바뀐 페이지라 지우지 않음"),
      },
    ]);
    expect(notion.pages.get(pageId)?.archived).toBe(false);
  });

  it("받아 둔 뒤 Notion 에서 고치지 않은 페이지는 지운다", async () => {
    const orchestrator = build();
    const pageId = await pulledRemoteEdit(orchestrator);
    at("10:02:00");
    vault.files.delete("Note.md");

    const push = await orchestrator.push();

    expect(push).toMatchObject({ deleted: 1, failed: [] });
    expect(notion.pages.get(pageId)?.archived).toBe(true);
  });

  it("sync 는 pull 이 먼저 되살려 받아 지우지 않는다", async () => {
    const orchestrator = build();
    const pageId = await syncedNote(orchestrator);
    remoteEditThenLocalDelete(pageId);

    const result = await orchestrator.sync();

    expect(result.push).toMatchObject({ deleted: 0, failed: [] });
    expect(notion.pages.get(pageId)?.archived).toBe(false);
    expect(vault.read("Note.md")).toContain("Notion 에서 더함");
  });

  it("local-first 는 예전처럼 지운다 — 로컬이 이긴다", async () => {
    const orchestrator = build("local-first");
    const pageId = await syncedNote(orchestrator);
    remoteEditThenLocalDelete(pageId);

    const push = await orchestrator.push();

    expect(push).toMatchObject({ deleted: 1, failed: [] });
    expect(notion.pages.get(pageId)?.archived).toBe(true);
    expect(db.getByPath("Note.md")).toBeNull();
  });

  it("Notion 에서 고치지 않은 페이지는 지운다", async () => {
    const orchestrator = build();
    const pageId = await syncedNote(orchestrator);
    at("10:02:00");
    vault.files.delete("Note.md");

    const push = await orchestrator.push();

    expect(push).toMatchObject({ deleted: 1, failed: [] });
    expect(notion.pages.get(pageId)?.archived).toBe(true);
    expect(db.getByPath("Note.md")).toBeNull();
  });

  it("Notion 에서도 이미 지운 페이지는 다시 지우지 않고 추적만 놓는다", async () => {
    const orchestrator = build();
    const pageId = await syncedNote(orchestrator);
    at("10:02:00");
    notion.edit(pageId, (page) => {
      page.archived = true;
    });
    vault.files.delete("Note.md");
    at("10:03:00");

    const push = await orchestrator.push();

    expect(push).toMatchObject({ deleted: 1, failed: [] });
    expect(notion.client.archivePage).not.toHaveBeenCalled();
    expect(db.getByPath("Note.md")).toBeNull();
  });

  it("원격을 확인하지 못하면 지우지 않고 이유를 남긴다 — 읽지 못한 것을 사라진 것으로 보지 않는다", async () => {
    const orchestrator = build();
    const pageId = await syncedNote(orchestrator);
    at("10:02:00");
    vault.files.delete("Note.md");
    notion.client.getPage.mockRejectedValue(
      Object.assign(new Error("bad gateway"), { status: 502 }),
    );

    const push = await orchestrator.push();

    expect(push).toMatchObject({ deleted: 0 });
    expect(push.failed).toEqual([
      { path: "Note.md", operation: "delete", error: expect.stringContaining("bad gateway") },
    ]);
    expect(notion.pages.get(pageId)?.archived).toBe(false);
    expect(db.getByPath("Note.md")?.notionPageId).toBe(pageId);
  });
});
