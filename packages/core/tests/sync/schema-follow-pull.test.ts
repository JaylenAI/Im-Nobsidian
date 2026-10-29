import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSyncer } from "../../src/sync/database-syncer.js";
import type { Config, DatabaseSyncConfig } from "../../src/types/config.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";
import { computeHash } from "../../src/utils/hash.js";
import { diffRowProperties } from "../../src/sync/row-properties.js";
import { snapshotFrontmatter, splitFrontmatter } from "../../src/utils/frontmatter.js";

/**
 * P3 · ADR-045 — Notion 에서 속성 이름을 바꾸거나 지우거나 더한 것이 행 노트에 온다. 행 페이지의 수정 시각은
 * 그대로다(2026-10-29 실측) — 그래서 행을 다시 받지 않는 pull 이 옮겨야 한다.
 */

const DB_ID = "db-123";
const DS1 = "ds-aaa";
const DS2 = "ds-bbb";
const FOLDER = "databases/tasks";
const EDITED = "2026-10-29T01:00:00.000Z";

type Schema = Record<string, { id: string; type: string }>;

function meta(sources: Array<{ id: string; properties: Schema }>) {
  const merged: Record<string, unknown> = {};
  for (const ds of sources)
    for (const [k, v] of Object.entries(ds.properties)) if (!(k in merged)) merged[k] = v;
  return {
    databaseId: DB_ID,
    title: "Tasks",
    dataSources: sources.map((ds) => ({ id: ds.id, name: ds.id, properties: ds.properties })),
    properties: merged,
    isInline: false,
  };
}

function row(id: string, props: Record<string, unknown>, ds = DS1) {
  return {
    id,
    parent: { type: "data_source_id", data_source_id: ds, database_id: DB_ID },
    last_edited_time: EDITED,
    last_edited_by: { id: "someone" },
    properties: { Name: { id: "title", type: "title", title: [{ plain_text: id }] }, ...props },
  };
}

const text = (id: string, value: string) => ({
  id,
  type: "rich_text",
  rich_text: [{ plain_text: value, annotations: {}, text: { content: value } }],
});

function setup() {
  const files = new Map<string, string>();
  const records = new Map<string, any>();
  const metaStore = new Map<string, string>();
  const vaultFs: VaultFS = {
    readFile: vi.fn(async (path: string) => {
      const f = files.get(path);
      if (f === undefined) throw new Error(`ENOENT: ${path}`);
      return f;
    }),
    readBinary: vi.fn().mockResolvedValue(Buffer.from("")),
    writeFile: vi.fn(async (path: string, content: string) => void files.set(path, content)),
    writeBinary: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    moveFile: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn(async (path: string) => files.has(path)),
    ensureFolder: vi.fn().mockResolvedValue(undefined),
    listMarkdownFiles: vi.fn().mockResolvedValue([]),
    listNonMarkdownFiles: vi.fn().mockResolvedValue([]),
    getFileStat: vi.fn().mockResolvedValue(null),
  };
  const stateDb = {
    getByPath: vi.fn(
      (p: string) => [...records.values()].find((r) => r.obsidianPath === p) ?? null,
    ),
    getByNotionId: vi.fn(
      (id: string) => [...records.values()].find((r) => r.notionPageId === id) ?? null,
    ),
    getAll: vi.fn(() => [...records.values()]),
    getByStatus: vi.fn().mockReturnValue([]),
    upsert: vi.fn(),
    upsertWikilink: vi.fn(),
    deleteWikilink: vi.fn(),
    updateHash: vi.fn((id: string, hash: string, snapshot?: Buffer | null) => {
      const r = records.get(id);
      records.set(id, { ...r, contentHash: hash, baseSnapshot: snapshot ?? r.baseSnapshot });
    }),
    updateStatCache: vi.fn(),
    updateStatus: vi.fn(),
    setRemoteObservation: vi.fn(),
    setNotionBodyFingerprint: vi.fn(),
    updatePath: vi.fn(),
    delete: vi.fn(),
    getMeta: vi.fn((k: string) => metaStore.get(k) ?? null),
    setMeta: vi.fn((k: string, v: string) => void metaStore.set(k, v)),
    storePreserveMarkers: vi.fn(),
    getPreserveMarkers: vi.fn().mockReturnValue([]),
    resolveWikilink: vi.fn().mockReturnValue(null),
    resolvePageId: vi.fn().mockReturnValue(null),
    transaction: vi.fn((fn: () => unknown) => fn()),
    close: vi.fn(),
  };
  let currentMeta = meta([{ id: DS1, properties: {} }]);
  let pages: any[] = [];
  const notion = {
    getDatabaseMeta: vi.fn(async () => currentMeta),
    getDatabaseSchema: vi.fn(async () => {
      const out: Record<string, unknown> = {};
      for (const [name, p] of Object.entries(currentMeta.properties as Schema))
        out[name] = { id: p.id, type: p.type };
      return out;
    }),
    getDatabaseSchemaFull: vi.fn(async () => currentMeta.properties),
    queryAllDatabasePages: vi.fn(async () => pages),
    getPageMarkdown: vi.fn().mockResolvedValue({ markdown: "본문", truncated: false }),
    extractTitle: vi.fn((page: any) => page.id),
    extractCover: vi.fn().mockReturnValue(null),
    extractIcon: vi.fn().mockReturnValue(null),
    getDatabaseViewsConfig: vi.fn().mockResolvedValue({ databaseId: DB_ID, views: [] }),
    getDatabaseTitle: vi.fn().mockResolvedValue("Tasks"),
  };
  const imageHandler = {
    restoreUploadedMedia: vi.fn(async (md: string) => md),
    downloadAllImages: vi.fn(async (md: string) => ({ content: md, downloads: [] })),
    downloadAllFiles: vi.fn(async (md: string) => ({ content: md, downloads: [] })),
    localizeNotionFileUrl: vi.fn().mockResolvedValue(null),
  };
  const dbConfig: DatabaseSyncConfig = {
    databaseId: DB_ID,
    localFolder: FOLDER,
    titleProperty: "Name",
  };
  const config: Config = {
    ...DEFAULT_CONFIG,
    notion: { ...DEFAULT_CONFIG.notion, token: "t", rootPageId: "root", databases: [dbConfig] },
  };
  const syncer = new DatabaseSyncer(
    config,
    stateDb as any,
    notion as any,
    vaultFs,
    createDefaultPipeline({ wikilinkResolver: () => null }),
    imageHandler as any,
  );

  /** 이미 받아 둔 행 — 파일 · 레코드(사본 = 파일). */
  function tracked(id: string, note: string, opts?: { local?: string }) {
    const path = `${FOLDER}/${id}.md`;
    files.set(path, opts?.local ?? note);
    records.set(`rec-${id}`, {
      id: `rec-${id}`,
      obsidianPath: path,
      notionPageId: id,
      notionParentId: DB_ID,
      contentHash: computeHash(note),
      notionLastEdited: EDITED,
      notionLastEditedBy: "someone",
      notionSeenAt: "2026-10-29T02:00:00.000Z",
      fileType: "db-row",
      status: "synced",
      baseSnapshot: Buffer.from(note, "utf-8"),
    });
    return path;
  }

  return {
    files,
    records,
    syncer,
    dbConfig,
    tracked,
    setSchema(sources: Array<{ id: string; properties: Schema }>) {
      currentMeta = meta(sources);
    },
    setPages(next: any[]) {
      pages = next;
    },
    pull: () => syncer.pullDatabase(dbConfig),
  };
}

const NOTE = "---\ntitle: r1\nScore: '3'\nTag: a\n---\n본문\n";

describe("Notion 스키마 변경을 행 노트에 옮긴다 (ADR-045)", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it("속성 이름을 바꾸면 그대로인 행 노트의 키도 같은 자리에서 바뀐다 — 사본도 함께", async () => {
    t.setSchema([
      {
        id: DS1,
        properties: {
          Name: { id: "title", type: "title" },
          Score: { id: "w%5E", type: "rich_text" },
          Tag: { id: "t1", type: "rich_text" },
        },
      },
    ]);
    const path = t.tracked("r1", NOTE);
    t.setPages([row("r1", { Score: text("w%5E", "3"), Tag: text("t1", "a") })]);
    await t.pull(); // 처음 본 스키마를 적는다

    t.setSchema([
      {
        id: DS1,
        properties: {
          Name: { id: "title", type: "title" },
          점수표: { id: "w%5E", type: "rich_text" },
          Tag: { id: "t1", type: "rich_text" },
        },
      },
    ]);
    t.setPages([row("r1", { 점수표: text("w%5E", "3"), Tag: text("t1", "a") })]);
    const result = await t.pull();

    expect(t.files.get(path)).toBe("---\ntitle: r1\n점수표: '3'\nTag: a\n---\n본문\n");
    // 바뀐 파일이라 수정으로 세고, pull 마감이 알릴 것을 남긴다.
    expect(result.updated).toBe(1);
    expect(t.syncer.takeSchemaFollowed()).toEqual([
      { folder: FOLDER, renamed: [["Score", "점수표"]], removed: [], rows: 1, kept: [] },
    ]);
    const record = t.records.get("rec-r1");
    expect(record.baseSnapshot.toString("utf-8")).toBe(t.files.get(path));
    expect(record.contentHash).toBe(computeHash(t.files.get(path)!));
  });

  it("올리지 않은 로컬 값은 새 이름으로 옮기고, 다음 push 가 그 값만 보낸다", async () => {
    t.setSchema([{ id: DS1, properties: { Score: { id: "w%5E", type: "rich_text" } } }]);
    const path = t.tracked("r1", NOTE, {
      local: "---\ntitle: r1\nScore: '5'\nTag: a\n---\n본문\n",
    });
    t.setPages([row("r1", { Score: text("w%5E", "3") })]);
    await t.pull();

    t.setSchema([{ id: DS1, properties: { 점수표: { id: "w%5E", type: "rich_text" } } }]);
    t.setPages([row("r1", { 점수표: text("w%5E", "3") })]);
    await t.pull();

    const local = t.files.get(path)!;
    expect(local).toBe("---\ntitle: r1\n점수표: '5'\nTag: a\n---\n본문\n");
    const base = snapshotFrontmatter(t.records.get("rec-r1").baseSnapshot)!;
    expect(diffRowProperties(base, splitFrontmatter(local).data)).toEqual({
      changed: { 점수표: "5" },
      cleared: [],
    });
  });

  it("Notion 에서 지운 속성의 키는 그대로인 노트에서 빠지고, 올리지 않은 값이면 남긴다", async () => {
    const schema = {
      Score: { id: "w%5E", type: "rich_text" },
      Tag: { id: "t1", type: "rich_text" },
    };
    t.setSchema([{ id: DS1, properties: schema }]);
    const p1 = t.tracked("r1", NOTE);
    const p2 = t.tracked("r2", "---\ntitle: r2\nTag: b\n---\n", {
      local: "---\ntitle: r2\nTag: 고침\n---\n",
    });
    t.setPages([row("r1", { Tag: text("t1", "a") }), row("r2", { Tag: text("t1", "b") })]);
    await t.pull();

    t.setSchema([{ id: DS1, properties: { Score: schema.Score } }]);
    t.setPages([row("r1", {}), row("r2", {})]);
    await t.pull();

    expect(t.files.get(p1)).toBe("---\ntitle: r1\nScore: '3'\n---\n본문\n");
    expect(t.files.get(p2)).toBe("---\ntitle: r2\nTag: 고침\n---\n");
  });

  it("Notion 이 새로 만든 열의 값(수식)은 행이 그대로여도 받는다", async () => {
    t.setSchema([{ id: DS1, properties: { Score: { id: "w%5E", type: "rich_text" } } }]);
    const path = t.tracked("r1", "---\ntitle: r1\nScore: '3'\n---\n본문\n");
    t.setPages([row("r1", { Score: text("w%5E", "3") })]);
    await t.pull();

    t.setSchema([
      {
        id: DS1,
        properties: {
          Score: { id: "w%5E", type: "rich_text" },
          Double: { id: "f1", type: "formula" },
        },
      },
    ]);
    t.setPages([
      row("r1", {
        Score: text("w%5E", "3"),
        Double: { id: "f1", type: "formula", formula: { type: "number", number: 6 } },
      }),
    ]);
    await t.pull();

    expect(t.files.get(path)).toBe("---\ntitle: r1\nScore: '3'\nDouble: 6\n---\n본문\n");
  });

  it("처음 보는 DB 는 적기만 하고 노트를 바꾸지 않는다", async () => {
    t.setSchema([{ id: DS1, properties: { 점수표: { id: "w%5E", type: "rich_text" } } }]);
    const path = t.tracked("r1", NOTE);
    t.setPages([row("r1", { 점수표: text("w%5E", "3") })]);
    await t.pull();
    expect(t.files.get(path)).toBe(NOTE);
  });

  it("여러 data source — 이름을 바꾼 소스의 행만 바꾼다", async () => {
    t.setSchema([
      { id: DS1, properties: { Score: { id: "w%5E", type: "rich_text" } } },
      { id: DS2, properties: { Score: { id: "w%5E", type: "rich_text" } } },
    ]);
    const p1 = t.tracked("r1", NOTE);
    const p2 = t.tracked("r2", "---\ntitle: r2\nScore: '9'\n---\n");
    t.setPages([
      row("r1", { Score: text("w%5E", "3") }),
      row("r2", { Score: text("w%5E", "9") }, DS2),
    ]);
    await t.pull();

    t.setSchema([
      { id: DS1, properties: { 점수표: { id: "w%5E", type: "rich_text" } } },
      { id: DS2, properties: { Score: { id: "w%5E", type: "rich_text" } } },
    ]);
    t.setPages([
      row("r1", { 점수표: text("w%5E", "3") }),
      row("r2", { Score: text("w%5E", "9") }, DS2),
    ]);
    await t.pull();

    expect(t.files.get(p1)).toContain("점수표: '3'");
    expect(t.files.get(p2)).toBe("---\ntitle: r2\nScore: '9'\n---\n");
  });

  it("두 속성의 이름을 맞바꾸면 값도 함께 따라간다", async () => {
    t.setSchema([
      {
        id: DS1,
        properties: { Score: { id: "a", type: "rich_text" }, Tag: { id: "b", type: "rich_text" } },
      },
    ]);
    const path = t.tracked("r1", NOTE);
    t.setPages([row("r1", { Score: text("a", "3"), Tag: text("b", "a") })]);
    await t.pull();

    t.setSchema([
      {
        id: DS1,
        properties: { Tag: { id: "a", type: "rich_text" }, Score: { id: "b", type: "rich_text" } },
      },
    ]);
    t.setPages([row("r1", { Tag: text("a", "3"), Score: text("b", "a") })]);
    await t.pull();

    expect(t.files.get(path)).toBe("---\ntitle: r1\nTag: '3'\nScore: a\n---\n본문\n");
  });
});
