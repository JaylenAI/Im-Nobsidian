/**
 * 볼트 하나에 연결 여럿 (ADR-038) — 연결 폴더마다 자기 상태 DB · Notion 으로 동기화하고, 바깥 연결은
 * 안쪽 연결 폴더를 올리지도 덮어쓰지도 않는다.
 *
 * 실제 StateDB(임시 파일) 둘 · 메모리 볼트 하나 · 메모리 Notion 둘로 끝까지 돌린다.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import {
  ConnectionBoundaryError,
  ConnectionScopeError,
  ScopedVaultFS,
  configDirFrom,
  connectionFolderOf,
  normalizeVaultPath,
} from "../../src/sync/connection-folders.js";
import { findConnectionFolders } from "../../src/sync/node-connection-folders.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const CONNECTIONS = ["", "Work"];

describe("연결 폴더 경로", () => {
  it("가장 깊은 연결이 맡는다 · 경계는 경로 조각이다", () => {
    expect(connectionFolderOf("Work/a.md", CONNECTIONS)).toBe("Work");
    expect(connectionFolderOf("Workshop/a.md", CONNECTIONS)).toBe("");
    expect(connectionFolderOf("a.md", ["Work"])).toBeNull();
    expect(connectionFolderOf("Work/Team/a.md", ["", "Work", "Work/Team"])).toBe("Work/Team");
  });

  it("경로를 풀고 볼트 밖은 null", () => {
    expect(normalizeVaultPath("Work/../.obsidian/types.json")).toBe(".obsidian/types.json");
    expect(normalizeVaultPath("/a//b/./c/")).toBe("a/b/c");
    expect(normalizeVaultPath("../x")).toBeNull();
    expect(configDirFrom("Work/Team", ".obsidian")).toBe("../../.obsidian");
    expect(configDirFrom("", ".obsidian")).toBe(".obsidian");
  });
});

describe("ScopedVaultFS", () => {
  let vault: MemoryVault;

  beforeEach(() => {
    vault = new MemoryVault();
    vault.write("root.md", "r");
    vault.write("Workshop/w.md", "w");
    vault.write("Work/a.md", "a");
    vault.write("Work/.im-nobsidian/db-views.json", "{}");
    vault.write(".obsidian/types.json", '{"types":{}}');
  });

  it("폴더 안에 다른 연결이 있는지 — 폴더를 통째로 옮기기 전에 묻는다(ADR-039)", () => {
    const top = new ScopedVaultFS(vault.fs(), "", ["", "Projects/Work"]);
    expect(top.holdsOtherConnection("Projects")).toBe(true);
    expect(top.holdsOtherConnection("Projects/Work")).toBe(true);
    expect(top.holdsOtherConnection("Project")).toBe(false);
    expect(top.holdsOtherConnection("Other")).toBe(false);
    const nested = new ScopedVaultFS(vault.fs(), "Projects", ["", "Projects", "Projects/Work"]);
    expect(nested.holdsOtherConnection("")).toBe(true);
    expect(nested.holdsOtherConnection("Notes")).toBe(false);
  });

  it("하위 연결은 자기 폴더의 노트만 자기 기준 경로로 본다", async () => {
    const work = new ScopedVaultFS(vault.fs(), "Work", CONNECTIONS);
    expect((await work.listMarkdownFiles()).map((f) => [f.path, f.content])).toEqual([
      ["a.md", "a"],
    ]);
    expect(await work.readFile("../.obsidian/types.json")).toBe('{"types":{}}');
    await work.writeFile("b.md", "b");
    expect(vault.read("Work/b.md")).toBe("b");
    await expect(work.writeFile("../root.md", "x")).rejects.toBeInstanceOf(ConnectionBoundaryError);
    expect(vault.read("root.md")).toBe("r");
  });

  it("맨 위 연결은 안쪽 연결 폴더를 목록에서 빼고 쓰기를 거절한다 — 이름이 비슷한 폴더는 그대로", async () => {
    const root = new ScopedVaultFS(vault.fs(), "", CONNECTIONS);
    expect((await root.listMarkdownFileStats()).map((f) => f.path).sort()).toEqual([
      "Workshop/w.md",
      "root.md",
    ]);
    await expect(root.writeFile("Work/a.md", "덮어쓰기")).rejects.toThrow(/다른 연결 폴더\(Work\)/);
    await expect(root.moveFile("root.md", "Work/root.md")).rejects.toBeInstanceOf(
      ConnectionBoundaryError,
    );
    expect(vault.read("Work/a.md")).toBe("a");
  });
});

describe("findConnectionFolders", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "im-nobsidian-connections-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("자기 내부 폴더를 둔 폴더를 찾는다 — 점 폴더 안은 보지 않는다", async () => {
    for (const sub of [".im-nobsidian", "Work/.im-nobsidian", "Work/Team/.im-nobsidian", "Plain"]) {
      await mkdir(join(dir, sub), { recursive: true });
    }
    await mkdir(join(dir, ".trash/Old/.im-nobsidian"), { recursive: true });
    await writeFile(join(dir, "Plain/n.md"), "n");
    expect((await findConnectionFolders(dir)).sort()).toEqual(["", "Work", "Work/Team"]);
  });
});

describe("두 연결을 한 볼트에서 끝까지", () => {
  let tempDir: string;
  let rootDb: StateDB;
  let workDb: StateDB;
  let vault: MemoryVault;
  let rootNotion: ReturnType<typeof memoryNotion>;
  let workNotion: ReturnType<typeof memoryNotion>;
  let root: SyncOrchestrator;
  let work: SyncOrchestrator;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-two-connections-"));
    rootDb = StateDB.open(join(tempDir, "root.db"));
    workDb = StateDB.open(join(tempDir, "work.db"));
    vault = new MemoryVault();
    rootNotion = memoryNotion();
    workNotion = memoryNotion();
    const config = createConfig({ advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 } });
    root = new SyncOrchestrator(
      config,
      rootDb,
      rootNotion.client as never,
      new ScopedVaultFS(vault.fs(), "", CONNECTIONS),
    );
    work = new SyncOrchestrator(
      config,
      workDb,
      workNotion.client as never,
      new ScopedVaultFS(vault.fs(), "Work", CONNECTIONS),
    );
  });

  afterEach(async () => {
    rootDb.close();
    workDb.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const titles = (notion: ReturnType<typeof memoryNotion>) =>
    [...notion.pages.values()].map((p) => p.title).sort();

  it("각 연결은 자기 폴더만 자기 Notion 에 올린다", async () => {
    vault.write("개인.md", "개인 노트\n");
    vault.write("Work/회의.md", "회의 노트\n");

    expect(await root.push()).toMatchObject({ created: 1, failed: [] });
    expect(await work.push()).toMatchObject({ created: 1, failed: [] });

    expect(titles(rootNotion)).toEqual(["개인"]);
    expect(titles(workNotion)).toEqual(["회의"]);
    expect(workDb.getByPath("회의.md")?.notionPageId).toBeTruthy();
    expect(rootDb.getByPath("Work/회의.md")).toBeNull();
  });

  it("바깥 연결의 pull 은 안쪽 연결 폴더에 쓰지 않고 실패로 알린다", async () => {
    vault.write("Work/a.md", "work 의 노트\n");
    const remote = rootNotion.add("root-page-id", "Work", "폴더 페이지");
    rootNotion.add(remote.id, "a", "바깥 Notion 의 같은 이름 페이지");

    const result = await root.pull();

    expect(vault.read("Work/a.md")).toBe("work 의 노트\n");
    expect(result.failed.map((f) => f.error).join("\n")).toMatch(/다른 연결 폴더\(Work\)/);
    // 다시 해도 같은 실패라 재시도하지 않고, 내부 id 가 아니라 볼트 자리로 알린다.
    expect(result.failed.map((f) => f.path)).toContain("Work");
  });

  it("이미 동기화하던 폴더를 따로 연결하면 바깥 연결은 아무것도 하지 않고 멈춘다", async () => {
    vault.write("Work/회의.md", "회의 노트\n");
    const before = new SyncOrchestrator(
      createConfig({
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
        sync: { ...DEFAULT_CONFIG.sync, deleteSync: true },
      }),
      rootDb,
      rootNotion.client as never,
      new ScopedVaultFS(vault.fs(), "", [""]),
    );
    expect(await before.push()).toMatchObject({ failed: [] });
    expect(rootDb.getByPath("Work/회의.md")?.notionPageId).toBeTruthy();
    const archive = rootNotion.client.archivePage.mock.calls.length;

    // 이제 Work 를 따로 연결했다 — 바깥 연결의 목록에서 Work/회의.md 가 사라진다.
    await expect(root.push()).rejects.toBeInstanceOf(ConnectionScopeError);
    await expect(root.pull()).rejects.toThrow(/Work\/회의\.md/);
    await expect(root.statusLocal()).rejects.toBeInstanceOf(ConnectionScopeError);
    expect(rootNotion.client.archivePage.mock.calls.length).toBe(archive);
    expect(rootDb.getByPath("Work/회의.md")).not.toBeNull();
  });
});
