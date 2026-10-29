/**
 * P3 · ADR-045 — 볼트에서 바꾼 DB 속성 이름(Obsidian 의 속성 이름 바꾸기)이 Notion 의 열 이름이 된다.
 *
 * 예전 push 는 그 키를 가진 모든 행을 «옛 키를 비우고 모르는 새 키를 더함» 으로 읽어, Notion 의 그 열을 모든 행에서
 * 비웠다 — 새 키는 DB 에 없는 속성이라 보내지 않았다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { computeHash } from "../../src/utils/hash.js";
import { setLogger } from "../../src/utils/logger.js";
import { snapshotFrontmatter } from "../../src/utils/frontmatter.js";
import { DB_SCHEMAS_META_KEY } from "../../src/sync/schema-ledger.js";
import {
  createMockVaultFs,
  createMockStateDb,
  createMockNotionClient,
  createConfig,
  mirrorRemoteObservation,
  settledObservation,
} from "../helpers/mock-orchestrator.js";

const DB_ID = "db-tasks";
const DS1 = "ds-aaa";
const DS2 = "ds-bbb";
const FOLDER = "Projects/과제";
const SYNCED_AT = "2026-10-29T01:00:00.000Z";
const PROPS_AT = "2026-10-29T02:00:00.000Z";

type Schema = Record<string, { id: string; type: string }>;
const SCHEMA: Schema = {
  이름: { id: "title", type: "title" },
  점수: { id: "p1", type: "number" },
  메모: { id: "p2", type: "rich_text" },
};

const note = (title: string, props: string) => `---\ntitle: ${title}\n${props}---\n본문\n`;
const A = note("A", "점수: 3\n메모: 가\n");
const B = note("B", "점수: 5\n메모: 나\n");
const C = note("C", "메모: 다\n"); // 점수가 빈 행

function rowRecord(name: string, base: string) {
  return {
    id: `rec-${name}`,
    obsidianPath: `${FOLDER}/${name}.md`,
    notionPageId: `row-${name}`,
    notionParentId: DB_ID,
    contentHash: computeHash(base),
    ...settledObservation(SYNCED_AT),
    localLastModified: SYNCED_AT,
    syncDirection: "both",
    fileType: "db-row",
    status: "synced",
    baseSnapshot: Buffer.from(base, "utf-8"),
    localMtime: "2020-01-01T00:00:00.000Z",
    localFileSize: 1,
  };
}

describe("P3 볼트에서 바꾼 DB 속성 이름 → Notion 열 이름", () => {
  let vaultFs: ReturnType<typeof createMockVaultFs>;
  let stateDb: ReturnType<typeof createMockStateDb>;
  let notion: ReturnType<typeof createMockNotionClient> & {
    updateDataSourceProperties: ReturnType<typeof vi.fn>;
  };
  let files: Map<string, string>;
  let records: Map<string, ReturnType<typeof rowRecord>>;
  let metaStore: Map<string, string>;
  let sources: Array<{ id: string; properties: Schema }>;

  const build = () =>
    new SyncOrchestrator(createConfig(), stateDb as never, notion as never, vaultFs);
  const path = (name: string) => `${FOLDER}/${name}.md`;

  beforeEach(() => {
    setLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    vaultFs = createMockVaultFs();
    stateDb = createMockStateDb();
    notion = createMockNotionClient() as typeof notion;
    files = new Map([
      [path("A"), A],
      [path("B"), B],
      [path("C"), C],
    ]);
    records = new Map(
      [rowRecord("A", A), rowRecord("B", B), rowRecord("C", C)].map((r) => [r.obsidianPath, r]),
    );
    metaStore = new Map();
    sources = [{ id: DS1, properties: { ...SCHEMA } }];

    (vaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      [...files.keys()].map((p) => ({ path: p, mtime: new Date().toISOString(), size: 100 })),
    );
    (vaultFs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (p: string) => {
      const content = files.get(p);
      if (content === undefined) throw new Error(`ENOENT ${p}`);
      return content;
    });
    stateDb.getAll.mockImplementation(() => [...records.values()]);
    stateDb.getByPath.mockImplementation((p: string) => records.get(p) ?? null);
    stateDb.getByStatus.mockImplementation((status: string) =>
      [...records.values()].filter((r) => r.status === status),
    );
    stateDb.getMeta.mockImplementation((k: string) => metaStore.get(k) ?? null);
    stateDb.setMeta.mockImplementation((k: string, v: string) => void metaStore.set(k, v));
    stateDb.updateHash.mockImplementation((id: string, hash: string, snapshot: Buffer) => {
      for (const r of records.values()) {
        if (r.id === id) Object.assign(r, { contentHash: hash, baseSnapshot: snapshot });
      }
    });
    mirrorRemoteObservation(stateDb, () => records.values());

    const merged = (): Schema =>
      Object.assign({}, ...sources.map((ds) => ds.properties).reverse()) as Schema;
    notion.getDatabaseMeta.mockImplementation(async () => ({
      databaseId: DB_ID,
      title: "과제",
      dataSources: sources.map((ds) => ({ id: ds.id, name: ds.id, properties: ds.properties })),
      properties: merged(),
      isInline: false,
    }));
    notion.getDatabaseSchema.mockImplementation(async () => merged());
    notion.updateDataSourceProperties = vi.fn(
      async (dsId: string, props: Record<string, { name: string }>) => {
        const ds = sources.find((s) => s.id === dsId)!;
        for (const [id, change] of Object.entries(props)) {
          const name = Object.keys(ds.properties).find((n) => ds.properties[n]!.id === id)!;
          const prop = ds.properties[name]!;
          delete ds.properties[name];
          ds.properties[change.name] = prop;
        }
        return ds.properties;
      },
    );
    notion.getPage.mockImplementation(async (id: string) => ({
      id,
      last_edited_time: SYNCED_AT,
      properties: {},
    }));
    notion.updatePageProperties.mockResolvedValue({ last_edited_time: PROPS_AT });
  });

  /** Obsidian 의 속성 이름 바꾸기 — 그 키를 가진 모든 노트의 키를 바꾼다. */
  const renameInVault = (from: string, to: string) => {
    for (const [p, content] of files) files.set(p, content.replace(`\n${from}:`, `\n${to}:`));
  };

  it("모든 행에서 바꾼 이름은 열 이름을 속성 id 로 바꾸고 행 값은 보내지 않는다", async () => {
    renameInVault("점수", "점수표");

    const result = await build().push();

    expect(result.failed).toEqual([]);
    expect(notion.updateDataSourceProperties).toHaveBeenCalledTimes(1);
    expect(notion.updateDataSourceProperties).toHaveBeenCalledWith(DS1, {
      p1: { name: "점수표" },
    });
    expect(notion.updatePageProperties).not.toHaveBeenCalled();
    expect(notion.replacePageMarkdown).not.toHaveBeenCalled();
    expect(result.renamedProperties).toEqual([{ folder: FOLDER, from: "점수", to: "점수표" }]);
    expect(result.updated).toBe(0);
    // 사본도 새 키 — 다음 push 가 옛 키를 «비움» 으로 보지 않는다.
    for (const name of ["A", "B"]) {
      const base = snapshotFrontmatter(records.get(path(name))!.baseSnapshot)!;
      expect(Object.keys(base)).toContain("점수표");
      expect(Object.keys(base)).not.toContain("점수");
      expect(records.get(path(name))!.contentHash).toBe(computeHash(files.get(path(name))!));
    }

    // 다시 push 해도 할 것이 없다.
    notion.updateDataSourceProperties.mockClear();
    const again = await build().push();
    expect(again.renamedProperties).toBeUndefined();
    expect(notion.updateDataSourceProperties).not.toHaveBeenCalled();
    expect(notion.updatePageProperties).not.toHaveBeenCalled();
  });

  it("이름을 바꾸며 값도 고친 행은 이름을 바꾼 뒤 고친 값만 새 이름으로 보낸다", async () => {
    renameInVault("점수", "점수표");
    files.set(path("A"), files.get(path("A"))!.replace("메모: 가", "메모: 가나"));

    const result = await build().push();

    expect(result.failed).toEqual([]);
    expect(notion.updateDataSourceProperties).toHaveBeenCalledTimes(1);
    expect(notion.updatePageProperties).toHaveBeenCalledTimes(1);
    const [pageId, props] = notion.updatePageProperties.mock.calls[0]!;
    expect(pageId).toBe("row-A");
    expect(Object.keys(props)).toEqual(["메모"]);
    expect(result.updated).toBe(1);
  });

  it("이름을 바꾼 뒤 그 속성의 값까지 고친 행이 있어도 — 다른 행이 같은 값이면 — 이름 바꾸기다", async () => {
    renameInVault("점수", "점수표");
    files.set(path("A"), files.get(path("A"))!.replace("점수표: 3", "점수표: 4"));

    const result = await build().push();

    expect(result.failed).toEqual([]);
    expect(notion.updateDataSourceProperties).toHaveBeenCalledWith(DS1, {
      p1: { name: "점수표" },
    });
    // 옛 열을 비우지 않고, 고친 값만 새 이름으로.
    expect(notion.updatePageProperties).toHaveBeenCalledTimes(1);
    expect(notion.updatePageProperties).toHaveBeenCalledWith("row-A", { 점수표: { number: 4 } });
  });

  it("행이 하나뿐이고 값까지 고쳤으면 이름 바꾸기로 보지 않는다 — 지움 + 로컬 키와 가를 수 없다", async () => {
    files.delete(path("B"));
    files.delete(path("C"));
    records.delete(path("B"));
    records.delete(path("C"));
    files.set(path("A"), A.replace("점수: 3", "점수표: 4"));

    await build().push();

    expect(notion.updateDataSourceProperties).not.toHaveBeenCalled();
  });

  it("바꾸지 않은 행에 옛 키가 남아 있으면 이름 바꾸기가 아니다", async () => {
    files.set(path("A"), A.replace("\n점수:", "\n점수표:"));

    await build().push();

    expect(notion.updateDataSourceProperties).not.toHaveBeenCalled();
  });

  it("새 이름이 이미 있는 열이면 열 이름을 바꾸지 않는다 — Notion 은 말없이 「이름 1」 로 바꾼다", async () => {
    sources[0]!.properties["점수표"] = { id: "p9", type: "number" };
    renameInVault("점수", "점수표");

    await build().push();

    expect(notion.updateDataSourceProperties).not.toHaveBeenCalled();
  });

  it("DB 속성이 아닌 로컬 키의 이름 바꾸기는 열 이름을 바꾸지 않는다", async () => {
    for (const name of ["A", "B", "C"]) {
      const withLocal = files.get(path(name))!.replace("---\n본문", "내키: x\n---\n본문");
      files.set(path(name), withLocal);
      Object.assign(records.get(path(name))!, {
        contentHash: computeHash(withLocal),
        baseSnapshot: Buffer.from(withLocal, "utf-8"),
      });
    }
    renameInVault("내키", "새키");

    await build().push();

    expect(notion.updateDataSourceProperties).not.toHaveBeenCalled();
  });

  it("dry-run 은 바꿀 이름을 알리기만 한다", async () => {
    renameInVault("점수", "점수표");

    const result = await build().push({ dryRun: true });

    expect(result.renamedProperties).toEqual([{ folder: FOLDER, from: "점수", to: "점수표" }]);
    expect(notion.updateDataSourceProperties).not.toHaveBeenCalled();
    expect(stateDb.updateHash).not.toHaveBeenCalled();
  });

  it("열 이름을 바꾸지 못하면 그 행을 올리지 않고 이유와 함께 실패로 남긴다", async () => {
    notion.updateDataSourceProperties.mockRejectedValue(new Error("권한 없음"));
    renameInVault("점수", "점수표");

    const result = await build().push();

    expect(notion.updatePageProperties).not.toHaveBeenCalled();
    expect(result.failed.map((f) => f.path).sort()).toEqual([path("A"), path("B")]);
    expect(result.failed[0]!.error).toContain("권한 없음");
    expect(result.renamedProperties).toBeUndefined();
    expect(snapshotFrontmatter(records.get(path("A"))!.baseSnapshot)).toHaveProperty("점수");
  });

  it("데이터 소스 여럿에 같은 이름이 있으면 바꾸지 않고 그 행을 올리지 않는다", async () => {
    sources.push({ id: DS2, properties: { ...SCHEMA } });
    renameInVault("점수", "점수표");

    const result = await build().push();

    expect(notion.updateDataSourceProperties).not.toHaveBeenCalled();
    expect(notion.updatePageProperties).not.toHaveBeenCalled();
    expect(result.failed.map((f) => f.path).sort()).toEqual([path("A"), path("B")]);
    expect(result.failed[0]!.error).toContain("데이터 소스");
  });

  it("지난 pull 이 본 스키마에도 새 이름을 적는다 — 다음 pull 이 거꾸로 옮기지 않게", async () => {
    metaStore.set(
      DB_SCHEMAS_META_KEY,
      JSON.stringify({
        dbtasks: {
          dsaaa: { p1: { name: "점수", type: "number" }, p2: { name: "메모", type: "rich_text" } },
        },
      }),
    );
    renameInVault("점수", "점수표");

    await build().push();

    const seen = JSON.parse(metaStore.get(DB_SCHEMAS_META_KEY)!);
    expect(seen.dbtasks.dsaaa.p1).toEqual({ name: "점수표", type: "number" });
  });
});
