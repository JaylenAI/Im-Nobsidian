/**
 * FilteredVaultFS — 플러그인이 경로 패턴을 대는 감싸개. CLI(NodeVaultFS)와 같은 결과여야 한다.
 *
 * 메모리 볼트 · 메모리 Notion · 실제 StateDB 로, 패턴이 뺀 노트를 올리지 않고 · 동기화하던 노트를 빼도 지우지
 * 않는 것을 본다(이슈 #8 의 CLI 쪽 동작과 같다).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { FilteredVaultFS } from "../../src/sync/filtered-vault-fs.js";
import { ScopedVaultFS } from "../../src/sync/connection-folders.js";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { PathFilter } from "../../src/utils/path-filter.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const ROOT = "root-page-id";

describe("FilteredVaultFS", () => {
  it("목록에서 패턴이 뺀 노트 · 첨부를 지우고 excludesPath 로 답한다", async () => {
    const vault = new MemoryVault();
    for (const path of ["Work/a.md", "Work/Private/b.md", "Home/c.md"]) vault.write(path, "x\n");
    const inner = vault.fs();
    // 메모리 볼트는 첨부를 세지 않는다 — 목록만 준다
    const attachment = (path: string) => ({ path, size: 1, mtime: "2026-10-26T00:00:00.000Z" });
    inner.listNonMarkdownFiles.mockResolvedValue([
      attachment("Work/x.pdf"),
      attachment("Home/y.pdf"),
    ]);
    const fs = new FilteredVaultFS(inner, new PathFilter(["Work/**"], ["Work/Private"]));

    expect((await fs.listMarkdownFiles()).map((f) => f.path).sort()).toEqual(["Work/a.md"]);
    expect((await fs.listMarkdownFileStats()).map((f) => f.path)).toEqual(["Work/a.md"]);
    expect((await fs.listNonMarkdownFiles()).map((f) => f.path)).toEqual(["Work/x.pdf"]);
    expect(fs.excludesPath("Home/c.md")).toBe(true);
    expect(fs.excludesPath("Work/Private/b.md")).toBe(true);
    expect(fs.excludesPath("Work/Private", "folder")).toBe(true);
    // 포함 패턴은 폴더를 거르지 않는다 — 안의 파일이 정한다
    expect(fs.excludesPath("Home", "folder")).toBe(false);
    expect(fs.excludesPath("Work/a.md")).toBe(false);
  });

  it("감싼 VaultFS 의 답을 잇는다 — 연결 경계(ownsPath)는 감싼 쪽에 있을 때만 둔다", () => {
    const vault = new MemoryVault();
    const plain = new FilteredVaultFS(vault.fs(), new PathFilter([], ["Private"]));
    expect(plain.ownsPath).toBeUndefined();
    expect(plain.holdsOtherConnection).toBeUndefined();

    const scoped = new ScopedVaultFS(vault.fs(), "", ["", "Work"]);
    const fs = new FilteredVaultFS(scoped, new PathFilter([], ["Private"]));
    expect(fs.ownsPath!("Work/a.md")).toBe(false);
    expect(fs.ownsPath!("Home/a.md")).toBe(true);
    expect(fs.holdsOtherConnection!("")).toBe(true);
  });
});

describe("경로 패턴을 댄 볼트의 동기화", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-filtered-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  function orchestrator(exclude: string[]): SyncOrchestrator {
    return new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: ROOT, databases: [] },
        sync: { ...DEFAULT_CONFIG.sync, deleteSync: true },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      new FilteredVaultFS(vault.fs(), new PathFilter([], exclude)),
    );
  }

  it("뺀 노트는 올리지 않는다", async () => {
    vault.write("Work/a.md", "a\n");
    vault.write("Private/b.md", "b\n");

    const result = await orchestrator(["Private"]).push();

    expect(result.failed).toEqual([]);
    expect(db.getByPath("Work/a.md")).not.toBeNull();
    expect(db.getByPath("Private/b.md")).toBeNull();
  });

  it("동기화하던 노트를 빼도 Notion 페이지를 지우지 않고 · 되살리지도 않는다 (deleteSync)", async () => {
    vault.write("Work/a.md", "a\n");
    vault.write("Private/b.md", "b\n");
    expect((await orchestrator([]).push()).failed).toEqual([]);
    const pageId = db.getByPath("Private/b.md")!.notionPageId!;

    const later = orchestrator(["Private"]);
    const status = await later.status();
    const push = await later.push();
    const pull = await later.pull({ force: true });

    expect(status.localChanges).toEqual([]);
    expect(push).toMatchObject({ deleted: 0, failed: [] });
    expect(notion.pages.get(pageId)?.archived ?? false).toBe(false);
    expect(pull).toMatchObject({ created: 0, restored: 0, deleted: 0 });
    expect(vault.read("Private/b.md")).toBe("b\n");
  });
});
