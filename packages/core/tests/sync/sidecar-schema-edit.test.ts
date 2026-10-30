/**
 * P3 · ADR-045 — 볼트에서 고친 사이드카(`<db>.notion.json`)의 속성이 Notion DB 의 열이 된다. 예전에는 사이드카를 고쳐도
 * Notion 에 가지 않았고, 다음 pull 이 말없이 덮어써 고친 것이 사라졌다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { diffSidecarProperties, renamedOptions } from "../../src/sync/sidecar-schema-edit.js";
import { SIDECAR_BASES_META_KEY, SidecarBases } from "../../src/sync/sidecar-bases.js";
import { DB_SCHEMAS_META_KEY } from "../../src/sync/schema-ledger.js";
import type { SidecarProperty } from "../../src/view/sidecar-generator.js";
import { computeHash } from "../../src/utils/hash.js";
import { compactNotionId } from "../../src/utils/id.js";
import { setLogger } from "../../src/utils/logger.js";
import {
  createMockVaultFs,
  createMockStateDb,
  createMockNotionClient,
  createConfig,
} from "../helpers/mock-orchestrator.js";

const TITLE: SidecarProperty = { id: "title", name: "이름", type: "title" };
const SCORE: SidecarProperty = {
  id: "p1",
  name: "점수",
  type: "number",
  definition: { format: "number" },
};
const MEMO: SidecarProperty = { id: "p2", name: "메모", type: "rich_text" };
const TWICE: SidecarProperty = {
  id: "p3",
  name: "두배",
  type: "formula",
  definition: { expression: "1+1" },
};
const TAG: SidecarProperty = {
  id: "p4",
  name: "태그",
  type: "select",
  options: ["가"],
  definition: { options: [{ name: "가", color: "red" }] },
};
const BASE = [TITLE, SCORE, MEMO, TWICE, TAG];

describe("diffSidecarProperties — 지난 기록과 id 로 견준다", () => {
  const ok = (edited: SidecarProperty[]) => {
    const diff = diffSidecarProperties(BASE, edited);
    if (!diff.ok) throw new Error(diff.error);
    return diff;
  };
  const error = (edited: SidecarProperty[]) => {
    const diff = diffSidecarProperties(BASE, edited);
    if (diff.ok) throw new Error("받으면 안 된다");
    return diff.error;
  };

  it("같으면 보낼 것이 없다", () => {
    expect(ok(BASE).payload).toEqual({});
  });

  it("이름 · 타입 · 지움 · 더함을 id 와 이름으로", () => {
    const diff = ok([
      TITLE,
      { ...SCORE, name: "점수표" },
      { ...MEMO, type: "number" },
      TAG,
      { name: "마감", type: "date" },
    ]);
    expect(diff.payload).toEqual({
      p1: { name: "점수표" },
      p2: { number: {} },
      p3: null,
      마감: { date: {} },
    });
    expect(diff.edit).toEqual({
      added: ["마감"],
      removed: ["두배"],
      renamed: [["점수", "점수표"]],
      retyped: [["메모", "number"]],
      redefined: [],
    });
  });

  it("수식 · 숫자 형식은 설정을 보내고, 옵션 이름만 고치면 지난 색을 둔다", () => {
    const diff = ok([
      TITLE,
      { ...SCORE, definition: { format: "percent" } },
      MEMO,
      { ...TWICE, definition: { expression: "2+2" } },
      { ...TAG, options: ["가", "나"] },
    ]);
    expect(diff.payload).toEqual({
      p1: { number: { format: "percent" } },
      p3: { formula: { expression: "2+2" } },
      p4: { select: { options: [{ name: "가", color: "red" }, { name: "나" }] } },
    });
    expect(diff.edit.redefined).toEqual(["점수", "두배", "태그"]);
  });

  it("지운 옵션을 알린다 — Notion 이 그 값을 가진 행의 값을 비운다", () => {
    const tags = { ...TAG, options: ["가", "나", "다"] };
    const diff = diffSidecarProperties([TITLE, tags], [TITLE, { ...tags, options: ["나", "라"] }]);
    if (!diff.ok) throw new Error(diff.error);
    expect(diff.edit.droppedOptions).toEqual([["태그", ["가", "다"]]]);
    expect(
      ok([TITLE, SCORE, MEMO, TWICE, { ...TAG, options: ["가", "나"] }]).edit,
    ).not.toHaveProperty("droppedOptions");
  });

  it("같은 자리의 옵션 이름을 바꾸면 이름 바꾸기 — 옛 이름 · 새 이름을 함께 먼저 보내고, 지운 것으로 알리지 않는다", () => {
    const tags = {
      ...TAG,
      options: ["가", "나", "다"],
      definition: {
        options: [
          { name: "가", color: "red" },
          { name: "나", color: "blue" },
          { name: "다", color: "green" },
        ],
      },
    };
    const diff = diffSidecarProperties(
      [TITLE, tags],
      [TITLE, { ...tags, options: ["가", "나나", "다"] }],
    );
    if (!diff.ok) throw new Error(diff.error);
    const final = [
      { name: "가", color: "red" },
      { name: "나나", color: "blue" },
      { name: "다", color: "green" },
    ];
    expect(diff.payload).toEqual({ p4: { select: { options: final } } });
    expect(diff.staged).toEqual({
      p4: { select: { options: [...final, { name: "나", color: "blue" }] } },
    });
    expect(diff.optionRenames).toEqual([
      { propertyId: "p4", type: "select", from: "나", to: "나나" },
    ]);
    expect(diff.edit.renamedOptions).toEqual([["태그", "나", "나나"]]);
    expect(diff.edit).not.toHaveProperty("droppedOptions");
  });

  it("설정(definition)의 옵션 이름을 고쳐도 이름 바꾸기 · 지운 것도 설정으로 가른다", () => {
    const renamed = diffSidecarProperties(
      [TITLE, TAG],
      [TITLE, { ...TAG, definition: { options: [{ name: "갸", color: "red" }] } }],
    );
    if (!renamed.ok) throw new Error(renamed.error);
    expect(renamed.edit.renamedOptions).toEqual([["태그", "가", "갸"]]);
    const dropped = diffSidecarProperties(
      [TITLE, TAG],
      [TITLE, { ...TAG, definition: { options: [] } }],
    );
    if (!dropped.ok) throw new Error(dropped.error);
    expect(dropped.edit.droppedOptions).toEqual([["태그", ["가"]]]);
  });

  it("renamedOptions — 자리가 밀리면 이름 바꾸기가 아니다", () => {
    expect(renamedOptions(["가", "나", "다"], ["가", "다"])).toEqual([]);
    expect(renamedOptions(["가", "나", "다"], ["가", "다", "라"])).toEqual([]);
    expect(renamedOptions(["가", "나"], ["나", "가"])).toEqual([]);
    expect(renamedOptions(["가", "나"], ["갸", "나", "다"])).toEqual([["가", "갸"]]);
  });

  it("제목은 지우거나 타입을 바꿀 수 없다 — 이름은 바꾼다", () => {
    expect(error([SCORE, MEMO, TWICE, TAG])).toContain("제목");
    expect(error([{ ...TITLE, type: "rich_text" }, SCORE, MEMO, TWICE, TAG])).toContain("제목");
    expect(error([...BASE, { name: "둘째 제목", type: "title" }])).toContain("제목");
    expect(ok([{ ...TITLE, name: "제목" }, SCORE, MEMO, TWICE, TAG]).payload).toEqual({
      title: { name: "제목" },
    });
  });

  it("모든 속성을 지우는 것 · 같은 이름 둘 · 모르는 id 는 받지 않는다", () => {
    expect(error([TITLE])).toContain("모든 속성");
    expect(error([...BASE, { name: "메모", type: "number" }])).toContain("둘");
    expect(error([TITLE, { ...SCORE, name: "메모" }, MEMO, TWICE, TAG])).toContain("둘");
    expect(error([...BASE, { id: "zz", name: "새것", type: "number" }])).toContain("id");
  });

  it("고칠 수 없는 타입의 설정을 고치면 받지 않는다", () => {
    const relation: SidecarProperty = {
      id: "r1",
      name: "관계",
      type: "relation",
      definition: { database: "x" },
    };
    const diff = diffSidecarProperties(
      [...BASE, relation],
      [...BASE, { ...relation, definition: { database: "y" } }],
    );
    expect(diff.ok).toBe(false);
  });
});

describe("push — 고친 사이드카의 속성을 Notion DB 에", () => {
  const DB_ID = "db-tasks";
  const DS = "ds-aaa";
  const PATH = "Projects/과제/과제.notion.json";
  let vaultFs: ReturnType<typeof createMockVaultFs>;
  let stateDb: ReturnType<typeof createMockStateDb>;
  let notion: ReturnType<typeof createMockNotionClient> & {
    updateDataSourceProperties: ReturnType<typeof vi.fn>;
  };
  let files: Map<string, string>;
  let metaStore: Map<string, string>;
  let live: Record<string, { id: string; type: string }>;
  let sources: string[];

  const sidecar = (properties: SidecarProperty[]) =>
    JSON.stringify(
      {
        databaseId: DB_ID,
        databaseName: "과제",
        generator: "im-nobsidian",
        properties,
        schemaVersion: 2,
        views: [],
      },
      null,
      2,
    ) + "\n";
  const build = () =>
    new SyncOrchestrator(createConfig(), stateDb as never, notion as never, vaultFs);

  beforeEach(() => {
    setLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    vaultFs = createMockVaultFs();
    stateDb = createMockStateDb();
    notion = createMockNotionClient() as typeof notion;
    metaStore = new Map();
    files = new Map([[PATH, sidecar(BASE)]]);
    live = Object.fromEntries(BASE.map((p) => [p.name, { id: p.id, type: p.type }]));
    sources = [DS];
    (vaultFs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (p: string) => {
      const content = files.get(p);
      if (content === undefined) throw new Error(`ENOENT ${p}`);
      return content;
    });
    stateDb.getMeta.mockImplementation((k: string) => metaStore.get(k) ?? null);
    stateDb.setMeta.mockImplementation((k: string, v: string) => void metaStore.set(k, v));
    new SidecarBases(stateDb as never).set(DB_ID, {
      path: PATH,
      hash: computeHash(files.get(PATH)!),
      properties: BASE,
    });
    notion.getDatabaseMeta.mockImplementation(async () => ({
      databaseId: DB_ID,
      title: "과제",
      dataSources: sources.map((id) => ({ id, name: id, properties: live })),
      properties: live,
      isInline: false,
    }));
    notion.updateDataSourceProperties = vi.fn(
      async (_ds: string, payload: Record<string, unknown>) => {
        for (const [key, change] of Object.entries(payload)) {
          const name = Object.keys(live).find((n) => live[n]!.id === key);
          if (change === null) delete live[name!];
          else if (!name) live[key] = { id: `new-${key}`, type: Object.keys(change as object)[0]! };
          else {
            const { name: next, ...rest } = change as { name?: string };
            const prop = {
              ...live[name]!,
              ...(Object.keys(rest)[0] ? { type: Object.keys(rest)[0]! } : {}),
            };
            delete live[name];
            live[next ?? name] = prop;
          }
        }
        return live;
      },
    );
  });

  it("고친 속성을 한 번에 보내고, 기록을 고친 것으로 — 다시 push 하면 할 것이 없다", async () => {
    files.set(
      PATH,
      sidecar([TITLE, { ...SCORE, name: "점수표" }, MEMO, TAG, { name: "마감", type: "date" }]),
    );

    const result = await build().push();

    expect(result.failed).toEqual([]);
    expect(notion.updateDataSourceProperties).toHaveBeenCalledTimes(1);
    expect(notion.updateDataSourceProperties).toHaveBeenCalledWith(DS, {
      p1: { name: "점수표" },
      p3: null,
      마감: { date: {} },
    });
    expect(result.schemaEdits).toEqual([
      {
        path: PATH,
        added: ["마감"],
        removed: ["두배"],
        renamed: [["점수", "점수표"]],
        retyped: [],
        redefined: [],
      },
    ]);
    const base = new SidecarBases(stateDb as never).get(DB_ID)!;
    expect(base.hash).toBe(computeHash(files.get(PATH)!));
    expect(base.properties.find((p) => p.name === "마감")?.id).toBe("new-마감");

    notion.updateDataSourceProperties.mockClear();
    const again = await build().push();
    expect(again.schemaEdits).toBeUndefined();
    expect(notion.updateDataSourceProperties).not.toHaveBeenCalled();
  });

  it("옵션 이름을 바꾸면 새 이름을 더하고 · 그 값의 행을 옮긴 뒤 · 옛 이름을 지운다", async () => {
    const calls: string[] = [];
    notion.updateDataSourceProperties.mockImplementation(async (_ds: string, payload: object) => {
      calls.push(`schema ${JSON.stringify(payload)}`);
      return live;
    });
    notion.queryAllDatabasePages.mockImplementation(async (_db: string, filter: unknown) => {
      calls.push(`query ${JSON.stringify(filter)}`);
      return [
        { id: "row-1", properties: { 태그: { id: "p4", type: "select", select: { name: "가" } } } },
      ];
    });
    notion.updatePageProperties.mockImplementation(async (id: string, props: object) => {
      calls.push(`row ${id} ${JSON.stringify(props)}`);
      return {};
    });
    files.set(PATH, sidecar([TITLE, SCORE, MEMO, TWICE, { ...TAG, options: ["갸"] }]));

    const result = await build().push();

    expect(result.failed).toEqual([]);
    expect(calls).toEqual([
      `schema ${JSON.stringify({
        p4: {
          select: {
            options: [
              { name: "갸", color: "red" },
              { name: "가", color: "red" },
            ],
          },
        },
      })}`,
      `query ${JSON.stringify({ property: "p4", select: { equals: "가" } })}`,
      `row row-1 ${JSON.stringify({ p4: { select: { name: "갸" } } })}`,
      `schema ${JSON.stringify({ p4: { select: { options: [{ name: "갸", color: "red" }] } } })}`,
    ]);
    expect(result.schemaEdits?.[0]?.renamedOptions).toEqual([["태그", "가", "갸"]]);
    expect(new SidecarBases(stateDb as never).get(DB_ID)!.hash).toBe(computeHash(files.get(PATH)!));
  });

  it("여러 선택 옵션은 행의 다른 값을 두고 바꾼 이름만 옮긴다 · 행을 옮기다 멈추면 기록을 두어 다음 push 가 다시 한다", async () => {
    const LABELS: SidecarProperty = {
      id: "p5",
      name: "라벨",
      type: "multi_select",
      options: ["A", "B"],
      definition: { options: [{ name: "A" }, { name: "B" }] },
    };
    const before = [...BASE, LABELS];
    live = Object.fromEntries(before.map((p) => [p.name, { id: p.id, type: p.type }]));
    files.set(PATH, sidecar(before));
    new SidecarBases(stateDb as never).set(DB_ID, {
      path: PATH,
      hash: computeHash(files.get(PATH)!),
      properties: before,
    });
    notion.updateDataSourceProperties.mockResolvedValue(live);
    notion.queryAllDatabasePages.mockResolvedValue([
      {
        id: "row-1",
        properties: { 라벨: { id: "p5", multi_select: [{ name: "A" }, { name: "B" }] } },
      },
    ]);
    notion.updatePageProperties.mockRejectedValueOnce(new Error("rate limited"));
    files.set(PATH, sidecar([...BASE, { ...LABELS, options: ["A", "BB"] }]));

    const failed = await build().push();
    expect(failed.failed[0]?.error).toContain("rate limited");
    expect(notion.updateDataSourceProperties).toHaveBeenCalledTimes(1);
    expect(new SidecarBases(stateDb as never).get(DB_ID)!.hash).not.toBe(
      computeHash(files.get(PATH)!),
    );

    const retried = await build().push();
    expect(retried.failed).toEqual([]);
    expect(notion.queryAllDatabasePages).toHaveBeenLastCalledWith(compactNotionId(DB_ID), {
      property: "p5",
      multi_select: { contains: "B" },
    });
    expect(notion.updatePageProperties).toHaveBeenLastCalledWith("row-1", {
      p5: { multi_select: [{ name: "A" }, { name: "BB" }] },
    });
  });

  it("지난 pull 이 본 스키마가 없으면 바꾸기 전 것을 적는다 — 다음 pull 이 행 키를 옮긴다", async () => {
    files.set(PATH, sidecar([TITLE, { ...SCORE, name: "점수표" }, MEMO, TWICE, TAG]));

    await build().push();

    const seen = JSON.parse(metaStore.get(DB_SCHEMAS_META_KEY)!);
    expect(seen.dbtasks.dsaaa.p1).toEqual({ name: "점수", type: "number" });
  });

  it("dry-run 은 올릴 것을 알리기만 한다", async () => {
    files.set(PATH, sidecar([TITLE, SCORE, MEMO, TAG]));

    const result = await build().push({ dryRun: true });

    expect(result.schemaEdits?.[0]?.removed).toEqual(["두배"]);
    expect(notion.updateDataSourceProperties).not.toHaveBeenCalled();
    expect(new SidecarBases(stateDb as never).get(DB_ID)!.hash).not.toBe(
      computeHash(files.get(PATH)!),
    );
  });

  it("그 사이 Notion 에서도 바뀌었으면 올리지 않고 이유를 알린다", async () => {
    live = { ...live, 새것: { id: "p9", type: "number" } };
    files.set(PATH, sidecar([TITLE, { ...SCORE, name: "점수표" }, MEMO, TWICE, TAG]));

    const result = await build().push();

    expect(notion.updateDataSourceProperties).not.toHaveBeenCalled();
    expect(result.failed).toEqual([
      expect.objectContaining({ path: PATH, error: expect.stringContaining("Notion 에서도") }),
    ]);
  });

  it("데이터 소스가 여럿인 DB 는 올리지 않는다", async () => {
    sources = [DS, "ds-bbb"];
    files.set(PATH, sidecar([TITLE, { ...SCORE, name: "점수표" }, MEMO, TWICE, TAG]));

    const result = await build().push();

    expect(notion.updateDataSourceProperties).not.toHaveBeenCalled();
    expect(result.failed[0]?.error).toContain("데이터 소스가 여럿");
  });

  it("Notion 이 거절하면 그 이유로 실패를 남기고 기록은 그대로 — 다음 push 가 다시 한다", async () => {
    notion.updateDataSourceProperties.mockRejectedValue(new Error("invalid formula"));
    files.set(
      PATH,
      sidecar([TITLE, SCORE, MEMO, { ...TWICE, definition: { expression: "(" } }, TAG]),
    );

    const result = await build().push();

    expect(result.failed[0]?.error).toContain("invalid formula");
    expect(result.schemaEdits).toBeUndefined();
    expect(new SidecarBases(stateDb as never).get(DB_ID)!.hash).not.toBe(
      computeHash(files.get(PATH)!),
    );
  });

  it("보기만 고친 사이드카 · 기록이 없는 사이드카 · 읽을 수 없는 JSON", async () => {
    files.set(PATH, sidecar(BASE).replace('"views": []', '"views": [{"name":"x"}]'));
    expect((await build().push()).failed).toEqual([]);

    files.set(PATH, "{ 깨짐");
    expect((await build().push()).failed[0]?.error).toContain("JSON");

    metaStore.delete(SIDECAR_BASES_META_KEY);
    files.set(PATH, sidecar([TITLE]));
    expect((await build().push()).failed).toEqual([]);
    expect(notion.updateDataSourceProperties).not.toHaveBeenCalled();
  });
});
