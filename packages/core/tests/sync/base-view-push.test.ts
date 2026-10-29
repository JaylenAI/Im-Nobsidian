/**
 * P4 · ADR-046 — 볼트에서 고친 `.base` 의 보기(이름 · 열 · 정렬 · 필터)가 Notion 보기가 된다. 예전에는 `.base` 를 고쳐도
 * Notion 에 가지 않았고, Obsidian 이 다시 쓴 파일은 머리 주석이 사라져 «직접 만든 파일» 로 여겨 영영 Notion 보기를 받지
 * 못했다.
 */
import matter from "gray-matter";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { DbBaseFiles } from "../../src/sync/db-base-files.js";
import {
  changedFields,
  matchViews,
  pushableOf,
  readBaseFile,
  recordBaseViews,
  type BaseViewRecord,
} from "../../src/sync/base-view-record.js";
import { BaseFileGenerator } from "../../src/view/base-file-generator.js";
import type { BasePropertySchema, ViewConfig } from "../../src/types/view.js";
import { computeHash } from "../../src/utils/hash.js";
import { setLogger } from "../../src/utils/logger.js";
import {
  createMockVaultFs,
  createMockStateDb,
  createMockNotionClient,
  createConfig,
} from "../helpers/mock-orchestrator.js";

const DB_ID = "db-tasks";
const PATH = "과제/과제.base";
const SCHEMA: Record<string, BasePropertySchema> = {
  이름: { id: "title", type: "title" },
  점수: { id: "p%3A1", type: "number" },
  메모: { id: "p2", type: "rich_text" },
  마감: { id: "p3", type: "date" },
  상태: { id: "p4", type: "select", options: [{ name: "가" }, { name: "나" }] },
};

const entry = (id: string, name: string, visible = true) => ({
  property_id: id,
  property_name: name,
  visible,
  width: 120,
});

function tableView(overrides: Partial<ViewConfig> = {}): ViewConfig {
  const properties = [
    entry("title", "이름"),
    entry("p:1", "점수"),
    entry("p2", "메모"),
    entry("p3", "마감", false),
    entry("p4", "상태", false),
  ];
  return {
    id: "view-table",
    name: "표",
    type: "table",
    filter: { property: "p:1", number: { greater_than: 3 } },
    sorts: [{ property: "p:1", direction: "descending" }],
    properties: properties.map((p) => ({
      propertyId: p.property_id,
      propertyName: p.property_name,
      visible: p.visible,
      width: p.width,
    })),
    configuration: { type: "table", properties },
    ...overrides,
  };
}

function boardView(): ViewConfig {
  const properties = [entry("title", "이름"), entry("p:1", "점수"), entry("p2", "메모", false)];
  const groupBy = { type: "select", property_id: "p4", sort: { type: "manual" } };
  return {
    id: "view-board",
    name: "보드",
    type: "board",
    properties: properties.map((p) => ({
      propertyId: p.property_id,
      propertyName: p.property_name,
      visible: p.visible,
    })),
    groupBy: { type: "select", propertyId: "p4", sort: "manual" },
    configuration: { type: "board", group_by: groupBy, properties },
  };
}

/** Obsidian 이 보기를 고쳐 다시 쓴 꼴 — 머리 주석이 사라지고 키 차례 · 따옴표가 바뀐다(1.13.7 실측). */
function obsidianRewrite(
  text: string,
  edit: (views: Array<Record<string, unknown>>) => void,
): string {
  const parsed = readBaseFile(text)!;
  const views = structuredClone(parsed.views) as Array<Record<string, unknown>>;
  edit(views);
  return matter
    .stringify("", { ...parsed.doc, views })
    .replace(/^---\n/, "")
    .replace(/---\n$/, "");
}

describe("base-view-record — 견주는 값", () => {
  it("note. 접두사 · 방향 대소문자 · 키 차례는 고친 것이 아니다", () => {
    const record = pushableOf({
      name: "표",
      order: ["file.name", "점수"],
      sort: [{ property: "점수", direction: "DESC" }],
    });
    const edited = pushableOf({
      sort: [{ direction: "desc", property: "note.점수" }],
      order: ["file.name", "note.점수"],
      name: "표",
    });
    expect(changedFields(record, edited)).toEqual([]);
  });

  it("이름을 바꾼 보기는 같은 자리 · 같은 타입으로 잇는다 — 이름이 같은 것이 먼저", () => {
    const records = [
      { viewId: "a", type: "table", name: "표", notion: "" },
      { viewId: "b", type: "cards", name: "갤러리", notion: "" },
    ] satisfies BaseViewRecord[];
    expect(
      matchViews(records, [
        { type: "table", name: "새 이름" },
        { type: "cards", name: "갤러리" },
        { type: "table", name: "볼트에서 더한 것" },
      ]).map((r) => r?.viewId),
    ).toEqual(["a", "b", undefined]);
  });
});

describe("BaseViewEdits — push 가 고친 보기를 Notion 에 올린다", () => {
  let vaultFs: ReturnType<typeof createMockVaultFs>;
  let stateDb: ReturnType<typeof createMockStateDb>;
  let notion: ReturnType<typeof createMockNotionClient> & {
    getView: ReturnType<typeof vi.fn>;
    updateView: ReturnType<typeof vi.fn>;
  };
  let metaStore: Map<string, string>;
  let files: Map<string, string>;
  let live: Map<string, ViewConfig>;
  let sources: string[];
  let generated: string;

  const build = () =>
    new SyncOrchestrator(createConfig(), stateDb as never, notion as never, vaultFs);
  const record = () => new DbBaseFiles(stateDb as never).get(DB_ID)!;
  const edit = (fn: (views: Array<Record<string, unknown>>) => void) =>
    files.set(PATH, obsidianRewrite(generated, fn));

  beforeEach(() => {
    setLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    vaultFs = createMockVaultFs();
    stateDb = createMockStateDb();
    notion = createMockNotionClient() as typeof notion;
    metaStore = new Map();
    live = new Map([
      ["view-table", tableView()],
      ["view-board", boardView()],
    ]);
    sources = ["ds-1"];
    const views = [...live.values()];
    const out = new BaseFileGenerator().generateWithViews({
      databaseId: DB_ID,
      databaseName: "과제",
      schema: SCHEMA,
      viewsConfig: { databaseId: DB_ID, lastSynced: "", views },
      folderPath: "과제",
    });
    generated = out.content;
    files = new Map([[PATH, generated]]);
    (vaultFs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (p: string) => {
      const content = files.get(p);
      if (content === undefined) throw new Error(`ENOENT ${p}`);
      return content;
    });
    stateDb.getMeta.mockImplementation((k: string) => metaStore.get(k) ?? null);
    stateDb.setMeta.mockImplementation((k: string, v: string) => void metaStore.set(k, v));
    new DbBaseFiles(stateDb as never).set(DB_ID, {
      basePath: PATH,
      title: "과제",
      hash: computeHash(generated),
      ...recordBaseViews(generated, out.views, views)!,
    });
    notion.getDatabaseMeta.mockImplementation(async () => ({
      databaseId: DB_ID,
      title: "과제",
      dataSources: sources.map((id) => ({ id, name: id })),
      properties: {},
      isInline: false,
    }));
    notion.getDatabaseSchemaFull.mockResolvedValue(SCHEMA);
    notion.getView = vi.fn(async (id: string) => live.get(id) ?? null);
    notion.updateView = vi.fn(async (id: string, request: Record<string, unknown>) => {
      const view = live.get(id)!;
      live.set(id, {
        ...view,
        ...(request["name"] !== undefined ? { name: request["name"] as string } : {}),
        ...(request["filter"] !== undefined ? { filter: request["filter"] } : {}),
        ...(request["sorts"] !== undefined
          ? { sorts: (request["sorts"] ?? undefined) as ViewConfig["sorts"] }
          : {}),
        ...(request["configuration"] !== undefined
          ? { configuration: request["configuration"] as Record<string, unknown> }
          : {}),
      });
    });
  });

  it("pull 이 쓴 그대로면 할 것이 없다", async () => {
    const result = await build().push();
    expect(result.viewEdits).toBeUndefined();
    expect(notion.getView).not.toHaveBeenCalled();
  });

  it("열 · 정렬 · 필터 · 이름을 한 번에 — 기록이 고친 것이 되어 다시 push 하면 할 것이 없다", async () => {
    edit((views) => {
      const table = views[0]!;
      table["name"] = "점수표";
      table["order"] = ["file.name", "상태", "점수"];
      table["sort"] = [{ property: "마감", direction: "ASC" }];
      table["filters"] = { and: ['상태 == "가"', "점수 >= 3"] };
    });

    const result = await build().push();

    expect(result.failed).toEqual([]);
    expect(notion.updateView).toHaveBeenCalledTimes(1);
    expect(notion.updateView).toHaveBeenCalledWith("view-table", {
      name: "점수표",
      configuration: {
        type: "table",
        properties: [
          { property_id: "title", visible: true, width: 120 },
          { property_id: "p4", visible: true, width: 120 },
          { property_id: "p:1", visible: true, width: 120 },
          { property_id: "p2", visible: false, width: 120 },
          { property_id: "p3", visible: false, width: 120 },
        ],
      },
      sorts: [{ property: "p3", direction: "ascending" }],
      filter: {
        and: [
          { property: "p4", select: { equals: "가" } },
          { property: "p:1", number: { greater_than_or_equal_to: 3 } },
        ],
      },
    });
    expect(result.viewEdits).toEqual([
      { path: PATH, view: "점수표", from: "표", changed: ["name", "columns", "sort", "filter"] },
    ]);
    // 모두 올렸으니 이 파일은 pull 이 쓴 것과 같은 뜻 — 다음 pull 이 Notion 의 모습으로 다시 쓴다.
    expect(record().hash).toBe(computeHash(files.get(PATH)!));

    notion.updateView.mockClear();
    const again = await build().push();
    expect(again.viewEdits).toBeUndefined();
    expect(notion.updateView).not.toHaveBeenCalled();
  });

  it("보드의 열을 바꾸면 group_by 를 함께 보낸다 — 빠지면 Notion 이 400 으로 거절한다", async () => {
    edit((views) => {
      views[1]!["order"] = ["file.name", "메모"];
    });

    await build().push();

    const [, request] = notion.updateView.mock.calls[0]!;
    expect(request.configuration.group_by).toEqual({
      type: "select",
      property_id: "p4",
      sort: { type: "manual" },
    });
    expect(request.configuration.properties.map((p: { visible: boolean }) => p.visible)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("정렬 · 필터를 지우면 null 로 지운다", async () => {
    edit((views) => {
      delete views[0]!["sort"];
      delete views[0]!["filters"];
    });

    await build().push();

    expect(notion.updateView).toHaveBeenCalledWith("view-table", { sorts: null, filter: null });
  });

  it("dry-run 은 올릴 것을 알리기만 한다", async () => {
    edit((views) => {
      views[0]!["name"] = "새 표";
    });

    const result = await build().push({ dryRun: true });

    expect(result.viewEdits).toEqual([
      { path: PATH, view: "새 표", from: "표", changed: ["name"] },
    ]);
    expect(notion.updateView).not.toHaveBeenCalled();
    expect(record().hash).toBe(computeHash(generated));
  });

  it("그 사이 Notion 에서도 그 보기를 고쳤으면 올리지 않고 이유를 알린다", async () => {
    live.set("view-table", { ...live.get("view-table")!, name: "Notion 에서 바꿈" });
    edit((views) => {
      views[0]!["name"] = "볼트에서 바꿈";
    });

    const result = await build().push();

    expect(notion.updateView).not.toHaveBeenCalled();
    expect(result.failed).toEqual([
      expect.objectContaining({ path: PATH, error: expect.stringContaining("Notion 에서도") }),
    ]);
  });

  it("Notion 에서 지운 보기 · 데이터 소스가 여럿인 DB 는 올리지 않는다", async () => {
    edit((views) => {
      views[0]!["name"] = "새 표";
    });
    live.delete("view-table");
    expect((await build().push()).failed[0]?.error).toContain("지운 보기");

    sources = ["ds-1", "ds-2"];
    expect((await build().push()).failed[0]?.error).toContain("데이터 소스가 여럿");
    expect(notion.updateView).not.toHaveBeenCalled();
  });

  it("옮길 수 없는 것이 하나라도 있으면 그 보기 전체를 올리지 않고, 다른 보기는 올린다", async () => {
    edit((views) => {
      views[0]!["name"] = "새 표";
      views[0]!["sort"] = [{ property: "file.mtime", direction: "DESC" }];
      views[1]!["name"] = "새 보드";
    });

    const result = await build().push();

    expect(notion.updateView).toHaveBeenCalledTimes(1);
    expect(notion.updateView).toHaveBeenCalledWith("view-board", { name: "새 보드" });
    expect(result.failed).toEqual([
      expect.objectContaining({ path: PATH, error: expect.stringContaining("file.mtime") }),
    ]);
    // 남은 것이 있어 계속 붙잡아 둔다 — 다음 pull 이 덮어쓰면 볼트의 고침이 사라진다.
    expect(record().hash).toBe(computeHash(generated));
    expect(record().views!.find((v) => v.viewId === "view-board")!.name).toBe("새 보드");
  });

  it("거절하는 열 · 필터 — 수식 열, Notion 에 없는 필터 꼴", async () => {
    edit((views) => {
      views[0]!["order"] = ["file.name", "formula.합"];
    });
    expect((await build().push()).failed[0]?.error).toContain("formula.합");

    edit((views) => {
      views[0]!["filters"] = 'file.folder == "x"';
    });
    expect((await build().push()).failed[0]?.error).toContain("필터");
    expect(notion.updateView).not.toHaveBeenCalled();
  });

  it("Notion 필터에 볼트로 옮기지 못한 조건이 있었으면 볼트의 필터로 덮지 않는다", async () => {
    const { views, ...base } = record();
    new DbBaseFiles(stateDb as never).set(DB_ID, {
      ...base,
      views: views!.map((v) => (v.viewId === "view-table" ? { ...v, lossyFilter: true } : v)),
    });
    edit((v) => {
      v[0]!["filters"] = "점수 > 1";
    });

    const result = await build().push();

    expect(result.failed[0]?.error).toContain("옮기지 못한 조건");
    expect(notion.updateView).not.toHaveBeenCalled();
  });

  it("올리지 않는 것(보기 추가 · 타입)을 함께 고쳤으면 올린 뒤에도 붙잡아 둔다", async () => {
    edit((views) => {
      views[0]!["name"] = "새 표";
      views.push({ type: "list", name: "볼트에서 더한 목록" });
    });

    const result = await build().push();

    expect(result.viewEdits).toHaveLength(1);
    expect(record().hash).toBe(computeHash(generated));
  });

  it("Notion 이 거절하면 그 이유로 실패를 남기고 기록은 그대로 — 다음 push 가 다시 한다", async () => {
    notion.updateView.mockRejectedValue(new Error("validation_error"));
    edit((views) => {
      views[0]!["name"] = "새 표";
    });

    const result = await build().push();

    expect(result.failed[0]?.error).toContain("validation_error");
    expect(result.viewEdits).toBeUndefined();
    expect(record().views!.find((v) => v.viewId === "view-table")!.name).toBe("표");
  });

  it("보기를 기록하지 않은 `.base`(직접 만든 것)는 건드리지 않는다", async () => {
    const { views: _v, rest: _r, ...plain } = record();
    new DbBaseFiles(stateDb as never).set(DB_ID, plain);
    edit((views) => {
      views[0]!["name"] = "새 표";
    });

    const result = await build().push();

    expect(result.failed).toEqual([]);
    expect(notion.getView).not.toHaveBeenCalled();
  });
});
