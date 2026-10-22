/**
 * B14 — 이미 받아 둔 노트를 지금 변환기로 다시 그리기(`pull({ rerender: true })`).
 *
 * pull 은 Notion 에서 바뀐 페이지만 받아, 변환기가 나아져도 받아 둔 노트는 옛 모양으로 남았다 — 북마크가
 * Notion 블록을 가리키는 「🔖 Bookmark」(실볼트 166개 · 54노트). `--force` 도 다시 그리지 않았다.
 *
 * 여기서는 북마크 블록을 읽지 못한 채 받은 노트가 옛 모양이다 — 예전 변환기가 쓴 것과 같은 글이다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { BookmarkTarget } from "../../src/types/convert.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DB_ID = "db000000-0000-4000-8000-0000000000b1";
const BLOCK = "3ef13b1800014000800000000071c0e0";
const tag = (page: string) =>
  `<unknown url="https://app.notion.com/p/${page.replace(/-/g, "")}#${BLOCK}" alt="bookmark"/>`;
const OLD_LINK = "[🔖 Bookmark](";
const NEW_LINK = "[🔖 예시 사이트](https://example.com/)";

describe("B14 — 받아 둔 노트 다시 그리기", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let bookmarks: Map<string, BookmarkTarget>;

  const build = (): SyncOrchestrator =>
    new SyncOrchestrator(
      createConfig({
        notion: {
          token: "ntn_test_token",
          rootPageId: "root-page-id",
          databases: [{ databaseId: DB_ID, localFolder: "Tasks", titleProperty: "Name" }],
        },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );

  /** Notion 페이지 하나 — 북마크 블록을 읽지 못한 채(옛 변환기처럼) 받아 둔다. */
  const pulledWithOldBookmark = async (title: string, parent = "root-page-id") => {
    const page = notion.add(parent, title, "");
    notion.edit(page.id, (p) => {
      p.body = `글\n${tag(page.id)}`;
    });
    expect(await build().pull()).toMatchObject({ failed: [] });
    return page;
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-rerender-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
    bookmarks = new Map();
    Object.assign(notion.client, {
      getBookmarks: vi.fn(async (ids: readonly string[]) => {
        const found = new Map<string, BookmarkTarget>();
        for (const id of ids) if (bookmarks.has(id)) found.set(id, bookmarks.get(id)!);
        return found;
      }),
    });
    notion.client.getDatabaseSchema.mockResolvedValue({
      Name: { id: "title", type: "title" },
    });
    notion.client.getDatabaseViewsConfig.mockResolvedValue({
      databaseId: DB_ID,
      lastSynced: "",
      views: [],
    });
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("옛 북마크가 있는 노트를 Notion 이 그대로여도 새 링크로 다시 그린다", async () => {
    await pulledWithOldBookmark("북마크");
    expect(vault.read("북마크.md")).toContain(OLD_LINK);
    bookmarks.set(BLOCK, { url: "https://example.com/", caption: "예시 사이트" });

    expect(await build().pull()).toMatchObject({ updated: 0 });
    expect(vault.read("북마크.md")).toContain(OLD_LINK);

    expect(await build().pull({ rerender: true })).toMatchObject({ updated: 1, failed: [] });
    expect(vault.read("북마크.md")).toContain(NEW_LINK);
    expect(vault.read("북마크.md")).not.toContain(OLD_LINK);
  });

  it("다시 그린 노트는 다음 push · pull 이 바꾸지 않는다 — 두 번째 다시 그리기도 쓰지 않는다", async () => {
    await pulledWithOldBookmark("북마크");
    bookmarks.set(BLOCK, { url: "https://example.com/", caption: "예시 사이트" });
    await build().pull({ rerender: true });
    const after = vault.read("북마크.md");
    const pushed = notion.client.replacePageMarkdown.mock.calls.length;

    expect(await build().push()).toMatchObject({ updated: 0, failed: [] });
    expect(notion.client.replacePageMarkdown.mock.calls.length).toBe(pushed);
    expect(await build().pull({ rerender: true })).toMatchObject({ updated: 0, failed: [] });
    expect(vault.read("북마크.md")).toBe(after);
  });

  it("진행 알림은 다시 그린 노트와 바뀌지 않은 노트를 가른다", async () => {
    await pulledWithOldBookmark("가");
    await pulledWithOldBookmark("나");
    bookmarks.set(BLOCK, { url: "https://example.com/", caption: "예시 사이트" });
    await build().pull({ rerender: true, paths: ["가.md"] });

    const items: Array<[string, boolean]> = [];
    await build().pull({
      rerender: true,
      onProgress: (_done, _total, item) => items.push([item.path, item.unchanged === true]),
    });

    expect(items.sort()).toEqual([
      ["가.md", true],
      ["나.md", false],
    ]);
  });

  it("볼트에서 고친 노트는 다시 그리지 않고, 그 페이지를 읽지도 않는다", async () => {
    const page = await pulledWithOldBookmark("고친");
    bookmarks.set(BLOCK, { url: "https://example.com/", caption: "예시 사이트" });
    const edited = `${vault.read("고친.md")}\n내가 더한 줄\n`;
    vault.write("고친.md", edited);
    notion.client.getPage.mockClear();

    expect(await build().pull({ rerender: true })).toMatchObject({ updated: 0, conflicts: [] });

    expect(vault.read("고친.md")).toBe(edited);
    expect(notion.client.getPage.mock.calls.map(([id]) => id)).not.toContain(page.id);
  });

  it("경로를 좁히면 그 안의 노트만 다시 그린다", async () => {
    await pulledWithOldBookmark("가");
    await pulledWithOldBookmark("나");
    bookmarks.set(BLOCK, { url: "https://example.com/", caption: "예시 사이트" });

    expect(await build().pull({ rerender: true, paths: ["가.md"] })).toMatchObject({
      updated: 1,
    });

    expect(vault.read("가.md")).toContain(NEW_LINK);
    expect(vault.read("나.md")).toContain(OLD_LINK);
  });

  it("Notion 에서도 바뀐 페이지는 한 번만 받는다", async () => {
    const page = await pulledWithOldBookmark("북마크");
    bookmarks.set(BLOCK, { url: "https://example.com/", caption: "예시 사이트" });
    notion.edit(page.id, (p) => {
      p.body = `글 고침\n${tag(page.id)}`;
    });
    notion.client.getPageMarkdown.mockClear();

    expect(await build().pull({ rerender: true })).toMatchObject({ updated: 1, failed: [] });

    expect(notion.client.getPageMarkdown).toHaveBeenCalledTimes(1);
    expect(vault.read("북마크.md")).toContain("글 고침");
  });

  it("충돌 중인 노트는 다시 그리지 않는다 — 충돌 해결로 고른다", async () => {
    await pulledWithOldBookmark("충돌");
    bookmarks.set(BLOCK, { url: "https://example.com/", caption: "예시 사이트" });
    db.updateStatus(db.getByPath("충돌.md")!.id, "conflict");

    expect(await build().pull({ rerender: true })).toMatchObject({ updated: 0 });

    expect(vault.read("충돌.md")).toContain(OLD_LINK);
    expect(db.getByPath("충돌.md")!.status).toBe("conflict");
  });

  it("dry-run 은 다시 그리지 않는다", async () => {
    await pulledWithOldBookmark("북마크");
    bookmarks.set(BLOCK, { url: "https://example.com/", caption: "예시 사이트" });
    notion.client.getPageMarkdown.mockClear();

    await build().pull({ rerender: true, dryRun: true });

    expect(notion.client.getPageMarkdown).not.toHaveBeenCalled();
    expect(vault.read("북마크.md")).toContain(OLD_LINK);
  });

  it("DB 행도 다시 그린다 — 속성 줄은 그대로", async () => {
    const row = notion.add(DB_ID, "행", "", { properties: {} });
    notion.edit(row.id, (p) => {
      p.body = `글\n${tag(row.id)}`;
    });
    await build().pull();
    const before = vault.read("Tasks/행.md")!;
    expect(before).toContain(OLD_LINK);
    bookmarks.set(BLOCK, { url: "https://example.com/", caption: "예시 사이트" });

    expect(await build().pull({ rerender: true })).toMatchObject({ updated: 1, failed: [] });

    const after = vault.read("Tasks/행.md")!;
    expect(after).toContain(NEW_LINK);
    expect(after.split("---")[1]).toBe(before.split("---")[1]);
    expect(await build().pull({ rerender: true })).toMatchObject({ updated: 0 });
  });
});
