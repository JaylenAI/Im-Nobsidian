/**
 * S-04 — DB 폴더는 DB 다. push 는 DB 폴더와 DB 를 품은 폴더를 빈 페이지로 만들지 않고,
 * DB 폴더에 새로 생긴 노트를 그 DB 의 행으로 만든다.
 *
 * 예전에는 push 가 바뀐 파일마다 조상 폴더를 모두 «폴더 페이지» 로 만들었다. 자동 발견 DB 의
 * 행 하나만 고쳐도 DB 폴더(`Home/과제`)와 DB 를 품은 폴더(`Notes/계획`)가 Notion 에 빈
 * 페이지로 생겼고(QA 재현), DB 폴더에 새로 만든 노트는 행이 아니라 그 빈 페이지 아래의
 * 페이지가 됐다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { computeHash } from "../../src/utils/hash.js";
import { setLogger } from "../../src/utils/logger.js";
import { DEFAULT_CONFIG, type Config } from "../../src/types/config.js";
import {
  createMockVaultFs,
  createMockStateDb,
  createMockNotionClient,
  createConfig,
  mirrorRemoteObservation,
  settledObservation,
  UNOBSERVED,
} from "../helpers/mock-orchestrator.js";

const SYNCED_AT = "2026-09-26T13:58:00.000Z";
const CREATED_AT = "2026-09-27T03:00:00.000Z";
const EDITED_AT = "2026-09-27T03:05:00.000Z";

const SCHEMA = {
  이름: { id: "title", type: "title" },
  진척: { id: "p1", type: "number" },
  상태: { id: "p2", type: "status" },
};

/** pull 이 만든 볼트의 자동 발견 DB 셋 — 폴더 노트 페이지 · 형제 페이지 · 부모를 모르는 DB. */
const DISCOVERED = [
  { databaseId: "db-tasks", localFolder: "Home/과제", titleProperty: "Name" },
  { databaseId: "db-retro", localFolder: "Notes/계획/회고", titleProperty: "Name" },
  { databaseId: "db-orphan", localFolder: "databases/Orphan-DB", titleProperty: "Name" },
];

const ROW_A = "Home/과제/과제 A.md";
const RETRO_1 = "Notes/계획/회고/회고 1.md";
const ORPHAN_1 = "databases/Orphan-DB/행 1.md";
const NEW_ROW = "Home/과제/과제 B.md";
const NEW_ROW_CONTENT =
  "---\ntitle: 과제 B\n진척: 0.3\n상태: In progress\ncover: '[[attachments/c.png]]'\n---\n" +
  "## 새 행\n\n새 행 본문.\n";

/** 추적 중인 볼트: 경로 → [내용, 레코드 필드]. */
const VAULT: Record<string, [string, Record<string, unknown>]> = {
  "Home/Home.md": ["홈\n", { notionPageId: "page-home", fileType: "folder-note" }],
  [ROW_A]: [
    "---\ntitle: 과제 A\n진척: 0.42\n---\n본문 A\n",
    { notionPageId: "row-a", notionParentId: "db-tasks", fileType: "db-row" },
  ],
  "Notes/Notes.md": ["노트\n", { notionPageId: "page-notes", fileType: "folder-note" }],
  "Notes/계획.md": ["계획\n", { notionPageId: "page-plan", notionParentId: "page-notes" }],
  [RETRO_1]: [
    "---\ntitle: 회고 1\n진척: 1\n---\n회고 본문\n",
    { notionPageId: "row-r1", notionParentId: "db-retro", fileType: "db-row" },
  ],
  [ORPHAN_1]: [
    "---\ntitle: 행 1\n---\n행 본문\n",
    { notionPageId: "row-o1", notionParentId: "db-orphan", fileType: "db-row" },
  ],
  "Loose/노트.md": ["느슨한 노트\n", { notionPageId: "page-loose" }],
};

type Rec = Record<string, unknown> & {
  id: string;
  obsidianPath: string;
  notionPageId: string | null;
};
type Op = {
  id: string;
  syncStateId: string;
  operation: string;
  direction: string;
  payload: string | null;
  done: boolean;
};

describe("S-04 DB 폴더 push — DB 폴더는 페이지가 아니다", () => {
  let vaultFs: ReturnType<typeof createMockVaultFs>;
  let stateDb: ReturnType<typeof createMockStateDb>;
  let notion: ReturnType<typeof createMockNotionClient>;
  let files: Map<string, string>;
  let records: Map<string, Rec>;
  let ops: Map<string, Op>;
  let created: number;

  const fastRetry = (): Config =>
    createConfig({ advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 } });
  const build = (config: Config = fastRetry()) =>
    new SyncOrchestrator(config, stateDb as never, notion as never, vaultFs);

  const byId = (id: string) => [...records.values()].find((r) => r.id === id);

  beforeEach(() => {
    setLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    vaultFs = createMockVaultFs();
    stateDb = createMockStateDb();
    notion = createMockNotionClient();
    files = new Map();
    records = new Map();
    ops = new Map();
    created = 0;
    let nextRecord = 1;
    let nextOp = 1;

    for (const [path, [content, fields]] of Object.entries(VAULT)) {
      files.set(path, content);
      records.set(path, {
        id: `rec-${nextRecord++}`,
        obsidianPath: path,
        notionPageId: null,
        notionParentId: "root-page-id",
        contentHash: computeHash(content),
        ...settledObservation(SYNCED_AT),
        localLastModified: SYNCED_AT,
        syncDirection: "both",
        fileType: "file",
        status: "synced",
        baseSnapshot: Buffer.from(content, "utf-8"),
        localMtime: "2020-01-01T00:00:00.000Z",
        localFileSize: 1,
        ...fields,
      });
    }

    (vaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      [...files.entries()].map(([path, content]) => ({
        path,
        mtime: "2026-09-27T00:00:00.000Z",
        size: content.length,
      })),
    );
    (vaultFs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT ${path}`);
      return content;
    });

    stateDb.getMeta.mockImplementation((key: string) =>
      key === "discovered_dbs" ? JSON.stringify(DISCOVERED) : null,
    );
    stateDb.getByPath.mockImplementation((path: string) => records.get(path) ?? null);
    stateDb.getByNotionId.mockImplementation(
      (id: string) => [...records.values()].find((r) => r.notionPageId === id) ?? null,
    );
    stateDb.getAll.mockImplementation(() => [...records.values()]);
    stateDb.getByStatus.mockImplementation((status: string) =>
      [...records.values()].filter((r) => r.status === status),
    );
    stateDb.upsert.mockImplementation((input: Rec) => {
      const prev = records.get(input.obsidianPath);
      const next = { ...prev, ...input, id: prev?.id ?? `rec-${nextRecord++}` } as Rec;
      records.set(input.obsidianPath, next);
      return next;
    });
    stateDb.updateHash.mockImplementation((id: string, hash: string, snapshot: Buffer) => {
      Object.assign(byId(id) ?? {}, { contentHash: hash, baseSnapshot: snapshot });
    });
    stateDb.updateStatus.mockImplementation((id: string, status: string) => {
      Object.assign(byId(id) ?? {}, { status });
    });
    mirrorRemoteObservation(stateDb, () => records.values());
    stateDb.delete.mockImplementation((id: string) => {
      const rec = byId(id);
      if (rec) records.delete(rec.obsidianPath);
    });
    stateDb.recordPendingOperation.mockImplementation(
      (input: { syncStateId: string; operation: string; direction: string; payload?: string }) => {
        const id = `op-${nextOp++}`;
        ops.set(id, { id, payload: null, ...input, done: false });
        return id;
      },
    );
    stateDb.getIncompleteOpByState.mockImplementation(
      (stateId: string, operation: string) =>
        [...ops.values()].find(
          (o) => o.syncStateId === stateId && o.operation === operation && !o.done,
        ) ?? null,
    );
    stateDb.getIncompletePendingOperations.mockImplementation(() =>
      [...ops.values()].filter((o) => !o.done),
    );
    stateDb.markPendingCompleted.mockImplementation((id: string) => {
      const op = ops.get(id);
      if (op) op.done = true;
    });

    notion.getDatabaseSchema.mockResolvedValue(SCHEMA);
    notion.getPage.mockImplementation(async (id: string) => ({
      id,
      last_edited_time: SYNCED_AT,
      properties: {},
    }));
    notion.updatePageProperties.mockImplementation(async (id: string) => ({
      id,
      last_edited_time: EDITED_AT,
    }));
    notion.createPageWithMarkdown.mockImplementation(async () => ({
      id: `new-${++created}`,
      last_edited_time: CREATED_AT,
      properties: {},
    }));
  });

  it("DB 행을 고쳐 push 해도 DB 폴더 · DB 를 품은 폴더를 페이지로 만들지 않는다", async () => {
    files.set(ROW_A, files.get(ROW_A)!.replace("진척: 0.42", "진척: 0.5"));
    files.set(RETRO_1, files.get(RETRO_1)!.replace("회고 본문", "회고 본문 수정"));
    files.set(ORPHAN_1, files.get(ORPHAN_1)!.replace("행 본문", "행 본문 수정"));

    const result = await build().push();

    expect(result.failed).toEqual([]);
    expect(result.updated).toBe(3);
    expect(notion.updatePageProperties).toHaveBeenCalledWith("row-a", { 진척: { number: 0.5 } });
    expect(notion.createPage).not.toHaveBeenCalled();
    expect(notion.createPageWithMarkdown).not.toHaveBeenCalled();
    // 폴더 페이지를 찾는 목록 조회도 없다.
    expect(notion.fetchAllChildren).not.toHaveBeenCalled();
    expect([...records.keys()].filter((path) => !path.endsWith(".md"))).toEqual([]);
  });

  it("이미 있는 페이지를 고치면 부모 폴더를 찾거나 만들지 않는다", async () => {
    files.set("Loose/노트.md", "느슨한 노트 수정\n");

    const result = await build().push();

    expect(result.updated).toBe(1);
    expect(notion.createPage).not.toHaveBeenCalled();
    expect(notion.fetchAllChildren).not.toHaveBeenCalled();
  });

  it("DB 폴더에 새로 만든 노트는 그 DB 의 행이 된다 — 속성은 DB 속성, 본문에 YAML 없음", async () => {
    files.set(NEW_ROW, NEW_ROW_CONTENT);

    const result = await build().push();

    expect(result.failed).toEqual([]);
    expect(result.created).toBe(1);
    expect(notion.createPage).not.toHaveBeenCalled();
    expect(notion.createPageWithMarkdown).toHaveBeenCalledTimes(1);
    const params = notion.createPageWithMarkdown.mock.calls[0]![0];
    expect(params.parentId).toBe("db-tasks");
    expect(params.parentType).toBe("database");
    // DB 에 없는 cover 는 보내지 않는다 — 보내면 요청 전체가 거부된다.
    expect(params.properties).toEqual({
      title: { title: [{ text: { content: "과제 B" } }] },
      진척: { number: 0.3 },
      상태: { status: { name: "In progress" } },
    });
    expect(params.markdown).toContain("새 행 본문.");
    expect(params.markdown).not.toContain("im-nobsidian:properties");
    expect(params.markdown).not.toContain("```yaml");
    expect(params.markdown).not.toContain("진척");

    const record = records.get(NEW_ROW)!;
    expect(record).toMatchObject({
      notionPageId: "new-1",
      notionParentId: "db-tasks",
      fileType: "db-row",
      status: "synced",
      contentHash: computeHash(NEW_ROW_CONTENT),
      notionLastEdited: CREATED_AT,
    });
    expect((record.baseSnapshot as Buffer).toString("utf-8")).toBe(NEW_ROW_CONTENT);
    expect(stateDb.upsertWikilink).toHaveBeenCalledWith(
      expect.objectContaining({ obsidianPath: NEW_ROW, notionPageId: "new-1", title: "과제 B" }),
    );
    expect([...ops.values()].every((op) => op.done)).toBe(true);
  });

  it("DB 를 품은 페이지의 폴더에 둔 새 노트는 그 페이지의 하위 페이지가 된다", async () => {
    files.set("Notes/계획/메모.md", "계획 메모\n");

    const result = await build().push();

    expect(result.failed).toEqual([]);
    expect(notion.createPage).not.toHaveBeenCalled();
    expect(notion.createPageWithMarkdown).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: "page-plan", parentType: "page" }),
    );
  });

  it("행 이름의 폴더에 둔 새 노트는 그 행의 하위 페이지가 된다", async () => {
    files.set("Home/과제/과제 A/회의 메모.md", "회의 메모\n");

    const result = await build().push();

    expect(result.failed).toEqual([]);
    expect(notion.createPage).not.toHaveBeenCalled();
    expect(notion.createPageWithMarkdown).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: "row-a", parentType: "page" }),
    );
  });

  it("DB 폴더 안의 다른 하위 폴더에 둔 노트는 만들지 않고 이유와 함께 실패로 남긴다", async () => {
    files.set("Home/과제/기타/메모.md", "메모\n");

    const result = await build().push();

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ path: "Home/과제/기타/메모.md", operation: "create" });
    expect(result.failed[0]!.error).toContain("DB 폴더");
    expect(notion.createPage).not.toHaveBeenCalled();
    expect(notion.createPageWithMarkdown).not.toHaveBeenCalled();
  });

  it("dry-run 도 둘 자리가 없는 노트를 생성으로 세지 않고 실제 push 와 같은 이유로 알린다", async () => {
    files.set("Home/과제/기타/메모.md", "메모\n");
    files.set("새 노트.md", "새 노트\n");
    const progressed: string[] = [];

    const dry = await build().push({
      dryRun: true,
      onProgress: (_current, _total, item) => progressed.push(item.path),
    });
    expect(notion.createPageWithMarkdown).not.toHaveBeenCalled();
    const real = await build().push();

    expect(dry.created).toBe(1);
    expect(progressed).toEqual(["새 노트.md"]);
    expect(dry.failed).toHaveLength(1);
    expect(dry.failed[0]).toMatchObject({ path: "Home/과제/기타/메모.md", operation: "create" });
    expect(real.created).toBe(1);
    expect(real.failed).toEqual(dry.failed);
  });

  it("같은 push 에서 만든 새 행의 이름 폴더에 둔 노트는 그 새 행의 하위 페이지가 된다", async () => {
    files.set(NEW_ROW, NEW_ROW_CONTENT);
    files.set("Home/과제/과제 B/메모.md", "과제 B 메모\n");

    const dry = await build().push({ dryRun: true });
    const result = await build().push();

    expect(dry).toMatchObject({ created: 2, failed: [] });
    expect(result).toMatchObject({ created: 2, failed: [] });
    const rowId = records.get(NEW_ROW)!.notionPageId;
    expect(rowId).toBeTruthy();
    expect(records.get("Home/과제/과제 B/메모.md")?.notionParentId).toBe(rowId);
    expect(notion.createPage).not.toHaveBeenCalled();
  });

  it("새 행 아래 두 단계 폴더의 노트를 루트에 두지 않고 그 행 아래 폴더 페이지에 둔다", async () => {
    files.set(NEW_ROW, NEW_ROW_CONTENT);
    files.set("Home/과제/과제 B/회의/메모.md", "회의 메모\n");

    const dry = await build().push({ dryRun: true });
    const result = await build().push();

    expect(dry).toMatchObject({ created: 2, failed: [] });
    expect(result).toMatchObject({ created: 2, failed: [] });
    const rowId = records.get(NEW_ROW)!.notionPageId;
    expect(notion.createPage).toHaveBeenCalledTimes(1);
    expect(notion.createPage).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: rowId, title: "회의" }),
    );
    expect(records.get("Home/과제/과제 B/회의/메모.md")?.notionParentId).toBe("page-id-123");
    expect(notion.createPageWithMarkdown).not.toHaveBeenCalledWith(
      expect.objectContaining({ parentId: "root-page-id" }),
    );
  });

  it("DB 와 무관한 새 폴더는 예전처럼 폴더 페이지를 만든다", async () => {
    files.set("Home/새 폴더/노트.md", "새 노트\n");

    const result = await build().push();

    expect(result.failed).toEqual([]);
    expect(notion.createPage).toHaveBeenCalledTimes(1);
    expect(notion.createPage).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: "page-home", title: "새 폴더" }),
    );
    expect(records.get("Home/새 폴더")?.notionPageId).toBe("page-id-123");
    expect(notion.createPageWithMarkdown).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: "page-id-123", parentType: "page" }),
    );
  });

  it("폴더 이름과 같은 제목의 행 · v0.3 이 남긴 폴더 레코드가 있어도 DB 폴더는 DB 다", async () => {
    const sameName = "---\ntitle: 과제\n---\n같은 이름 행\n";
    files.set("Home/과제/과제.md", sameName);
    records.set("Home/과제/과제.md", {
      ...records.get(ROW_A)!,
      id: "rec-same",
      obsidianPath: "Home/과제/과제.md",
      notionPageId: "row-same",
      contentHash: computeHash(sameName),
      baseSnapshot: Buffer.from(sameName, "utf-8"),
    });
    records.set("Home/과제", {
      ...records.get("Home/Home.md")!,
      id: "rec-bogus",
      obsidianPath: "Home/과제",
      notionPageId: "page-bogus",
      contentHash: "",
    });
    files.set(NEW_ROW, NEW_ROW_CONTENT);
    files.set("Home/과제/과제 A/회의 메모.md", "회의 메모\n");

    const result = await build().push();

    expect(result.failed).toEqual([]);
    expect(notion.createPageWithMarkdown).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: "db-tasks", parentType: "database" }),
    );
    expect(notion.createPageWithMarkdown).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: "row-a", parentType: "page" }),
    );
    expect(notion.createPage).not.toHaveBeenCalled();
    // 같은 이름 행을 폴더 노트로 여겨 폴더 레코드를 지우지 않는다.
    expect(records.get("Home/과제")?.notionPageId).toBe("page-bogus");
  });

  it("새 행의 frontmatter 가 깨졌으면 만들지 않고 실패로 남긴다", async () => {
    files.set(NEW_ROW, NEW_ROW_CONTENT.replace("진척: 0.3", "진척: [0.3"));

    const result = await build().push();

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.error).toContain("frontmatter");
    expect(notion.createPageWithMarkdown).not.toHaveBeenCalled();
    expect(records.has(NEW_ROW)).toBe(false);
  });

  describe("생성 요청이 적용됐는지 모르고 끝났을 때 — 같은 행을 또 만들지 않는다", () => {
    const orphan = {
      id: "row-orphan",
      last_edited_time: CREATED_AT,
      archived: false,
      in_trash: false,
      properties: {
        이름: { type: "title", title: [{ plain_text: "과제 B" }] },
        진척: { type: "number", number: 0.3 },
      },
    };

    beforeEach(() => {
      notion.queryAllDatabasePages.mockImplementation(
        async (_dbId: string, filter?: { title?: { equals?: string } }) =>
          filter?.title?.equals === "과제 B" ? [orphan] : [],
      );
      notion.getPage.mockImplementation(async (id: string) =>
        id === "row-orphan" ? orphan : { id, last_edited_time: SYNCED_AT, properties: {} },
      );
    });

    it("같은 실행의 재시도가 DB 에서 짝 없는 같은 제목의 행을 찾아 입양하고 로컬 내용으로 맞춘다", async () => {
      notion.createPageWithMarkdown.mockRejectedValueOnce(new Error("Request timed out"));
      files.set(NEW_ROW, NEW_ROW_CONTENT);

      const result = await build().push();

      expect(result.failed).toEqual([]);
      expect(notion.createPageWithMarkdown).toHaveBeenCalledTimes(1);
      expect(notion.queryAllDatabasePages).toHaveBeenCalledWith("db-tasks", {
        property: "title",
        title: { equals: "과제 B" },
      });
      expect(records.get(NEW_ROW)).toMatchObject({
        notionPageId: "row-orphan",
        notionParentId: "db-tasks",
        fileType: "db-row",
        status: "synced",
        contentHash: computeHash(NEW_ROW_CONTENT),
      });
      // 원격에 없는 상태 속성과 본문을 로컬 내용으로 채운다.
      expect(notion.updatePageProperties).toHaveBeenCalledWith(
        "row-orphan",
        expect.objectContaining({ 상태: { status: { name: "In progress" } } }),
      );
      expect(notion.replacePageMarkdown).toHaveBeenCalledWith(
        "row-orphan",
        expect.stringContaining("새 행 본문."),
      );
      expect([...ops.values()].every((op) => op.done)).toBe(true);
    });

    it("지난 실행이 남긴 행 생성 기록은 push 시작 때 DB 에서 찾아 입양한다", async () => {
      files.set(NEW_ROW, NEW_ROW_CONTENT);
      records.set(NEW_ROW, {
        id: "rec-pending",
        obsidianPath: NEW_ROW,
        notionPageId: null,
        notionParentId: "db-tasks",
        contentHash: "",
        ...UNOBSERVED,
        localLastModified: SYNCED_AT,
        syncDirection: "both",
        fileType: "db-row",
        status: "pending",
        baseSnapshot: null,
        localMtime: null,
        localFileSize: null,
      });
      ops.set("op-prev", {
        id: "op-prev",
        syncStateId: "rec-pending",
        operation: "create",
        direction: "push",
        payload: JSON.stringify({
          path: NEW_ROW,
          parentId: "db-tasks",
          parentType: "database",
          title: "과제 B",
        }),
        done: false,
      });

      const result = await build().push();

      expect(result.failed).toEqual([]);
      expect(notion.createPageWithMarkdown).not.toHaveBeenCalled();
      expect(notion.fetchAllChildren).not.toHaveBeenCalled();
      expect(ops.get("op-prev")!.done).toBe(true);
      expect(records.get(NEW_ROW)).toMatchObject({
        notionPageId: "row-orphan",
        fileType: "db-row",
        status: "synced",
      });
    });

    it("이미 다른 파일이 짝으로 삼은 행 · 휴지통의 행은 입양하지 않고 새로 만든다", async () => {
      notion.queryAllDatabasePages.mockResolvedValue([
        { ...orphan, id: "row-a" },
        { ...orphan, id: "row-trashed", in_trash: true },
      ]);
      notion.createPageWithMarkdown.mockRejectedValueOnce(new Error("Request timed out"));
      files.set(NEW_ROW, NEW_ROW_CONTENT);

      const result = await build().push();

      expect(result.failed).toEqual([]);
      expect(notion.createPageWithMarkdown).toHaveBeenCalledTimes(2);
      expect(records.get(NEW_ROW)?.notionPageId).toBe("new-1");
      expect(records.get(ROW_A)?.notionPageId).toBe("row-a");
    });
  });
});
