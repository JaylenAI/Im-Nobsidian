/**
 * S-01 · S-02 — DB 행을 push 하면 속성은 DB 속성으로, 본문은 본문으로 간다.
 *
 * 예전에는 행인지를 전역 모드(parentMode)로 갈라, 페이지 모드 볼트의 자동 발견 DB 행이
 * 페이지로 밀렸다. 속성은 제목만 갔고 나머지는 본문 첫머리에 YAML 코드 블록으로 끼워졌다
 * (QA 실측: 진척 0.42 → 0.5 를 push 해도 Notion 속성 17개 중 변경 0, 본문 YAML 에만 0.5).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";
import { computeHash } from "../../src/utils/hash.js";
import { setLogger } from "../../src/utils/logger.js";
import type { Config } from "../../src/types/config.js";
import {
  createMockVaultFs,
  createMockStateDb,
  createMockNotionClient,
  createConfig,
} from "../helpers/mock-orchestrator.js";

const ROW_PATH = "Projects/과제/과제 A.md";
const ROW_ID = "row-81a9";
const DB_ID = "db-tasks";
const SYNCED_AT = "2026-09-26T13:58:00.000Z";
const PROPS_AT = "2026-09-27T01:00:00.000Z";
const BODY_AT = "2026-09-27T02:00:00.000Z";

const SCHEMA = {
  이름: { id: "title", type: "title" },
  진척: { id: "p1", type: "number" },
  상태: { id: "p2", type: "status" },
  마감: { id: "p3", type: "date" },
  설명: { id: "p4", type: "rich_text" },
  태그: { id: "p5", type: "multi_select" },
  생성일: { id: "p6", type: "created_time" },
  첨부: { id: "p7", type: "files" },
};

// pull 이 쓰는 모양 그대로 — 날짜는 따옴표 없이(js-yaml 이 Date 로 읽는다), 시각은 따옴표.
const BASE = `---
title: 과제 A
진척: 0.42
상태: Not started
마감: 2026-10-01
설명: 굵은 글과 링크
태그:
  - a
  - b
생성일: '2026-09-26T13:52:00.000Z'
첨부: '[[attachments/spec.pdf]]'
cover: '[[attachments/cover.png]]'
---
## 행 본문 제목

본문 한 줄.
`;

// BASE 를 pull 했을 때의 Notion 속성(원본 응답 모양).
const REMOTE_PROPS = {
  이름: { type: "title", title: [{ plain_text: "과제 A" }] },
  진척: { type: "number", number: 0.42 },
  상태: { type: "status", status: { name: "Not started" } },
  마감: { type: "date", date: { start: "2026-10-01", end: null } },
  설명: { type: "rich_text", rich_text: [{ plain_text: "굵은 글과 링크" }] },
  태그: { type: "multi_select", multi_select: [{ name: "a" }, { name: "b" }] },
  생성일: { type: "created_time", created_time: "2026-09-26T13:52:00.000Z" },
  첨부: {
    type: "files",
    files: [{ name: "spec.pdf", type: "file", file: { url: "https://s3.example/spec.pdf?sig=1" } }],
  },
};

function rowRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "rec-row",
    obsidianPath: ROW_PATH,
    notionPageId: ROW_ID,
    notionParentId: DB_ID,
    contentHash: computeHash(BASE),
    notionLastEdited: SYNCED_AT,
    localLastModified: "2026-09-26T13:58:00.000Z",
    syncDirection: "both",
    fileType: "db-row",
    status: "synced",
    baseSnapshot: Buffer.from(BASE, "utf-8"),
    localMtime: "2020-01-01T00:00:00.000Z",
    localFileSize: 1,
    ...overrides,
  };
}

describe("S-01 · S-02 DB 행 push — 속성은 속성으로, 바뀐 것만", () => {
  let vaultFs: ReturnType<typeof createMockVaultFs>;
  let stateDb: ReturnType<typeof createMockStateDb>;
  let notion: ReturnType<typeof createMockNotionClient>;
  let files: Map<string, string>;
  let records: Map<string, ReturnType<typeof rowRecord>>;
  /** 원격 행의 지금 모습 — 보내면 바뀐다. 기본은 지난 동기화 그대로(시각 = 레코드 값). */
  let remote: Map<string, { lastEdited: string; title: string; properties: object }>;

  const build = (config: Config = createConfig()) =>
    new SyncOrchestrator(config, stateDb as never, notion as never, vaultFs);

  beforeEach(() => {
    setLogger({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    vaultFs = createMockVaultFs();
    stateDb = createMockStateDb();
    notion = createMockNotionClient();
    files = new Map();
    records = new Map([[ROW_PATH, rowRecord()]]);

    (vaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      [...files.keys()].map((path) => ({ path, mtime: new Date().toISOString(), size: 100 })),
    );
    (vaultFs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT ${path}`);
      return content;
    });
    stateDb.getByPath.mockImplementation((path: string) => records.get(path) ?? null);
    stateDb.getByStatus.mockImplementation((status: string) =>
      [...records.values()].filter((r) => r.status === status),
    );
    // 해소 · 동기화가 레코드의 사본을 바꾸는 것까지 흉내 낸다 — 충돌 해소 뒤 사본이
    // 해소 결과와 같아지는 것이 행 push 의 비교 기준에 영향을 주기 때문이다.
    stateDb.updateHash.mockImplementation((id: string, hash: string, snapshot: Buffer) => {
      for (const r of records.values()) {
        if (r.id === id) Object.assign(r, { contentHash: hash, baseSnapshot: snapshot });
      }
    });
    stateDb.setNotionLastEdited.mockImplementation((id: string, at: string) => {
      for (const r of records.values()) if (r.id === id) r.notionLastEdited = at;
    });

    remote = new Map([
      [ROW_ID, { lastEdited: SYNCED_AT, title: "과제 A", properties: REMOTE_PROPS }],
    ]);
    notion.getDatabaseSchema.mockResolvedValue(SCHEMA);
    notion.getPage.mockImplementation(async (id: string) => {
      const row = remote.get(id);
      return {
        id,
        last_edited_time: row?.lastEdited ?? SYNCED_AT,
        properties: row?.properties ?? {},
        __title: row?.title,
      };
    });
    notion.extractTitle.mockImplementation((page: { __title?: string }) => page.__title ?? "");
    notion.updatePageProperties.mockImplementation(async (id: string) => {
      const row = remote.get(id);
      if (row) row.lastEdited = PROPS_AT;
      return { id, last_edited_time: PROPS_AT };
    });
    notion.replacePageMarkdown.mockImplementation(async (id: string) => {
      const row = remote.get(id);
      if (row) row.lastEdited = BODY_AT;
      return { markdown: "", truncated: false, unknown_block_ids: [] };
    });
  });

  it("속성 하나를 고치면 그 속성만 DB 속성으로 보내고 본문은 건드리지 않는다", async () => {
    files.set(ROW_PATH, BASE.replace("진척: 0.42", "진척: 0.5"));

    const result = await build().push();

    expect(result.failed).toEqual([]);
    expect(result.updated).toBe(1);
    expect(notion.getDatabaseSchema).toHaveBeenCalledWith(DB_ID);
    expect(notion.updatePageProperties).toHaveBeenCalledTimes(1);
    expect(notion.updatePageProperties).toHaveBeenCalledWith(ROW_ID, { 진척: { number: 0.5 } });
    expect(notion.replacePageMarkdown).not.toHaveBeenCalled();
    expect(stateDb.setNotionLastEdited).toHaveBeenCalledWith("rec-row", PROPS_AT);
    expect(stateDb.updateStatus).toHaveBeenCalledWith("rec-row", "synced");
  });

  it("본문을 고치면 본문만 보내고, 본문에 속성 YAML 을 끼우지 않는다", async () => {
    files.set(ROW_PATH, BASE.replace("본문 한 줄.", "본문 두 줄."));

    const result = await build().push();

    expect(result.failed).toEqual([]);
    expect(notion.replacePageMarkdown).toHaveBeenCalledTimes(1);
    const [pageId, markdown] = notion.replacePageMarkdown.mock.calls[0]!;
    expect(pageId).toBe(ROW_ID);
    expect(markdown).toContain("본문 두 줄.");
    expect(markdown).not.toContain("im-nobsidian:properties");
    expect(markdown).not.toContain("```yaml");
    expect(markdown).not.toContain("진척");
    expect(notion.updatePageProperties).not.toHaveBeenCalled();
    // 속성을 보내지 않았으니 서버 시각은 본문을 보낸 뒤 getPage 로 받는다.
    expect(stateDb.setNotionLastEdited).toHaveBeenCalledWith("rec-row", BODY_AT);
  });

  it("지운 속성은 그 타입의 빈 값으로 비운다 — status 와 files 는 비우지 않는다", async () => {
    files.set(
      ROW_PATH,
      BASE.replace("설명: 굵은 글과 링크\n", "")
        .replace("상태: Not started\n", "상태:\n")
        .replace("첨부: '[[attachments/spec.pdf]]'\n", "")
        .replace("태그:\n  - a\n  - b\n", "태그: []\n"),
    );

    await build().push();

    expect(notion.updatePageProperties).toHaveBeenCalledWith(ROW_ID, {
      설명: { rich_text: [] },
      태그: { multi_select: [] },
    });
  });

  it("날짜는 따옴표 유무가 달라도 같은 값이고, 바꾸면 날짜 속성으로 간다", async () => {
    files.set(ROW_PATH, BASE.replace("마감: 2026-10-01", "마감: '2026-10-01'"));
    await build().push();
    expect(notion.updatePageProperties).not.toHaveBeenCalled();

    files.set(ROW_PATH, BASE.replace("마감: 2026-10-01", "마감: 2026-10-05"));
    await build().push();
    expect(notion.updatePageProperties).toHaveBeenCalledWith(ROW_ID, {
      마감: { date: { start: "2026-10-05", end: null } },
    });
  });

  it("frontmatter 제목을 바꾸면 제목만 보낸다 — 파일 이름은 제목이 아니다", async () => {
    files.set(ROW_PATH, BASE.replace("title: 과제 A", "title: 과제 A/B 통합"));

    await build().push();

    expect(notion.updatePageProperties).toHaveBeenCalledWith(ROW_ID, {
      title: { title: [{ text: { content: "과제 A/B 통합" } }] },
    });
  });

  it("DB 에 없는 키(cover)만 바뀌면 Notion 에 아무것도 보내지 않고 동기화 완료로 적는다", async () => {
    files.set(ROW_PATH, BASE.replace("cover.png", "cover2.png"));

    const result = await build().push();

    expect(result.failed).toEqual([]);
    expect(notion.updatePageProperties).not.toHaveBeenCalled();
    expect(notion.replacePageMarkdown).not.toHaveBeenCalled();
    expect(stateDb.updateHash).toHaveBeenCalledWith(
      "rec-row",
      computeHash(files.get(ROW_PATH)!),
      expect.any(Buffer),
    );
    expect(stateDb.setNotionLastEdited).not.toHaveBeenCalled();
  });

  it("frontmatter 가 깨졌으면 보내지 않고 실패로 남긴다 — 모든 속성을 지우는 요청이 되지 않게", async () => {
    files.set(ROW_PATH, BASE.replace("진척: 0.42", "진척: [0.5"));

    const result = await build().push();

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.path).toBe(ROW_PATH);
    expect(result.failed[0]!.error).toContain("frontmatter");
    expect(notion.updatePageProperties).not.toHaveBeenCalled();
    expect(notion.replacePageMarkdown).not.toHaveBeenCalled();
    expect(stateDb.updateHash).not.toHaveBeenCalled();
  });

  it("소속 DB 를 모르는 행은 페이지로 밀지 않고 실패로 남긴다", async () => {
    records.set(ROW_PATH, rowRecord({ notionParentId: null }));
    files.set(ROW_PATH, BASE.replace("본문 한 줄.", "본문 두 줄."));

    const result = await build().push();

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.error).toContain("소속 DB");
    expect(notion.replacePageMarkdown).not.toHaveBeenCalled();
  });

  it("지난 동기화 사본이 없으면 비어 있지 않은 속성을 보내되 지우지는 않는다", async () => {
    records.set(ROW_PATH, rowRecord({ baseSnapshot: null }));
    files.set(ROW_PATH, BASE.replace("설명: 굵은 글과 링크\n", ""));

    await build().push();

    const [, props] = notion.updatePageProperties.mock.calls[0]!;
    expect(props).toEqual({
      title: { title: [{ text: { content: "과제 A" } }] },
      진척: { number: 0.42 },
      상태: { status: { name: "Not started" } },
      마감: { date: { start: "2026-10-01", end: null } },
      태그: { multi_select: [{ name: "a" }, { name: "b" }] },
    });
  });

  it("서로 다른 DB 의 행은 각자의 스키마로 변환한다 — 같은 실행에서 동시에 밀어도", async () => {
    const otherPath = "Projects/회고/회고 1.md";
    const otherBase = "---\ntitle: 회고 1\n진척: 높음\n---\n본문\n";
    records.set(
      otherPath,
      rowRecord({
        id: "rec-other",
        obsidianPath: otherPath,
        notionPageId: "row-other",
        notionParentId: "db-retro",
        contentHash: computeHash(otherBase),
        baseSnapshot: Buffer.from(otherBase, "utf-8"),
      }),
    );
    remote.set("row-other", { lastEdited: SYNCED_AT, title: "회고 1", properties: {} });
    notion.getDatabaseSchema.mockImplementation(async (id: string) =>
      id === "db-retro" ? { 진척: { id: "q1", type: "select" } } : SCHEMA,
    );
    files.set(ROW_PATH, BASE.replace("진척: 0.42", "진척: 0.5"));
    files.set(otherPath, otherBase.replace("진척: 높음", "진척: 낮음"));

    await build().push();

    expect(notion.updatePageProperties).toHaveBeenCalledWith(ROW_ID, { 진척: { number: 0.5 } });
    expect(notion.updatePageProperties).toHaveBeenCalledWith("row-other", {
      진척: { select: { name: "낮음" } },
    });
    expect(notion.getDatabaseSchema).toHaveBeenCalledTimes(2);
  });

  it("Notion 에서도 바뀐 행이면 로컬에서 바꾼 것만 보내고, 시각을 올리지 않아 다음 pull 이 받게 한다", async () => {
    remote.get(ROW_ID)!.lastEdited = "2026-09-26T20:00:00.000Z"; // 누군가 Notion 에서 고침
    files.set(ROW_PATH, BASE.replace("진척: 0.42", "진척: 0.5"));

    const result = await build().push();

    expect(result.failed).toEqual([]);
    expect(notion.updatePageProperties).toHaveBeenCalledWith(ROW_ID, { 진척: { number: 0.5 } });
    expect(stateDb.setNotionLastEdited).not.toHaveBeenCalled();
    expect(records.get(ROW_PATH)!.notionLastEdited).toBe(SYNCED_AT);
  });

  it("충돌을 «로컬» 로 해소하면 원격과 다른 속성을 모두 보내고 본문도 보낸다", async () => {
    // 로컬: 진척 0.5 로 고침 · 원격: 상태를 Done 으로, 설명을 지움 — 둘 다 지난 동기화 뒤
    const local = BASE.replace("진척: 0.42", "진척: 0.5");
    files.set(ROW_PATH, local);
    records.set(ROW_PATH, rowRecord({ status: "conflict" }));
    remote.set(ROW_ID, {
      lastEdited: "2026-09-26T20:00:00.000Z",
      title: "과제 A",
      properties: {
        ...REMOTE_PROPS,
        상태: { type: "status", status: { name: "Done" } },
        설명: { type: "rich_text", rich_text: [] },
      },
    });
    const conflict = {
      syncRecord: records.get(ROW_PATH)!,
      localChange: { path: ROW_PATH, type: "modified" as const, hash: computeHash(local) },
      remoteChange: {
        pageId: ROW_ID,
        type: "modified" as const,
        lastEdited: "2026-09-26T20:00:00.000Z",
        previousEdited: SYNCED_AT,
      },
      baseContent: BASE,
      localContent: local,
      remoteContent: "(원격 렌더)",
    };

    await build().resolveConflict(conflict as never, "local");

    // 해소가 사본을 로컬로 바꿔 두어도(updateHash), 원격과 견줘 보낸다.
    expect(notion.updatePageProperties).toHaveBeenCalledWith(ROW_ID, {
      진척: { number: 0.5 },
      상태: { status: { name: "Not started" } },
      설명: { rich_text: [{ text: { content: "굵은 글과 링크" } }] },
    });
    expect(notion.replacePageMarkdown).toHaveBeenCalledTimes(1);
    expect(records.get(ROW_PATH)!.notionLastEdited).toBe(PROPS_AT);
  });

  it("DB 모드 볼트의 노트도 행이다 — 설정의 DB 스키마로 바뀐 속성만 보낸다", async () => {
    const config = createConfig();
    config.notion = { ...config.notion, parentMode: "database", databaseId: "db-root" };
    records.set(ROW_PATH, rowRecord({ fileType: "file", notionParentId: "folder-page" }));
    files.set(ROW_PATH, BASE.replace("진척: 0.42", "진척: 0.5"));

    await build(config).push();

    expect(notion.getDatabaseSchema).toHaveBeenCalledWith("db-root");
    expect(notion.updatePageProperties).toHaveBeenCalledWith(ROW_ID, { 진척: { number: 0.5 } });
    expect(notion.replacePageMarkdown).not.toHaveBeenCalled();
  });

  it("원격 미리보기 · 충돌 비교도 행을 pull 과 같은 행 모양으로 렌더한다", async () => {
    notion.getPageMarkdown.mockResolvedValue({
      markdown:
        "```yaml\n# im-nobsidian:properties\n진척: 0.5\n```\n\n---\n\n## 행 본문 제목\n\n본문 한 줄.\n",
      truncated: false,
      unknown_block_ids: [],
    });

    const rendered = await build().renderRemoteSnapshot(ROW_PATH);

    expect(rendered).toContain("title: 과제 A");
    expect(rendered).toContain("진척: 0.42");
    expect(rendered).toContain("상태: Not started");
    expect(rendered).not.toContain("0.5");
    expect(rendered).not.toContain("im-nobsidian:properties");
    expect(rendered).toContain("## 행 본문 제목");
  });

  it("페이지(행이 아님)는 예전대로 frontmatter 를 본문 첫머리 YAML 로 보낸다", async () => {
    const pagePath = "노트.md";
    const pageBase = "---\n태그: 메모\n---\n본문\n";
    records.clear();
    records.set(
      pagePath,
      rowRecord({
        id: "rec-page",
        obsidianPath: pagePath,
        notionPageId: "page-1",
        notionParentId: "root-page-id",
        fileType: "file",
        contentHash: computeHash(pageBase),
        baseSnapshot: Buffer.from(pageBase, "utf-8"),
      }),
    );
    files.set(pagePath, pageBase.replace("본문", "본문 수정"));

    await build().push();

    expect(notion.getDatabaseSchema).not.toHaveBeenCalled();
    const [, markdown] = notion.replacePageMarkdown.mock.calls[0]!;
    expect(markdown).toContain("im-nobsidian:properties");
    expect(markdown).toContain("태그: 메모");
  });
});

describe("S-02 pull — 행 본문 첫머리의 속성 블록은 값으로 쓰지 않고 걷어 낸다", () => {
  const pipeline = createDefaultPipeline({ wikilinkResolver: () => null });
  const polluted =
    "```yaml\n# im-nobsidian:properties\n진척: 0.5\n상태: Not started\n```\n\n---\n\n## 행 본문 제목\n";

  it("DB 행: 블록을 빼고 Notion 속성 값을 그대로 둔다", () => {
    const out = pipeline.convertToMarkdown(
      polluted,
      { direction: "pull", path: "markdown-api", filePath: ROW_PATH, parentMode: "database" },
      { properties: { title: "과제 A", 진척: 0.42 } },
    );

    expect(out).toContain("진척: 0.42");
    expect(out).not.toContain("0.5");
    expect(out).not.toContain("im-nobsidian:properties");
    expect(out).toContain("## 행 본문 제목");
  });

  it("페이지: 예전대로 블록 값을 frontmatter 로 되살린다", () => {
    const out = pipeline.convertToMarkdown(
      polluted,
      { direction: "pull", path: "markdown-api", filePath: "노트.md", parentMode: "page" },
      { properties: {} },
    );

    expect(out).toContain("진척: 0.5");
    expect(out).not.toContain("im-nobsidian:properties");
  });
});
