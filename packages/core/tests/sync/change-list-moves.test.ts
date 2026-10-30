/**
 * 옮긴 노트 · 폴더를 변경 목록과 진행 표시에 «옮김» 으로 보인다.
 *
 * 예전에는 변경 목록(status)이 폴더 이동을 싣지 않았고, push 는 옮긴 노트를 「수정」 으로 세고
 * 알렸으며 폴더 이동은 수에만 넣고 항목으로 알리지 않았다. 이름만 바꾼 노트도 「수정 1」 로 보였다.
 * `sync` 는 받기 · 올리기 항목을 한 콜백으로 알려 화면이 둘을 가를 수 없었다.
 *
 * 실제 StateDB(임시 파일)와 메모리 볼트 · 메모리 Notion 으로, 처음 push 가 만든 레코드를 그대로
 * 이어 쓴다.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { ProgressItem } from "../../src/types/sync.js";
import { computeHash } from "../../src/utils/hash.js";
import { BASE_FILE_HEADER } from "../../src/view/base-file-generator.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const ROOT = "root-page-id";
const DB_ID = "dbdbdbdb-0000-4000-8000-000000000001";

describe("옮긴 노트 · 폴더를 변경 목록과 진행 표시에 옮김으로 보인다", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let orchestrator: SyncOrchestrator;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-change-list-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
    orchestrator = new SyncOrchestrator(
      createConfig({ advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 } }),
      db,
      notion.client as never,
      vault.fs(),
    );
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function seed(files: Record<string, string>): Promise<void> {
    for (const [path, content] of Object.entries(files)) vault.write(path, content);
    expect((await orchestrator.push()).failed).toEqual([]);
  }

  /** 상태 DB 의 모습 — 레코드 경로와 끝나지 않은 작업. 변경 목록은 이것을 바꾸지 않는다. */
  const stateSnapshot = () => ({
    paths: db
      .getAll()
      .map((r) => r.obsidianPath)
      .sort(),
    ops: db.getIncompletePendingOperations().length,
    discovered: db.getMeta("discovered_dbs"),
  });

  /** 진행 항목을 모은다 — 순서는 워커 풀이 정하므로 폴더(앞)와 노트(뒤)를 따로 비교한다. */
  function collect(): { items: ProgressItem[]; totals: number[]; onProgress: ProgressCallback } {
    const items: ProgressItem[] = [];
    const totals: number[] = [];
    return {
      items,
      totals,
      onProgress: (_current, total, item) => {
        items.push(item);
        totals.push(total);
      },
    };
  }
  type ProgressCallback = (current: number, total: number, item: ProgressItem) => void;

  it("폴더를 옮기면 변경 목록이 폴더 이동과 안의 노트 옮김을 보이고, 상태를 바꾸지 않는다", async () => {
    await seed({ "A/x.md": "# X\n", "A/y.md": "# Y\n" });
    vault.renameFolder("A", "B");
    const before = stateSnapshot();

    const local = await orchestrator.statusLocal();
    const full = await orchestrator.status();

    for (const status of [local, full]) {
      expect(status.folderMoves).toEqual([{ from: "A", to: "B" }]);
      expect(status.localChanges.map((c) => [c.type, c.movedFrom, c.path]).sort()).toEqual([
        ["moved", "A/x.md", "B/x.md"],
        ["moved", "A/y.md", "B/y.md"],
      ]);
    }
    expect(stateSnapshot()).toEqual(before);
  });

  it("push 는 옮긴 폴더 · 노트를 move 로 알리고 moved 로 센다 — 수정으로 세지 않는다. dry-run 도 같다", async () => {
    await seed({ "A/x.md": "# X\n", "A/y.md": "# Y\n" });
    // 플러그인이 볼트의 폴더 이름 변경을 알린다 — 내용도 바꾼 노트는 이 힌트로 짝을 찾는다.
    vault.renameFolder("A", "B");
    orchestrator.recordLocalRename("A", "B", "folder");
    vault.write("B/y.md", "# Y\n\nedited\n");

    const dry = collect();
    const planned = await orchestrator.push({ dryRun: true, onProgress: dry.onProgress });
    const real = collect();
    const pushed = await orchestrator.push({ onProgress: real.onProgress });

    for (const [result, run] of [
      [planned, dry],
      [pushed, real],
    ] as const) {
      expect(result).toMatchObject({ created: 0, updated: 0, deleted: 0, moved: 3, failed: [] });
      // 옮긴 폴더가 먼저다 — 그 아래로 옮긴 노트의 부모다.
      expect(run.items[0]).toEqual({ path: "B", operation: "move" });
      expect(run.items.slice(1).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
        { path: "B/x.md", operation: "move" },
        { path: "B/y.md", operation: "move" },
      ]);
      expect(run.totals).toEqual([3, 3, 3]);
    }
    // 옮기며 고친 본문도 올라갔다.
    expect(notion.pages.get(db.getByPath("B/y.md")!.notionPageId!)!.body).toContain("edited");
    expect((await orchestrator.statusLocal()).folderMoves).toEqual([]);
  });

  it("DB 폴더를 옮기면 변경 목록에 보이고, push 는 Notion 의 DB 를 새 폴더의 페이지 아래로 옮기고 보기 · 기록한 .base 경로를 옮겨 적는다", async () => {
    db.setMeta(
      "discovered_dbs",
      JSON.stringify([{ databaseId: DB_ID, localFolder: "Tasks", titleProperty: "Name" }]),
    );
    const content = "---\ntitle: Row\nstatus: todo\n---\nRow body\n";
    vault.write("Tasks/Row.md", content);
    const page = notion.add(DB_ID, "Row");
    const stat = vault.stat("Tasks/Row.md")!;
    db.upsert({
      obsidianPath: "Tasks/Row.md",
      notionPageId: page.id,
      notionParentId: DB_ID,
      contentHash: computeHash(content),
      notionLastEdited: page.lastEdited,
      localLastModified: stat.mtime,
      syncDirection: "both",
      fileType: "db-row",
      status: "synced",
      baseSnapshot: Buffer.from(content, "utf-8"),
      localMtime: stat.mtime,
      localFileSize: stat.size,
    });
    // 바뀐 DB 만 조회한다(ADR-027) — 다음 pull 이 DB 를 받지 않아도 보기 · 임베드가 새 자리를 가리켜야 한다.
    const view = `${BASE_FILE_HEADER} from Notion\nfilters:\n  and:\n    - file.inFolder("Tasks")\n`;
    vault.write("Tasks/Tasks.base", view);
    const mine = 'filters:\n  and:\n    - file.inFolder("Tasks")\n';
    vault.write("Tasks/mine.base", mine);
    db.setMeta(
      "db_base_files",
      JSON.stringify({
        [DB_ID.replace(/-/g, "")]: {
          basePath: "Tasks/Tasks.base",
          title: "Tasks",
          hash: computeHash(view),
        },
      }),
    );
    db.setMeta(
      "created_dbs",
      JSON.stringify({ src: { databaseId: DB_ID, folder: "Tasks", schemaDone: false } }),
    );
    notion.databases.set(DB_ID, { parent: ROOT, title: "Tasks" });
    vault.renameFolder("Tasks", "Work/Tasks");

    const status = await orchestrator.statusLocal();
    expect(status.folderMoves).toEqual([{ from: "Tasks", to: "Work/Tasks" }]);
    const preview = await orchestrator.push({ dryRun: true });
    expect(preview.databaseMoves).toEqual([{ from: "Tasks", to: "Work/Tasks" }]);
    expect(notion.client.updateDatabasePlacement).not.toHaveBeenCalled();

    const result = await orchestrator.push();

    expect(result.failed).toEqual([]);
    expect(result.databaseMoves).toEqual([{ from: "Tasks", to: "Work/Tasks", inNotion: true }]);
    // 새 부모 폴더의 페이지를 만들고 그 아래로 — 이름은 그대로라 제목은 보내지 않는다.
    const work = db.getByPath("Work")!.notionPageId!;
    expect(notion.client.updateDatabasePlacement).toHaveBeenCalledWith(DB_ID.replace(/-/g, ""), {
      parentPageId: work,
    });
    expect(notion.databases.get(DB_ID.replace(/-/g, ""))!.parent).toBe(work);
    expect(db.getMeta("db_moves_pending")).toBe("[]");
    // 속성 · 보기를 마저 붙일 push 는 새 폴더의 사이드카를 읽는다.
    expect(JSON.parse(db.getMeta("created_dbs")!).src.folder).toBe("Work/Tasks");
    expect(JSON.parse(db.getMeta("discovered_dbs")!)).toEqual([
      expect.objectContaining({ databaseId: DB_ID, localFolder: "Work/Tasks" }),
    ]);
    // pull 이 쓴 그대로였던 `.base` 는 기록 해시도 고쳐 쓴 내용으로 — 아니면 pull 이 «볼트에서 고친 보기» 로 본다.
    expect(Object.values(JSON.parse(db.getMeta("db_base_files")!))).toEqual([
      {
        basePath: "Work/Tasks/Tasks.base",
        title: "Tasks",
        hash: computeHash(view.replace('"Tasks"', '"Work/Tasks"')),
      },
    ]);
    expect(vault.read("Work/Tasks/Tasks.base")).toBe(view.replace('"Tasks"', '"Work/Tasks"'));
    expect(vault.read("Work/Tasks/mine.base")).toBe(mine);
    expect(notion.pages.get(page.id)!.parent).toBe(DB_ID);
    expect((await orchestrator.statusLocal()).folderMoves).toEqual([]);
  });

  it("sync 는 진행 항목에 받기 · 올리기를 적는다 — pull · push 를 따로 부르면 적지 않는다", async () => {
    await seed({ "a.md": "# A\n" });
    vault.write("a.md", "# A\n\nlocal edit\n");
    notion.add(ROOT, "Remote", "remote body");

    const run = collect();
    await orchestrator.sync({ onProgress: run.onProgress });

    expect(run.items).toContainEqual({ path: "Remote.md", operation: "create", direction: "pull" });
    expect(run.items).toContainEqual({ path: "a.md", operation: "update", direction: "push" });
    expect(run.items.every((item) => item.direction !== undefined)).toBe(true);

    vault.write("a.md", "# A\n\nsecond edit\n");
    const direct = collect();
    await orchestrator.push({ onProgress: direct.onProgress });
    expect(direct.items).toEqual([{ path: "a.md", operation: "update" }]);
  });
});
