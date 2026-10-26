/**
 * Notion 에 새로 생긴 페이지가 동기화에서 뺀 자리(paths · .im-nobsidian-ignore)에 놓일 것이면 받지 않고 알린다.
 *
 * 예전에는 받았다 — 받은 노트는 목록에서 빠져(이슈 #8) 다음 push 가 보지 못하고, 볼트에는 사용자가 뺀 폴더에 파일이 생겼다.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { FilteredVaultFS } from "../../src/sync/filtered-vault-fs.js";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { PathFilter } from "../../src/utils/path-filter.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const ROOT = "root-page-id";

describe("뺀 자리에 놓일 새 원격 페이지", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-excluded-create-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const orchestrator = (include: string[], exclude: string[]) =>
    new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: ROOT, databases: [] },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      new FilteredVaultFS(vault.fs(), new PathFilter(include, exclude)),
    );
  const notes = () => [...vault.files.keys()].filter((path) => path.endsWith(".md")).sort();

  it("뺀 폴더 아래의 새 페이지 · 그 하위 페이지는 받지 않고 경로를 알린다", async () => {
    vault.write("Private/secret.md", "s\n");
    vault.write("Work/a.md", "a\n");
    // 뺀 폴더는 올리지 않는다 — 폴더 페이지는 Notion 에서 만든다
    const privateFolder = notion.add(ROOT, "Private", "");
    expect((await orchestrator([], []).push()).failed).toEqual([]);
    const sync = orchestrator([], ["Private"]);
    const fresh = notion.add(privateFolder.id, "새 글", "본문");
    notion.add(fresh.id, "하위", "하위 본문");
    notion.add(ROOT, "공개", "공개 본문");

    const result = await sync.pull({ force: true });

    expect(result.failed).toEqual([]);
    expect(result.excluded).toEqual(expect.arrayContaining(["Private/새 글.md"]));
    expect(notes()).toEqual(expect.not.arrayContaining([expect.stringMatching(/^Private\/새 글/)]));
    expect(notes()).toContain("공개.md");
    expect(db.getByNotionId(fresh.id)).toBeNull();
    expect(await sync.push()).toMatchObject({ created: 0, updated: 0, deleted: 0, failed: [] });
  });

  it("포함 패턴 밖의 새 페이지도 받지 않는다", async () => {
    const sync = orchestrator(["Work/**"], []);
    notion.add(ROOT, "맨 위", "본문");

    const result = await sync.pull({ force: true });

    expect(result.created).toBe(0);
    expect(result.excluded).toEqual(["맨 위.md"]);
    expect(notes()).toEqual([]);
  });

  it("status 는 받지 않을 새 페이지를 원격 변경과 따로 보인다", async () => {
    const sync = orchestrator([], ["Private"]);
    const folder = notion.add(ROOT, "Private", "");
    notion.add(folder.id, "새 글", "본문");
    notion.add(ROOT, "공개", "본문");

    const status = await sync.status();

    expect(status.remoteExcluded).toEqual(expect.arrayContaining(["Private/새 글.md"]));
    expect(status.remoteChanges.map((change) => change.title ?? change.pageId)).not.toContain(
      "새 글",
    );
    expect(status.remoteChanges.map((change) => change.title)).toContain("공개");
  });

  it("dry-run 도 받지 않을 것으로 알린다", async () => {
    const sync = orchestrator([], ["Private"]);
    const folder = notion.add(ROOT, "Private", "");
    notion.add(folder.id, "새 글", "본문");

    const result = await sync.pull({ force: true, dryRun: true });

    expect(result.excluded).toEqual(expect.arrayContaining(["Private/새 글.md"]));
  });
});
