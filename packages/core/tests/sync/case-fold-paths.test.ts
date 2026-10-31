/**
 * P9 — 대소문자만 다른 이름. macOS(APFS 기본) · Windows 는 `Note.md` 와 `note.md` 를 같은 파일로 연다. 받으며 두 페이지에
 * 이 두 이름을 주면 나중에 쓴 페이지가 앞의 파일을 덮는다. 메모리 볼트는 대소문자를 가리므로(Linux 처럼) 여기서는 고른
 * 이름이 `pathKey` 로 겹치지 않는지 본다.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { pathKey } from "../../src/utils/path-key.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const ROOT = "root-page-id";
const DB_ID = "db000000-0000-4000-8000-0000000000d1";

describe("대소문자만 다른 이름 (P9)", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-casefold-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
    notion.client.getDatabaseSchema.mockResolvedValue({ Name: { id: "title", type: "title" } });
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

  const sync = (renameOnTitleChange = false) =>
    new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: ROOT, databases: [] },
        sync: { ...DEFAULT_CONFIG.sync, fullReconcileInterval: 0, renameOnTitleChange },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );
  const notes = (prefix = "") =>
    [...vault.files.keys()].filter((path) => path.endsWith(".md") && path.startsWith(prefix));
  const distinctKeys = (paths: string[]) => new Set(paths.map(pathKey)).size;

  it("같은 pull 에서 받는 두 페이지는 대소문자만 다른 이름을 얻지 않는다", async () => {
    notion.add(ROOT, "Note", "위");
    notion.add(ROOT, "note", "아래");
    notion.add(ROOT, "NOTE", "셋째");

    expect((await sync().pull()).failed).toEqual([]);
    expect(notes()).toHaveLength(3);
    expect(distinctKeys(notes())).toBe(3);
    const bodies = notes().map((path) => vault.read(path));
    for (const body of ["위", "아래", "셋째"]) {
      expect(bodies.filter((text) => text.includes(body))).toHaveLength(1);
    }
    expect(await sync().pull()).toMatchObject({ created: 0, updated: 0, moved: [] });
  });

  it("이미 받은 노트와 대소문자만 다른 새 페이지는 id 를 단 이름으로 받는다", async () => {
    notion.add(ROOT, "Note", "위");
    await sync().pull();
    notion.add(ROOT, "NOTE", "새");

    expect((await sync().pull()).failed).toEqual([]);
    expect(notes()).toHaveLength(2);
    expect(notes()).toContain("Note.md");
    expect(distinctKeys(notes())).toBe(2);
  });

  it("Notion 에서 제목의 대소문자만 바꾸면 그 노트의 이름이 따른다 — id 를 달지 않는다", async () => {
    const page = notion.add(ROOT, "Note", "본문");
    await sync(true).pull();
    notion.edit(page.id, (p) => {
      p.title = "NOTE";
    });

    expect((await sync(true).pull()).failed).toEqual([]);
    expect(notes()).toEqual(["NOTE.md"]);
  });

  it("DB 행도 — 대소문자만 다른 두 행은 다른 파일이 된다", async () => {
    notion.databases.set(DB_ID, { parent: ROOT, title: "Tasks" });
    db.setMeta(
      "discovered_dbs",
      JSON.stringify([{ databaseId: DB_ID, localFolder: "Tasks", titleProperty: "Name" }]),
    );
    notion.add(DB_ID, "Task", "위", { properties: {} });
    notion.add(DB_ID, "task", "아래", { properties: {} });

    expect((await sync().pull()).failed).toEqual([]);
    expect(notes("Tasks/")).toHaveLength(2);
    expect(distinctKeys(notes("Tasks/"))).toBe(2);
    expect(await sync().pull()).toMatchObject({ created: 0, updated: 0, moved: [] });
  });
});
