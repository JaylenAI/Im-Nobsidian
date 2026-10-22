/**
 * N-05 — 우리가 본 뒤 같은 분 안에 Notion 에서 고친 것.
 *
 * Notion 은 `last_edited_time` 을 분 단위로 자른다(실측). 예전에는 수정 시각이 같은지만 봐서,
 * 우리가 본 뒤 같은 분 안에 고친 페이지를 pull 이 받지 않았고(`--force` 도), 그 노트를 고쳐
 * push 하면 원격을 보지 않고 Notion 의 편집을 덮어썼다. DB 행도 원격이 바뀐 것을 알면서 본문을
 * 통째로 바꿨다.
 *
 * 이제 편집자 · 본 때를 함께 적고, 그래도 가를 수 없으면(«확인 안 됨») 내용으로 확인한다 —
 * 본문은 지문으로, 본문 밖(제목 · 행 속성 · 아이콘)은 지난 동기화 사본과 견준다.
 *
 * 실제 StateDB(임시 파일) · 메모리 볼트 · 메모리 Notion 으로 끝까지 돌린다. 메모리 Notion 은
 * 수정 시각을 이 기기 시계로 적고 분 단위로 자른다 — 시험이 시계를 정한다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { parseFrontmatter } from "../../src/utils/frontmatter.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { Config } from "../../src/types/config.js";
import { createConfig, MOCK_BOT_USER_ID } from "../helpers/mock-orchestrator.js";
import {
  HUMAN_USER_ID,
  MemoryVault,
  memoryNotion,
  type MemoryPage,
} from "../helpers/memory-sync.js";

const DAY = "2026-09-02";
const ROW_DB_ID = "db000000-0000-4000-8000-0000000000d5";

/** 이 기기 시계를 `DAY` 의 그 시각으로 — 메모리 Notion 의 수정 시각도 이 시계를 따른다. */
function at(hms: string): void {
  vi.setSystemTime(new Date(`${DAY}T${hms}.000Z`));
}

const REFUSED_CHANGED = "Notion 에서도 본문이 바뀐 페이지라 올리지 않음";

function withSync(sync: Partial<Config["sync"]>): Config {
  return createConfig({
    sync: { ...DEFAULT_CONFIG.sync, ...sync },
    advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
  });
}

describe("같은 분 안의 Notion 편집 (N-05)", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  const build = (config = withSync({})): SyncOrchestrator =>
    new SyncOrchestrator(config, db, notion.client as never, vault.fs());

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00:05");
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-sameminute-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion({ minuteClock: true, bumpParentOnCreate: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const pageIdOf = (path: string): string => db.getByPath(path)!.notionPageId!;
  const bodyOf = (path: string): string => notion.pages.get(pageIdOf(path))!.body;

  /**
   * 10:00:05 에 올린 노트를 사람이 10:00:10 에 고치고 10:00:20 에 받는다. 레코드는 «사람이 마지막
   * 편집자 · 10:00:20 에 봄» — 이 분이 가라앉기 전(10:02:00)에는 수정 시각 · 편집자로 가를 수 없다.
   */
  async function pulledAfterHumanEdit(orchestrator: SyncOrchestrator): Promise<string> {
    vault.write("Note.md", "원본\n");
    expect(await orchestrator.push()).toMatchObject({ created: 1, failed: [] });
    const pageId = pageIdOf("Note.md");

    at("10:00:10");
    notion.edit(pageId, (page) => {
      page.body = "원본\n\n사람이 더한 첫 문단";
    });
    at("10:00:20");
    expect(await orchestrator.pull()).toMatchObject({ updated: 1, failed: [] });
    expect(vault.read("Note.md")).toContain("사람이 더한 첫 문단");
    expect(db.getByPath("Note.md")).toMatchObject({
      notionLastEdited: `${DAY}T10:00:00.000Z`,
      notionLastEditedBy: HUMAN_USER_ID,
      notionSeenAt: `${DAY}T10:00:20.000Z`,
    });
    return pageId;
  }

  describe("pull", () => {
    it("우리가 쓴 뒤 같은 분 안에 사람이 고친 페이지를 받는다 — 편집자가 바뀌었다", async () => {
      const orchestrator = build();
      vault.write("Note.md", "원본\n");
      await orchestrator.push();

      at("10:00:30");
      notion.edit(pageIdOf("Note.md"), (page) => {
        page.body = "원본\n\n같은 분에 더함";
      });
      at("10:00:40");
      const result = await orchestrator.pull();

      expect(result).toMatchObject({ updated: 1, failed: [], conflicts: [] });
      expect(vault.read("Note.md")).toContain("같은 분에 더함");
    });

    it.each([
      ["pull", {}],
      ["pull --force", { force: true }],
    ])(
      "받은 뒤 같은 분 안에 같은 사람이 또 고친 페이지를 내용으로 확인해 받는다 — %s",
      async (_label, options) => {
        const orchestrator = build();
        const pageId = await pulledAfterHumanEdit(orchestrator);

        at("10:00:40");
        notion.edit(pageId, (page) => {
          page.body = `${page.body}\n\n같은 사람이 또 더함`;
        });
        at("10:00:50");
        const result = await orchestrator.pull(options);

        expect(result).toMatchObject({ updated: 1, failed: [], conflicts: [] });
        expect(vault.read("Note.md")).toContain("같은 사람이 또 더함");
      },
    );

    it("확인해 보니 그대로면 쓰지도 세지도 않고, 그 분이 가라앉은 뒤에는 본문을 읽지 않는다", async () => {
      const orchestrator = build();
      await pulledAfterHumanEdit(orchestrator);
      const before = vault.stat("Note.md")!.mtime;

      at("10:03:00");
      notion.client.getPageMarkdown.mockClear();
      const confirmed = await orchestrator.pull();

      expect(confirmed).toMatchObject({ created: 0, updated: 0, failed: [], conflicts: [] });
      expect(notion.client.getPageMarkdown).toHaveBeenCalledTimes(1);
      expect(vault.stat("Note.md")!.mtime).toBe(before);
      expect(db.getByPath("Note.md")!.notionSeenAt).toBe(`${DAY}T10:03:00.000Z`);

      at("10:04:00");
      notion.client.getPageMarkdown.mockClear();
      const settled = await orchestrator.pull();

      expect(settled).toMatchObject({ created: 0, updated: 0, failed: [] });
      expect(notion.client.getPageMarkdown).not.toHaveBeenCalled();
    });

    it("원격이 지난 사본 그대로면 remote-first 여도 로컬 편집을 덮지 않고 다음 push 가 올린다", async () => {
      const orchestrator = build(withSync({ conflictStrategy: "remote-first" }));
      const pageId = await pulledAfterHumanEdit(orchestrator);

      at("10:00:30");
      vault.write("Note.md", `${vault.read("Note.md")}\n로컬에서 더한 문단\n`);
      at("10:00:40");
      const result = await orchestrator.sync();

      expect(result.pull).toMatchObject({ updated: 0, failed: [], conflicts: [] });
      expect(result.push).toMatchObject({ updated: 1, failed: [] });
      expect(vault.read("Note.md")).toContain("로컬에서 더한 문단");
      expect(notion.pages.get(pageId)!.body).toContain("로컬에서 더한 문단");
    });

    it("제목이 바뀐 원격은 받을 것이 있다 — 그 사이 로컬도 고쳤으면 충돌로 보인다", async () => {
      const orchestrator = build();
      const pageId = await pulledAfterHumanEdit(orchestrator);

      at("10:00:30");
      notion.edit(pageId, (page) => {
        page.title = "Notion 에서 바꾼 제목";
      });
      vault.write("Note.md", `${vault.read("Note.md")}\n로컬에서 더함\n`);
      at("10:00:40");
      const result = await orchestrator.pull();

      expect(result.conflicts).toHaveLength(1);
      expect(vault.read("Note.md")).toContain("로컬에서 더함");
    });

    // 예전에는 렌더한 글을 로컬과 글자로 견줘, 편집기가 파일 끝에 둔 개행만 달라도 다시 썼다.
    it("수정 시각 · 편집자만 바뀐 페이지는 다시 받아 봐도 쓰지 않고 본 것만 적는다", async () => {
      const orchestrator = build();
      vault.write("Note.md", "원본\n");
      expect(await orchestrator.push()).toMatchObject({ created: 1, failed: [] });
      const pageId = pageIdOf("Note.md");
      const before = vault.stat("Note.md")!.mtime;

      at("10:05:00");
      notion.edit(pageId, () => {});
      at("10:05:10");
      const result = await orchestrator.pull();

      expect(result).toMatchObject({ updated: 0, failed: [], conflicts: [] });
      expect(vault.read("Note.md")).toBe("원본\n");
      expect(vault.stat("Note.md")!.mtime).toBe(before);
      expect(db.getByPath("Note.md")).toMatchObject({
        notionLastEdited: `${DAY}T10:05:00.000Z`,
        notionLastEditedBy: HUMAN_USER_ID,
      });
    });

    // 예전에는 자식 링크가 더해진 부모 렌더를 원격 변경으로 봐, 그 사이 고친 폴더 노트가 충돌이었다.
    it("이 도구가 만든 자식 페이지로 폴더 노트의 수정 시각이 올라도, 그 사이 로컬 편집을 충돌로 올리지 않고 올린다", async () => {
      const orchestrator = build();
      vault.write("A/A.md", "폴더 노트 본문\n");
      expect(await orchestrator.push()).toMatchObject({ created: 1, failed: [] });
      const folderId = pageIdOf("A/A.md");

      // 다음 분 — 자식을 만들면 Notion 이 부모의 수정 시각을 올리고 부모 본문에 자식 태그가 생긴다
      at("10:01:10");
      vault.write("A/child.md", "자식\n");
      expect(await orchestrator.push()).toMatchObject({ created: 1, failed: [] });

      at("10:01:20");
      vault.write("A/A.md", "폴더 노트 본문\n\n로컬에서 더함\n");
      at("10:01:30");
      const result = await orchestrator.sync();

      expect(result.pull).toMatchObject({ updated: 0, failed: [], conflicts: [] });
      expect(result.push).toMatchObject({ updated: 1, failed: [] });
      expect(notion.pages.get(folderId)!.body).toContain("로컬에서 더함");
      expect(notion.pages.get(pageIdOf("A/child.md"))!.archived).toBe(false);
    });
  });

  describe("status", () => {
    it("확인해 보니 그대로인 페이지는 원격 변경으로 보이지 않고, 같은 분의 편집은 보인다", async () => {
      const orchestrator = build();
      const pageId = await pulledAfterHumanEdit(orchestrator);

      at("10:00:30");
      expect((await orchestrator.status()).remoteChanges).toEqual([]);

      notion.edit(pageId, (page) => {
        page.body = `${page.body}\n\n같은 분에 더함`;
      });
      at("10:00:40");
      const status = await orchestrator.status();

      expect(status.remoteChanges).toEqual([
        expect.objectContaining({ pageId, type: "modified", unverified: true }),
      ]);
    });
  });

  describe("push", () => {
    it("pull 하지 않은 같은 분의 Notion 편집을 덮어쓰지 않는다 — pull 하면 충돌로 보인다", async () => {
      const orchestrator = build();
      const pageId = await pulledAfterHumanEdit(orchestrator);

      at("10:00:30");
      notion.edit(pageId, (page) => {
        page.body = `${page.body}\n\nNotion 에서 더함`;
      });
      vault.write("Note.md", `${vault.read("Note.md")}\n로컬에서 더함\n`);
      at("10:00:40");
      const pushed = await orchestrator.push();

      expect(pushed.updated).toBe(0);
      expect(pushed.failed).toEqual([
        expect.objectContaining({
          path: "Note.md",
          error: expect.stringContaining(REFUSED_CHANGED),
        }),
      ]);
      expect(notion.pages.get(pageId)!.body).toContain("Notion 에서 더함");
      expect(notion.pages.get(pageId)!.body).not.toContain("로컬에서 더함");

      at("10:00:50");
      const pulled = await orchestrator.pull();

      expect(pulled.conflicts).toHaveLength(1);
      expect(vault.read("Note.md")).toContain("로컬에서 더함");
    });

    it("Notion 이 지난번 그대로임을 내용으로 확인하면 올리고 받은 것으로 적는다 — 다음 pull 은 다시 받지 않는다", async () => {
      const orchestrator = build();
      await pulledAfterHumanEdit(orchestrator);

      at("10:00:30");
      vault.write("Note.md", `${vault.read("Note.md")}\n로컬에서 더함\n`);
      at("10:00:40");
      const pushed = await orchestrator.push();

      expect(pushed).toMatchObject({ updated: 1, failed: [] });
      expect(bodyOf("Note.md")).toContain("로컬에서 더함");
      expect(db.getByPath("Note.md")).toMatchObject({
        notionLastEditedBy: MOCK_BOT_USER_ID,
        notionSeenAt: `${DAY}T10:00:40.000Z`,
      });

      at("10:00:50");
      const before = vault.stat("Note.md")!.mtime;
      notion.client.getPageMarkdown.mockClear();
      const pulled = await orchestrator.pull();

      expect(pulled).toMatchObject({ updated: 0, failed: [], conflicts: [] });
      expect(notion.client.getPageMarkdown).not.toHaveBeenCalled();
      expect(vault.stat("Note.md")!.mtime).toBe(before);
    });

    // 예전에는 본문만 견주고 수정 시각을 올리지 않아, 다음 pull 이 방금 올린 본문을 다시 받아
    // 왕복 차이(줄 끝 개행)를 원격 변경으로 봤다 — 그 사이 로컬을 더 고쳤으면 충돌이었다.
    it("같은 분 안에 올린 뒤 로컬을 더 고쳐도 다음 sync 가 충돌로 보지 않고 올린다", async () => {
      const orchestrator = build();
      const pageId = await pulledAfterHumanEdit(orchestrator);

      at("10:00:30");
      vault.write("Note.md", `${vault.read("Note.md")}\n로컬에서 더함\n`);
      at("10:00:40");
      expect(await orchestrator.push()).toMatchObject({ updated: 1, failed: [] });

      at("10:00:45");
      vault.write("Note.md", `${vault.read("Note.md")}\n로컬에서 또 더함\n`);
      at("10:00:50");
      const result = await orchestrator.sync();

      expect(result.pull).toMatchObject({ updated: 0, failed: [], conflicts: [] });
      expect(result.push).toMatchObject({ updated: 1, failed: [] });
      expect(notion.pages.get(pageId)!.body).toContain("로컬에서 또 더함");
    });

    it("같은 분 안에 Notion 에서 제목만 바꿨으면 본문은 올리되 받은 것으로 적지 않는다 — 다음 pull 이 제목을 받는다", async () => {
      const orchestrator = build();
      const pageId = await pulledAfterHumanEdit(orchestrator);

      at("10:00:30");
      notion.edit(pageId, (page) => {
        page.title = "Notion 에서 바꾼 제목";
      });
      vault.write("Note.md", `${vault.read("Note.md")}\n로컬에서 더함\n`);
      at("10:00:40");
      const pushed = await orchestrator.push();

      expect(pushed).toMatchObject({ updated: 1, failed: [] });
      expect(notion.pages.get(pageId)).toMatchObject({ title: "Notion 에서 바꾼 제목" });
      expect(bodyOf("Note.md")).toContain("로컬에서 더함");
      expect(db.getByPath("Note.md")).toMatchObject({
        notionLastEditedBy: HUMAN_USER_ID,
        notionSeenAt: `${DAY}T10:00:20.000Z`,
      });

      at("10:00:50");
      const pulled = await orchestrator.pull();

      expect(pulled).toMatchObject({ updated: 1, failed: [], conflicts: [] });
      expect(vault.read("Note.md")).toContain("Notion 에서 바꾼 제목");
      expect(vault.read("Note.md")).toContain("로컬에서 더함");
    });

    it("폴더 노트 아래에 이 도구가 만든 페이지 때문에 폴더 노트를 거절하지 않는다", async () => {
      const orchestrator = build();
      vault.write("A/A.md", "폴더 노트 본문\n");
      expect(await orchestrator.push()).toMatchObject({ created: 1, failed: [] });
      const folderId = pageIdOf("A/A.md");

      // 다음 분 — 자식을 만들면 Notion 이 부모의 수정 시각을 올리고 부모 본문에 자식 태그가 생긴다
      at("10:01:10");
      vault.write("A/child.md", "자식\n");
      vault.write("A/A.md", "폴더 노트 본문\n\n로컬에서 더함\n");
      const pushed = await orchestrator.push();

      expect(pushed).toMatchObject({ created: 1, updated: 1, failed: [] });
      expect(notion.pages.get(folderId)!.body).toContain("로컬에서 더함");
    });

    it("로컬이 이긴다고 정한 설정(local-first)은 확인하지 않고 올린다", async () => {
      const orchestrator = build(withSync({ conflictStrategy: "local-first" }));
      const pageId = await pulledAfterHumanEdit(orchestrator);

      at("10:00:30");
      notion.edit(pageId, (page) => {
        page.body = `${page.body}\n\nNotion 에서 더함`;
      });
      vault.write("Note.md", "로컬이 이긴다\n");
      at("10:00:40");
      const pushed = await orchestrator.push();

      expect(pushed).toMatchObject({ updated: 1, failed: [] });
      expect(bodyOf("Note.md")).toContain("로컬이 이긴다");
    });
  });

  describe("DB 행", () => {
    const rowConfig = (): Config =>
      createConfig({
        notion: {
          token: "ntn_test_token",
          rootPageId: "root-page-id",
          databases: [{ databaseId: ROW_DB_ID, localFolder: "Tasks", titleProperty: "Name" }],
        },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      });

    beforeEach(() => {
      notion.client.getDatabaseSchema.mockResolvedValue({
        Name: { id: "title", type: "title" },
        Status: { id: "status", type: "select" },
      });
    });

    /** Notion 에서 사람이 만든 행(상태 «할 일»)을 10:00:20 에 받는다. */
    async function pulledRow(orchestrator: SyncOrchestrator): Promise<string> {
      const row = notion.add(ROW_DB_ID, "Task", "행 본문", {
        properties: { Status: { select: { name: "할 일" } } },
      });
      notion.edit(row.id, () => {});
      at("10:00:20");
      expect(await orchestrator.pull()).toMatchObject({ created: 1, failed: [] });
      return row.id;
    }

    it("받은 뒤 같은 분 안에 같은 사람이 고친 행을 받는다", async () => {
      const orchestrator = build(rowConfig());
      const rowId = await pulledRow(orchestrator);
      const path = db.getByNotionId(rowId)!.obsidianPath;

      at("10:00:40");
      notion.edit(rowId, (page) => {
        page.body = "행 본문\n\n같은 분에 더함";
      });
      at("10:00:50");
      const result = await orchestrator.pull();

      expect(result).toMatchObject({ updated: 1, failed: [] });
      expect(vault.read(path)).toContain("같은 분에 더함");
    });

    it("pull 하지 않은 같은 분의 행 본문 편집을 덮어쓰지 않는다", async () => {
      const orchestrator = build(rowConfig());
      const rowId = await pulledRow(orchestrator);
      const path = db.getByNotionId(rowId)!.obsidianPath;

      at("10:00:40");
      notion.edit(rowId, (page) => {
        page.body = "행 본문\n\nNotion 에서 더함";
      });
      vault.write(path, `${vault.read(path)}\n로컬에서 더함\n`);
      at("10:00:50");
      const pushed = await orchestrator.push();

      expect(pushed.failed).toEqual([
        expect.objectContaining({ path, error: expect.stringContaining(REFUSED_CHANGED) }),
      ]);
      expect(notion.pages.get(rowId)!.body).toContain("Notion 에서 더함");
      expect(notion.pages.get(rowId)!.body).not.toContain("로컬에서 더함");
    });

    it("Notion 에서 바뀐 것이 없음을 내용으로 확인한 행은 올리고 받은 것으로 적는다", async () => {
      const orchestrator = build(rowConfig());
      const rowId = await pulledRow(orchestrator);
      const path = db.getByNotionId(rowId)!.obsidianPath;

      at("10:00:40");
      vault.write(path, `${vault.read(path)}\n로컬에서 더함\n`);
      at("10:00:50");
      const pushed = await orchestrator.push();

      expect(pushed).toMatchObject({ updated: 1, failed: [] });
      expect(notion.pages.get(rowId)!.body).toContain("로컬에서 더함");
      expect(db.getByNotionId(rowId)).toMatchObject({
        notionLastEditedBy: MOCK_BOT_USER_ID,
        notionSeenAt: `${DAY}T10:00:50.000Z`,
      });
    });

    it.each([
      [
        "속성",
        (page: MemoryPage) => {
          page.properties.Status = { type: "select", select: { name: "완료" } };
        },
        ["Status", "완료"],
      ],
      [
        "아이콘",
        (page: MemoryPage) => {
          page.icon = { type: "emoji", emoji: "🚀" };
        },
        ["icon", "🚀"],
      ],
    ])(
      "같은 분 안에 Notion 에서 %s만 바꾼 행은 본문을 올리되 받은 것으로 적지 않는다 — 다음 pull 이 받는다",
      async (_label, change, [key, value]) => {
        const orchestrator = build(rowConfig());
        const rowId = await pulledRow(orchestrator);
        const path = db.getByNotionId(rowId)!.obsidianPath;

        at("10:00:40");
        notion.edit(rowId, change);
        vault.write(path, `${vault.read(path)}\n로컬에서 더함\n`);
        at("10:00:50");
        const pushed = await orchestrator.push();

        expect(pushed).toMatchObject({ updated: 1, failed: [] });
        expect(notion.pages.get(rowId)!.body).toContain("로컬에서 더함");
        expect(db.getByNotionId(rowId)).toMatchObject({
          notionLastEditedBy: HUMAN_USER_ID,
          notionSeenAt: `${DAY}T10:00:20.000Z`,
        });

        at("10:00:55");
        const pulled = await orchestrator.pull();

        expect(pulled).toMatchObject({ updated: 1, failed: [], conflicts: [] });
        const note = parseFrontmatter(vault.read(path)!);
        expect(note.data[key]).toBe(value);
        expect(note.body).toContain("로컬에서 더함");
      },
    );

    // 읽기 전용 속성(수식 · 롤업)은 로컬에서 고칠 수 없고 push 가 보내지 않는다 — 그것만 바뀐
    // 행을 원격 변경으로 보면, 그 사이 로컬 편집이 늘 충돌이었다.
    it("Notion 에서 읽기 전용 속성만 바뀐 행은 그 사이 로컬 편집을 충돌로 올리지 않고 올린다", async () => {
      notion.client.getDatabaseSchema.mockResolvedValue({
        Name: { id: "title", type: "title" },
        Status: { id: "status", type: "select" },
        Score: { id: "score", type: "formula" },
      });
      const orchestrator = build(rowConfig());
      const row = notion.add(ROW_DB_ID, "Task", "행 본문", {
        properties: {
          Status: { select: { name: "할 일" } },
          Score: { formula: { type: "number", number: 1 } },
        },
      });
      notion.edit(row.id, () => {});
      at("10:00:20");
      expect(await orchestrator.pull()).toMatchObject({ created: 1, failed: [] });
      const path = db.getByNotionId(row.id)!.obsidianPath;
      expect(parseFrontmatter(vault.read(path)!).data.Score).toBe(1);

      at("10:00:40");
      notion.edit(row.id, (page) => {
        page.properties.Score = { type: "formula", formula: { type: "number", number: 2 } };
      });
      vault.write(path, `${vault.read(path)}\n로컬에서 더함\n`);
      at("10:00:50");
      const result = await orchestrator.sync();

      expect(result.pull).toMatchObject({ failed: [], conflicts: [] });
      expect(result.push).toMatchObject({ updated: 1, failed: [] });
      expect(notion.pages.get(row.id)!.body).toContain("로컬에서 더함");
    });
  });
});
