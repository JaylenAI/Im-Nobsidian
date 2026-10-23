/**
 * ADR-036 — 사이드카가 있는 새 DB 폴더를 push 가 Notion DB 로 만든다.
 *
 * 새 루트로 옮긴 볼트를 push 하면 DB 폴더가 «폴더 페이지», 행이 «일반 페이지» 가 되고 속성은 본문 YAML 로
 * 갔다(실데이터 E2E 2026-10-22 — 행 959 개). 이제 사이드카의 스키마로 DB 를 만들고 행을 그 DB 에 만든다.
 * 사이드카가 가리키는 원래 DB 에는 쓰지 않는다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { setLogger } from "../../src/utils/logger.js";
import { DEFAULT_CONFIG, type Config } from "../../src/types/config.js";
import {
  createMockVaultFs,
  createMockStateDb,
  createMockNotionClient,
  createConfig,
  mirrorRemoteObservation,
} from "../helpers/mock-orchestrator.js";

const CREATED_AT = "2026-10-23T03:00:00.000Z";
const SOURCE_TASKS = "aaaaaaaa000000000000000000000001";
const SOURCE_PEOPLE = "aaaaaaaa000000000000000000000002";

function sidecar(databaseId: string, name: string, properties: unknown[]): string {
  return JSON.stringify({
    generator: "im-nobsidian",
    schemaVersion: 2,
    databaseId,
    databaseName: name,
    isInline: true,
    properties,
    views: [],
    degraded: [],
  });
}

const TASKS_SIDECAR = sidecar(SOURCE_TASKS, "과제", [
  { name: "이름", id: "title", type: "title" },
  { name: "진척", id: "p1", type: "number", definition: { format: "percent" } },
  {
    name: "상태",
    id: "p2",
    type: "status",
    options: ["할 일", "끝"],
    definition: {
      options: [
        { name: "할 일", color: "gray" },
        { name: "끝", color: "green" },
      ],
    },
  },
  {
    name: "담당",
    id: "p3",
    type: "relation",
    definition: {
      database_id: SOURCE_PEOPLE,
      type: "dual_property",
      synced_property_name: "맡은 과제",
    },
  },
  {
    name: "담당 수",
    id: "p4",
    type: "rollup",
    definition: { relation_property_name: "담당", rollup_property_name: "이름", function: "count" },
  },
  { name: "두 배", id: "p5", type: "formula", definition: { expression: 'prop("진척") * 2' } },
]);
const PEOPLE_SIDECAR = sidecar(SOURCE_PEOPLE, "사람", [
  { name: "이름", id: "title", type: "title" },
  {
    name: "맡은 과제",
    id: "q1",
    type: "relation",
    definition: { database_id: SOURCE_TASKS, type: "dual_property", synced_property_name: "담당" },
  },
]);

type Rec = Record<string, unknown> & {
  id: string;
  obsidianPath: string;
  notionPageId: string | null;
};

describe("ADR-036 push 가 DB 를 만든다", () => {
  let vaultFs: ReturnType<typeof createMockVaultFs>;
  let stateDb: ReturnType<typeof createMockStateDb>;
  let notion: ReturnType<typeof createMockNotionClient> & Record<string, ReturnType<typeof vi.fn>>;
  let files: Map<string, string>;
  let records: Map<string, Rec>;
  let meta: Map<string, string>;
  let warn: ReturnType<typeof vi.fn>;

  const config = (sync: Partial<Config["sync"]> = {}): Config =>
    createConfig({
      sync: { ...DEFAULT_CONFIG.sync, ...sync },
      advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
    });
  const build = (c: Config = config()) =>
    new SyncOrchestrator(c, stateDb as never, notion as never, vaultFs);
  const pageIdOf = (path: string) => records.get(path)?.notionPageId;

  beforeEach(() => {
    warn = vi.fn();
    setLogger({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() });
    vaultFs = createMockVaultFs();
    stateDb = createMockStateDb();
    notion = createMockNotionClient() as never;
    records = new Map();
    meta = new Map();
    let nextRecord = 1;
    let nextPage = 0;
    let nextDb = 0;

    files = new Map([
      ["P.md", "# 프로젝트\n\n![[P/과제/과제.base|과제]]\n"],
      ["P/과제/과제.notion.json", TASKS_SIDECAR],
      ["P/과제/과제.base", "views: []\n"],
      ["P/과제/행 1.md", "---\n이름: 행 1\n진척: 0.5\n상태: 끝\n---\n행 본문\n"],
      ["P/과제/행 1/하위.md", "행 아래 페이지\n"],
      ["P/사람/사람.notion.json", PEOPLE_SIDECAR],
      ["P/사람/김.md", "---\n이름: 김\n---\n"],
    ]);
    (vaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      [...files.keys()]
        .filter((p) => p.endsWith(".md"))
        .map((path) => ({
          path,
          mtime: "2026-10-23T00:00:00.000Z",
          size: files.get(path)!.length,
        })),
    );
    (vaultFs.listNonMarkdownFiles as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      [...files.keys()]
        .filter((p) => !p.endsWith(".md"))
        .map((path) => ({ path, size: 1, mtime: "2026-10-23T00:00:00.000Z" })),
    );
    (vaultFs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT ${path}`);
      return content;
    });

    stateDb.getMeta.mockImplementation((key: string) => meta.get(key) ?? null);
    stateDb.setMeta.mockImplementation((key: string, value: string) => meta.set(key, value));
    stateDb.getByPath.mockImplementation((path: string) => records.get(path) ?? null);
    stateDb.getByNotionId.mockImplementation(
      (id: string) => [...records.values()].find((r) => r.notionPageId === id) ?? null,
    );
    stateDb.getAll.mockImplementation(() => [...records.values()]);
    stateDb.upsert.mockImplementation((input: Rec) => {
      const prev = records.get(input.obsidianPath);
      const next = { ...prev, ...input, id: prev?.id ?? `rec-${nextRecord++}` } as Rec;
      records.set(input.obsidianPath, next);
      return next;
    });
    mirrorRemoteObservation(stateDb, () => records.values());

    notion.getDatabaseSchema.mockResolvedValue({
      이름: { id: "title", type: "title" },
      진척: { id: "p1", type: "number" },
      상태: { id: "p2", type: "status" },
    });
    notion.getPage.mockImplementation(async (id: string) => ({
      id,
      last_edited_time: CREATED_AT,
      properties: {},
    }));
    notion.createPageWithMarkdown.mockImplementation(async () => ({
      id: `page-${++nextPage}`,
      last_edited_time: CREATED_AT,
      properties: {},
    }));
    notion.createDatabase = vi.fn(async () => {
      nextDb++;
      return { databaseId: `db-new-${nextDb}`, dataSourceId: `ds-new-${nextDb}` };
    });
    notion.primaryDataSourceId = vi.fn(async (id: string) => `ds-of-${id}`);
    notion.updateDataSourceProperties = vi.fn(
      async (_ds: string, props: Record<string, unknown>) =>
        "담당" in props
          ? {
              담당: {
                relation: { dual_property: { synced_property_name: "Related to 과제 (담당)" } },
              },
            }
          : {},
    );
  });

  it("사이드카 폴더를 부모 페이지 아래 DB 로 만들고 노트를 행으로 만든다", async () => {
    const result = await build().push();

    expect(result.failed).toEqual([]);
    expect(result.createdDatabases).toBe(2);
    const parent = pageIdOf("P.md");
    expect(notion.createDatabase.mock.calls.map((c) => c[0])).toEqual([
      {
        parentPageId: parent,
        title: "과제",
        isInline: true,
        properties: {
          이름: { title: {} },
          진척: { number: { format: "percent" } },
        },
      },
      { parentPageId: parent, title: "사람", isInline: true, properties: { 이름: { title: {} } } },
    ]);
    // 행은 만든 DB 에 — 폴더 페이지는 하나도 만들지 않는다.
    expect(notion.createPage).not.toHaveBeenCalled();
    const rowCall = notion.createPageWithMarkdown.mock.calls.find((c) => c[0].title === "행 1")!;
    expect(rowCall[0]).toMatchObject({ parentId: "db-new-1", parentType: "database" });
    expect(rowCall[0].properties).toMatchObject({
      진척: { number: 0.5 },
      상태: { status: { name: "끝" } },
    });
    // 행 이름의 폴더에 든 노트는 그 행 아래 페이지다.
    const childCall = notion.createPageWithMarkdown.mock.calls.find((c) => c[0].title === "하위")!;
    expect(childCall[0].parentId).toBe(pageIdOf("P/과제/행 1.md"));
    expect(records.get("P/과제/행 1.md")?.fileType).toBe("db-row");
    // 🔴 사이드카의 원래 DB 에는 아무것도 보내지 않는다.
    expect(JSON.stringify(notion.updateDataSourceProperties.mock.calls)).not.toContain(
      SOURCE_TASKS,
    );
    expect(JSON.stringify(notion.createPageWithMarkdown.mock.calls)).not.toContain(SOURCE_TASKS);
  });

  it("status 다음 relation(맞짝 이름까지) · rollup · formula 를 차례로 붙인다", async () => {
    await build().push();

    expect(notion.updateDataSourceProperties.mock.calls).toEqual([
      [
        "ds-new-1",
        {
          상태: {
            status: {
              options: [
                { name: "할 일", color: "gray" },
                { name: "끝", color: "green" },
              ],
            },
          },
        },
      ],
      [
        "ds-new-1",
        {
          담당: {
            relation: { data_source_id: "ds-new-2", type: "dual_property", dual_property: {} },
          },
        },
      ],
      // Notion 이 지은 맞짝 이름을 사이드카의 이름으로 — 사람 쪽 「맡은 과제」 는 따로 만들지 않는다.
      ["ds-new-2", { "Related to 과제 (담당)": { name: "맡은 과제" } }],
      [
        "ds-new-1",
        {
          "담당 수": {
            rollup: {
              relation_property_name: "담당",
              rollup_property_name: "이름",
              function: "count",
            },
          },
        },
      ],
      ["ds-new-1", { "두 배": { formula: { expression: 'prop("진척") * 2' } } }],
    ]);
    const created = JSON.parse(meta.get("created_dbs")!);
    expect(created[SOURCE_TASKS]).toMatchObject({ databaseId: "db-new-1", schemaDone: true });
    expect(created[SOURCE_PEOPLE]).toMatchObject({ databaseId: "db-new-2", schemaDone: true });
  });

  it("만든 DB 를 자동 발견 목록과 다음 pull 의 대기에 적는다", async () => {
    await build().push();

    expect(JSON.parse(meta.get("discovered_dbs")!)).toEqual([
      { databaseId: "db-new-1", localFolder: "P/과제", titleProperty: "이름" },
      { databaseId: "db-new-2", localFolder: "P/사람", titleProperty: "이름" },
    ]);
    expect(JSON.parse(meta.get("db_pull_pending")!)).toEqual(["dbnew1", "dbnew2"]);
  });

  it("dry-run 은 만들 DB 를 세기만 한다", async () => {
    const result = await build().push({ dryRun: true });

    expect(result.createdDatabases).toBe(2);
    expect(notion.createDatabase).not.toHaveBeenCalled();
    expect(meta.has("created_dbs")).toBe(false);
  });

  it("이 볼트가 아는 DB 의 사이드카면 만들지 않는다 — 예전처럼 행으로", async () => {
    meta.set(
      "discovered_dbs",
      JSON.stringify([
        { databaseId: SOURCE_TASKS, localFolder: "P/과제", titleProperty: "이름" },
        { databaseId: SOURCE_PEOPLE, localFolder: "P/사람", titleProperty: "이름" },
      ]),
    );
    const result = await build().push();

    expect(notion.createDatabase).not.toHaveBeenCalled();
    expect(result.createdDatabases).toBe(0);
    const rowCall = notion.createPageWithMarkdown.mock.calls.find((c) => c[0].title === "행 1")!;
    expect(rowCall[0].parentId).toBe(SOURCE_TASKS);
  });

  it("sync.createDatabases 를 끄면 예전처럼 폴더 페이지로 올린다", async () => {
    await build(config({ createDatabases: false })).push();

    expect(notion.createDatabase).not.toHaveBeenCalled();
    expect(notion.createPage).toHaveBeenCalledWith(expect.objectContaining({ title: "과제" }));
  });

  it("만드는 요청의 답을 잃었으면 다음 push 가 부모에서 같은 제목의 DB 를 찾아 삼는다", async () => {
    records.set("P.md", {
      id: "rec-p",
      obsidianPath: "P.md",
      notionPageId: "page-p",
      contentHash: "x",
      status: "synced",
      fileType: "file",
    });
    meta.set(
      "created_dbs",
      JSON.stringify({
        [SOURCE_TASKS]: {
          databaseId: null,
          dataSourceId: null,
          folder: "P/과제",
          parentPageId: "page-p",
          title: "과제",
          schemaDone: false,
        },
      }),
    );
    notion.fetchAllChildren.mockImplementation(async (id: string) =>
      id === "page-p"
        ? [{ id: "db-lost", type: "child_database", child_database: { title: "과제" } }]
        : [],
    );

    await build().push({ paths: ["P/과제"] });

    expect(notion.createDatabase).not.toHaveBeenCalled();
    expect(JSON.parse(meta.get("created_dbs")!)[SOURCE_TASKS]).toMatchObject({
      databaseId: "db-lost",
      dataSourceId: "ds-of-db-lost",
    });
    const rowCall = notion.createPageWithMarkdown.mock.calls.find((c) => c[0].title === "행 1")!;
    expect(rowCall[0].parentId).toBe("db-lost");
  });

  it("status 가 Notion 기본 옵션을 쓰면 기본으로 만들어 그룹을 살리고, 나머지는 더한 뒤 알린다", async () => {
    files.set(
      "P/과제/과제.notion.json",
      sidecar(SOURCE_TASKS, "과제", [
        { name: "이름", id: "title", type: "title" },
        {
          name: "상태",
          id: "s",
          type: "status",
          definition: {
            options: [
              { name: "Not started", color: "default" },
              { name: "In progress", color: "blue" },
              { name: "Done", color: "green" },
              { name: "보류", color: "red" },
            ],
            groups: [
              { name: "To-do", options: ["Not started"] },
              { name: "In progress", options: ["In progress", "보류"] },
              { name: "Complete", options: ["Done"] },
            ],
          },
        },
      ]),
    );
    const defaults = [
      { id: "o1", name: "Not started", color: "default" },
      { id: "o2", name: "In progress", color: "blue" },
      { id: "o3", name: "Done", color: "green" },
    ];
    notion.updateDataSourceProperties.mockImplementationOnce(async () => ({
      상태: { status: { options: defaults } },
    }));
    await build().push();

    expect(notion.updateDataSourceProperties.mock.calls.slice(0, 2)).toEqual([
      ["ds-new-1", { 상태: { status: {} } }],
      [
        "ds-new-1",
        { 상태: { status: { options: [...defaults, { name: "보류", color: "red" }] } } },
      ],
    ]);
    const warned = warn.mock.calls.flat().join("\n");
    expect(warned).toContain("보류(In progress)");
    expect(warned).not.toContain("Done(");
  });

  it("행이 없는 DB 도 만든다 — 사이드카만 있는 폴더", async () => {
    files.delete("P/사람/김.md");
    const result = await build().push();

    expect(result.createdDatabases).toBe(2);
    expect(notion.createDatabase.mock.calls.map((c) => c[0].title)).toEqual(["과제", "사람"]);
  });

  it("범위를 좁힌 push 는 범위 밖의 빈 DB 를 만들지 않는다", async () => {
    files.delete("P/사람/김.md");
    await build().push({ paths: ["P.md", "P/과제"] });

    expect(notion.createDatabase.mock.calls.map((c) => c[0].title)).toEqual(["과제"]);
  });

  it("unique_id 접두어가 워크스페이스에서 겹치면 접두어 없이 만든다", async () => {
    files.set(
      "P/과제/과제.notion.json",
      sidecar(SOURCE_TASKS, "과제", [
        { name: "이름", id: "title", type: "title" },
        { name: "번호", id: "u", type: "unique_id", definition: { prefix: "TK" } },
      ]),
    );
    notion.createDatabase.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Unique ID prefix is already in use."), {
        status: 409,
        code: "conflict_error",
      });
    });
    const result = await build().push();

    expect(result.failed).toEqual([]);
    const tasks = notion.createDatabase.mock.calls.filter((c) => c[0].title === "과제");
    expect(tasks.map((c) => c[0].properties["번호"])).toEqual([
      { unique_id: { prefix: "TK" } },
      { unique_id: { prefix: null } },
    ]);
    expect(warn.mock.calls.flat().join("\n")).toContain("접두어 없이 만듦");
  });

  it("루트 아래 DB 의 폴더(databases)는 페이지로 만들지 않고 DB 를 루트 아래에 만든다", async () => {
    files.clear();
    files.set("databases/과제/과제.notion.json", TASKS_SIDECAR);
    files.set("databases/과제/행 1.md", "---\n이름: 행 1\n---\n");
    const result = await build().push();

    expect(result.failed).toEqual([]);
    expect(notion.createPage).not.toHaveBeenCalled();
    expect(notion.createDatabase.mock.calls[0]![0]).toMatchObject({
      parentPageId: "root-page-id",
      title: "과제",
    });
  });

  it("볼트 밖 DB 로 가는 relation 은 만들지 않는다", async () => {
    files.delete("P/사람/사람.notion.json");
    files.delete("P/사람/김.md");
    await build().push();

    expect(
      notion.updateDataSourceProperties.mock.calls.map((c) => Object.keys(c[1])[0]),
    ).not.toContain("담당");
    expect(notion.primaryDataSourceId).not.toHaveBeenCalledWith(SOURCE_PEOPLE);
    expect(warn.mock.calls.flat().join("\n")).toContain("relation 을 만들지 않음");
  });
});

describe("페이지 이름의 하위 폴더 — 같은 push 의 새 노트가 폴더의 자리다", () => {
  it("`A/B.md` 를 먼저 올리고 `A/B/C.md` 를 그 아래에 — 폴더 페이지 «B» 를 따로 만들지 않는다", async () => {
    setLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    const vaultFs = createMockVaultFs();
    const stateDb = createMockStateDb();
    const notion = createMockNotionClient();
    const files = new Map([
      ["B.md", "페이지 B\n"],
      ["B/C.md", "B 아래 C\n"],
    ]);
    const records = new Map<string, Rec>();
    let next = 0;
    (vaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      [...files.keys()].map((path) => ({ path, mtime: "2026-10-23T00:00:00.000Z", size: 1 })),
    );
    (vaultFs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (p: string) =>
      files.get(p)!,
    );
    stateDb.getByPath.mockImplementation((p: string) => records.get(p) ?? null);
    stateDb.getAll.mockImplementation(() => [...records.values()]);
    stateDb.upsert.mockImplementation((input: Rec) => {
      const rec = {
        ...records.get(input.obsidianPath),
        ...input,
        id: `rec-${input.obsidianPath}`,
      } as Rec;
      records.set(input.obsidianPath, rec);
      return rec;
    });
    mirrorRemoteObservation(stateDb, () => records.values());
    notion.createPageWithMarkdown.mockImplementation(async () => ({
      id: `page-${++next}`,
      last_edited_time: CREATED_AT,
      properties: {},
    }));
    notion.getPage.mockImplementation(async (id: string) => ({
      id,
      last_edited_time: CREATED_AT,
      properties: {},
    }));

    const result = await new SyncOrchestrator(
      createConfig({ advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 } }),
      stateDb as never,
      notion as never,
      vaultFs,
    ).push();

    expect(result.failed).toEqual([]);
    expect(notion.createPage).not.toHaveBeenCalled();
    const calls = notion.createPageWithMarkdown.mock.calls.map((c) => [c[0].title, c[0].parentId]);
    expect(calls).toEqual([
      ["B", "root-page-id"],
      ["C", records.get("B.md")!.notionPageId],
    ]);
  });
});
