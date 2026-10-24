/**
 * 설정이 뺀 경로의 추적 노트 (이슈 #8 둘째 증상).
 *
 * 추적하던 폴더를 `paths.exclude` 에 넣으면 그 노트들은 볼트 목록에서 빠진다. 예전에는 목록에 없는 추적
 * 노트를 「볼트에서 지움」 으로 보아 status 가 「deleted」 로 보이고, pull 은 「restored」 로 되살리려 했고,
 * deleteSync 면 push 가 Notion 페이지를 지울 수 있었다. 뺀 노트는 받지도 · 되살리지도 · 지우지도 않는다.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangeDetector } from "../../src/sync/change-detector.js";
import { StateDB } from "../../src/state/state-db.js";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import type { Config } from "../../src/types/config.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { computeHash } from "../../src/utils/hash.js";
import {
  createMockVaultFs,
  createMockStateDb,
  createMockNotionClient,
  createConfig,
} from "../helpers/mock-orchestrator.js";

const EXCLUDED = "Private/secret.md";
const excludes = (path: string) => path === "Private" || path.startsWith("Private/");

describe("ChangeDetector — 뺀 경로", () => {
  let tempDir: string;
  let db: StateDB;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-excl-"));
    db = StateDB.open(join(tempDir, "state.db"));
    for (const path of [EXCLUDED, "Notes/gone.md"]) {
      db.upsert({
        obsidianPath: path,
        notionPageId: `page-${path}`,
        contentHash: computeHash(path),
        localLastModified: "2026-10-01T00:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "synced",
      });
    }
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("목록에 없는 뺀 노트는 삭제가 아니다 — 지운 노트만 삭제다", () => {
    const changes = new ChangeDetector(db, excludes).detectLocalChanges([]);
    expect(changes.map((c) => [c.type, c.path])).toEqual([["deleted", "Notes/gone.md"]]);
  });

  it("뺀 노트를 같은 내용의 새 노트와 이동으로 짝짓지 않는다", () => {
    const changes = new ChangeDetector(db, excludes).detectLocalChanges([
      { path: "Notes/copy.md", content: EXCLUDED, mtime: "2026-10-02T00:00:00Z" },
    ]);
    expect(changes.find((c) => c.type === "moved")).toBeUndefined();
    expect(changes.find((c) => c.path === "Notes/copy.md")?.type).toBe("created");
  });
});

type Record = ReturnType<typeof makeRecord>;

function makeRecord(obsidianPath: string, pageId: string) {
  return {
    id: pageId,
    obsidianPath,
    notionPageId: pageId,
    notionParentId: "root-page-id",
    contentHash: computeHash("BODY"),
    notionLastEdited: "2026-10-01T00:00:00.000Z",
    localLastModified: "2026-10-01T00:00:00.000Z",
    syncDirection: "both",
    fileType: "file",
    status: "synced",
    localMtime: "2026-10-01T00:00:00.000Z",
    localFileSize: 4,
    baseSnapshot: Buffer.from("BODY", "utf-8"),
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

describe("SyncOrchestrator — 뺀 경로", () => {
  let vaultFs: ReturnType<typeof createMockVaultFs> & {
    excludesPath: (path: string, kind?: "file" | "folder") => boolean;
  };
  let stateDb: ReturnType<typeof createMockStateDb>;
  let notion: ReturnType<typeof createMockNotionClient>;
  const record: Record = makeRecord(EXCLUDED, "page-secret");

  beforeEach(() => {
    vaultFs = Object.assign(createMockVaultFs(), { excludesPath: excludes });
    stateDb = createMockStateDb();
    notion = createMockNotionClient();
    const lastFullPull = new Date().toISOString();
    stateDb.getMeta.mockImplementation((k: string) =>
      k === "last_pull_at"
        ? "2026-10-01T00:00:00.000Z"
        : k === "last_full_pull_at"
          ? lastFullPull
          : null,
    );
    stateDb.getAll.mockReturnValue([record]);
    stateDb.getByStatus.mockImplementation((status: string) =>
      status === "synced" ? [record] : [],
    );
    stateDb.getByPath.mockImplementation((path: string) =>
      path === record.obsidianPath ? record : null,
    );
    stateDb.getByNotionId.mockImplementation((id: string) =>
      id === record.notionPageId ? record : null,
    );
    // 뺀 폴더라 볼트 목록에 없다 — 파일은 디스크에 그대로 있다.
    vaultFs.listMarkdownFileStats.mockResolvedValue([]);
    vaultFs.listMarkdownFiles.mockResolvedValue([]);
    notion.getChildPagesRecursive.mockResolvedValue([]);
    notion.getPage.mockResolvedValue({
      id: record.notionPageId,
      last_edited_time: "2026-10-05T00:00:00.000Z",
      parent: { type: "page_id", page_id: "root-page-id" },
      properties: { title: { type: "title", title: [{ plain_text: "secret" }] } },
    });
  });

  function orchestrator(config: Config): SyncOrchestrator {
    return new SyncOrchestrator(config, stateDb as never, notion as never, vaultFs as never);
  }

  // 이슈의 재현 — `sync --dry-run` 이 뺀 노트를 Pull 「restored」 로 보였다.
  it("pull 은 뺀 노트를 되살리지 않는다", async () => {
    notion.searchRecentPages.mockResolvedValue([]);
    const result = await orchestrator(
      createConfig({ sync: { ...DEFAULT_CONFIG.sync, deleteSync: false } }),
    ).pull({ dryRun: true });

    expect(result.restored).toBe(0);
  });

  it("pull 은 Notion 에서 바뀐 뺀 노트를 받지 않는다", async () => {
    notion.searchRecentPages.mockResolvedValue([
      {
        id: record.notionPageId,
        last_edited_time: "2026-10-05T00:00:00.000Z",
        parent: { type: "page_id", page_id: "root-page-id" },
      },
    ]);
    const result = await orchestrator(
      createConfig({ sync: { ...DEFAULT_CONFIG.sync, deleteSync: false } }),
    ).pull({ dryRun: true });

    expect(result.updated + result.restored).toBe(0);
  });

  it("deleteSync 여도 push 는 뺀 노트의 Notion 페이지를 지우지 않는다", async () => {
    const result = await orchestrator(
      createConfig({ sync: { ...DEFAULT_CONFIG.sync, deleteSync: true } }),
    ).push({ dryRun: true });

    expect(result.deleted).toBe(0);
  });

  it("status 에 뺀 노트가 「deleted」 로 보이지 않는다", async () => {
    const status = await orchestrator(createConfig()).statusLocal();
    expect(status.localChanges.filter((c) => c.type === "deleted")).toEqual([]);
  });
});
