/**
 * Phase 4 — DB 행 받기 (B4 · B5), 오케스트레이터 배선 수준.
 *
 * B4: 받은 행의 빈 속성(글 · 선택 · 날짜 · 숫자)이 `메모: null` 로 적혔다. 빈 목록은 적지 않았다.
 * B5: 행을 받아 쓴 뒤 파일 수정 시각 · 크기를 적지 않아, 다음 변경 확인이 받은 행을 모두 다시 읽었다.
 * B13: 행 노트는 기간을 두 키(`기간` · `기간_end`)로 적는데 `.base` 보기에 끝 열이 없어 끝 날짜가 보이지 않았다.
 * B10: 같은 이름의 새 행 둘 가운데 누가 자연 이름을 얻는지가 Notion 이 돌려준 차례에 달렸다.
 * 로컬 파일: 새 행이 DB 폴더의 같은 이름 로컬 파일(상태 DB 에 없는 것)을 덮어써 그 글이 사라졌다.
 *
 * 실제 StateDB(임시 파일)와 메모리 볼트 · 메모리 Notion(configured-db-row-push 와 같은 하니스).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DB_ID = "db000000-0000-4000-8000-0000000000c1";

const SCHEMA = {
  Name: { id: "title", type: "title" },
  진척: { id: "p1", type: "number" },
  메모: { id: "p2", type: "rich_text" },
  단계: { id: "p3", type: "select" },
};

describe("DB 행 받기 (Phase 4)", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

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

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-row-pull-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
    notion.client.getDatabaseSchema.mockResolvedValue(SCHEMA);
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

  /** Notion 에서 만든 행 — 메모 · 단계는 비었다. */
  const addRow = (title: string, 진척: number | null) =>
    notion.add(DB_ID, title, "본문", {
      properties: { 진척: { number: 진척 }, 메모: { rich_text: [] }, 단계: { select: null } },
    });

  describe("B4 — 빈 속성", () => {
    it("Notion 에서 만든 행의 빈 속성은 적지 않는다", async () => {
      addRow("새 행", 0);

      expect(await build().pull()).toMatchObject({ created: 1, failed: [] });

      expect(vault.read("Tasks/새 행.md")).toBe("---\n진척: 0\ntitle: 새 행\n---\n\n본문\n");
    });

    it("로컬에 빈 값으로 적어 둔 속성 줄은 남는다 — Notion 에서 다른 속성만 바뀌었을 때", async () => {
      const row = addRow("행", 1);
      await build().pull();
      vault.write("Tasks/행.md", "---\ntitle: 행\n진척: 1\n메모:\n---\n본문\n");
      await build().push();

      notion.edit(row.id, (page) => {
        page.properties["진척"] = { type: "number", number: 2 };
      });
      expect(await build().pull()).toMatchObject({ updated: 1, failed: [] });

      expect(vault.read("Tasks/행.md")).toBe("---\ntitle: 행\n진척: 2\n메모:\n---\n본문\n");
    });

    it("빈 속성을 적지 않아도 다음 push 가 Notion 의 속성을 비우지 않는다", async () => {
      addRow("행", null);
      await build().pull();

      expect(await build().push()).toMatchObject({ updated: 0, failed: [] });
      expect(notion.client.updatePageProperties).not.toHaveBeenCalled();
    });
  });

  describe("B13 — 기간의 끝 열", () => {
    const withPeriodView = () => {
      notion.client.getDatabaseSchema.mockResolvedValue({
        ...SCHEMA,
        기간: { id: "p4", type: "date" },
      });
      notion.client.getDatabaseSchemaFull.mockResolvedValue({
        Name: { id: "title", type: "title" },
        기간: { id: "p4", type: "date" },
        진척: { id: "p1", type: "number" },
      });
      notion.client.getDatabaseViewsConfig.mockResolvedValue({
        databaseId: DB_ID,
        lastSynced: "",
        views: [
          {
            id: "v1",
            name: "표",
            type: "table",
            properties: [
              { propertyId: "p4", propertyName: "기간", visible: true },
              { propertyId: "p1", propertyName: "진척", visible: true },
            ],
          },
        ],
      });
    };
    const base = () => vault.read("Tasks/Test DB.base") ?? "";

    it("기간인 행이 있으면 `.base` 표에 끝 열이 기간 바로 뒤에 온다", async () => {
      withPeriodView();
      notion.add(DB_ID, "하루", "", { properties: { 기간: { date: { start: "2026-10-01" } } } });
      notion.add(DB_ID, "며칠", "", {
        properties: { 기간: { date: { start: "2026-10-01", end: "2026-10-03" } } },
      });

      expect(await build().pull()).toMatchObject({ created: 2, failed: [] });

      expect(vault.read("Tasks/며칠.md")).toContain("기간: 2026-10-01\n기간_end: 2026-10-03\n");
      expect(base()).toContain('      - "기간"\n      - "기간_end"\n      - "진척"\n');
    });

    it("기간인 행이 없으면 끝 열을 두지 않는다", async () => {
      withPeriodView();
      notion.add(DB_ID, "하루", "", { properties: { 기간: { date: { start: "2026-10-01" } } } });

      await build().pull();

      expect(base()).toContain('      - "기간"\n      - "진척"\n');
      expect(base()).not.toContain("기간_end");
    });
  });

  describe("B10 — 같은 이름의 새 행", () => {
    /** Notion 이 행을 거꾸로 돌려준다 — 조회 차례가 경로를 정하면 안 된다. */
    const queryReversed = () => {
      const query = notion.client.queryAllDatabasePages.getMockImplementation()!;
      notion.client.queryAllDatabasePages.mockImplementation(async (...args: never[]) =>
        (await query(...args)).reverse(),
      );
    };

    it.each([
      ["만든 차례", false],
      ["거꾸로", true],
    ])("Notion 이 %s 돌려줘도 ID 가 앞선 행이 자연 이름을 얻는다", async (_name, reversed) => {
      const first = addRow("같은", 1);
      const second = addRow("같은", 2);
      if (reversed) queryReversed();

      expect(await build().pull()).toMatchObject({ created: 2, failed: [] });

      expect(db.getByNotionId(first.id)!.obsidianPath).toBe("Tasks/같은.md");
      expect(db.getByNotionId(second.id)!.obsidianPath).toBe(
        `Tasks/같은 (${second.id.replace(/-/g, "").slice(0, 8)}).md`,
      );
    });

    it("dry-run 이 보이는 경로가 실제로 받는 경로와 같다", async () => {
      addRow("같은", 1);
      addRow("같은", 2);
      queryReversed();

      const planned: string[] = [];
      await build().pull({
        dryRun: true,
        onProgress: (_done, _total, item) => {
          if (item?.path.startsWith("Tasks/같은")) planned.push(item.path);
        },
      });
      await build().pull();

      expect(planned.sort()).toEqual(
        db
          .getAll()
          .map((record) => record.obsidianPath)
          .filter((path) => path.startsWith("Tasks/같은"))
          .sort(),
      );
      expect(new Set(planned).size).toBe(2);
    });
  });

  describe("같은 이름의 추적하지 않는 로컬 파일", () => {
    const LOCAL = "---\n진척: 9\n---\n아직 올리지 않은 내 글\n";
    /** 이미 Notion 과 이은 볼트 — 이은 노트가 없는 볼트는 같은 자리의 노트를 다시 잇는다(ADR-049, 아래). */
    const linked = async () => {
      vault.write("이은 노트.md", "이미 올림\n");
      expect(await build().push()).toMatchObject({ created: 1, failed: [] });
    };

    it("새 행은 그 파일을 덮어쓰지 않고 ID 조각을 붙인 경로를 얻는다", async () => {
      await linked();
      vault.write("Tasks/같은.md", LOCAL);
      const row = addRow("같은", 1);

      expect(await build().pull()).toMatchObject({ created: 1, failed: [] });

      expect(vault.read("Tasks/같은.md")).toBe(LOCAL);
      const path = db.getByNotionId(row.id)!.obsidianPath;
      expect(path).toBe(`Tasks/같은 (${row.id.replace(/-/g, "").slice(0, 8)}).md`);
      expect(vault.read(path)).toContain("본문");
    });

    it("dry-run 도 그 파일의 경로를 보이지 않는다", async () => {
      vault.write("Tasks/같은.md", LOCAL);
      addRow("같은", 1);

      const planned: string[] = [];
      await build().pull({
        dryRun: true,
        onProgress: (_done, _total, item) => {
          if (item?.path.startsWith("Tasks/같은")) planned.push(item.path);
        },
      });

      expect(planned).toHaveLength(1);
      expect(planned[0]).not.toBe("Tasks/같은.md");
    });

    it("다음 push 는 그 로컬 파일을 새 행으로 올리고, 받은 행은 그대로다", async () => {
      await linked();
      vault.write("Tasks/같은.md", LOCAL);
      const row = addRow("같은", 1);
      await build().pull();

      expect(await build().push()).toMatchObject({ created: 1, failed: [] });

      expect(db.getByPath("Tasks/같은.md")!.notionPageId).not.toBe(row.id);
      expect(vault.read("Tasks/같은.md")).toBe(LOCAL);
    });

    it("이은 노트가 없는 볼트는 그 파일을 행과 충돌로 잇는다 — 덮지 않고 두 벌도 만들지 않는다 (ADR-049)", async () => {
      vault.write("Tasks/같은.md", LOCAL);
      const row = addRow("같은", 1);

      const pulled = await build().pull();
      expect(pulled).toMatchObject({ created: 0, failed: [], relinkedPaths: ["Tasks/같은.md"] });
      expect(pulled.conflicts.map((c) => c.localChange.path)).toEqual(["Tasks/같은.md"]);
      expect(vault.read("Tasks/같은.md")).toBe(LOCAL);
      expect(db.getByPath("Tasks/같은.md")).toMatchObject({
        notionPageId: row.id,
        status: "conflict",
      });
      expect(await build().push()).toMatchObject({ created: 0, updated: 0 });
    });
  });

  describe("B5 — 받아 쓴 행의 파일 stat", () => {
    it("새로 받은 행 · 다시 받은 행 모두 수정 시각 · 크기를 적는다", async () => {
      const row = addRow("행", 1);
      await build().pull();
      const stat = () => vault.stat("Tasks/행.md")!;
      expect(db.getByPath("Tasks/행.md")).toMatchObject({
        localMtime: stat().mtime,
        localFileSize: stat().size,
      });

      notion.edit(row.id, (page) => {
        page.properties["진척"] = { type: "number", number: 22 };
      });
      expect(await build().pull()).toMatchObject({ updated: 1 });
      expect(db.getByPath("Tasks/행.md")).toMatchObject({
        localMtime: stat().mtime,
        localFileSize: stat().size,
      });
    });
  });
});
