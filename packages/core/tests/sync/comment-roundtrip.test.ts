/**
 * S-29 — 주석이 push · pull 을 거쳐 노트에 적힌 자리 그대로 돌아오는지 끝까지 돌린다.
 *
 * 주석은 Notion 에 올리지 않는 로컬 글이다(F26). 예전에는 push 때 남긴 마커의 앵커 줄 다음 줄에 끼워,
 * 원격 편집 뒤에 받으면 문장 속 주석이 줄 밖으로 빠지고 콜아웃 속 주석이 `>` 없이 들어가 콜아웃을
 * 끊었다. 이제 pull 은 받기 직전의 로컬 노트에서 되살린다.
 *
 * 실제 StateDB(임시 파일) · 메모리 볼트 · 메모리 Notion 으로, 처음 push 가 만든 레코드를 그대로 이어
 * 쓴다(code-language-roundtrip 과 같은 하니스).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { Config } from "../../src/types/config.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DB_ID = "db000000-0000-4000-8000-0000000000c2";

/** 문장 속 · 제 문단 · 콜아웃 속 · 목록 속 · 여러 줄 HTML 주석. */
const NOTE = [
  "첫 문단 %%문장 속 메모%% 이어서.",
  "",
  "%%제 문단 메모%%",
  "",
  "> [!note] 콜아웃",
  "> 본문 줄입니다.",
  "> %%콜아웃 메모%%",
  "> 끝 줄입니다.",
  "",
  "- 항목 하나",
  "- 항목 <!-- 목록 메모 --> 둘",
  "",
  "뒤 문단",
  "",
  "<!--",
  "여러 줄 메모",
  "-->",
  "",
].join("\n");

const COMMENT_TEXTS = ["문장 속 메모", "제 문단 메모", "콜아웃 메모", "목록 메모", "여러 줄 메모"];

describe("주석 왕복(S-29)", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  const build = (config: Config): SyncOrchestrator =>
    new SyncOrchestrator(config, db, notion.client as never, vault.fs());

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-comment-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  /** 받은 노트 — 끝 줄바꿈은 메모리 Notion 이 본문을 저장하는 방식의 차이라 보지 않는다. */
  const note = (path: string): string | undefined => vault.read(path)?.trimEnd();

  describe("페이지", () => {
    let orchestrator: SyncOrchestrator;
    let pageId: string;

    beforeEach(async () => {
      orchestrator = build(
        createConfig({
          notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases: [] },
          advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
        }),
      );
      vault.write("Note.md", NOTE);
      expect(await orchestrator.push()).toMatchObject({ created: 1, failed: [] });
      pageId = db.getByPath("Note.md")!.notionPageId!;
    });

    const body = (): string => notion.pages.get(pageId)!.body;

    it("Notion 에는 주석이 올라가지 않는다 — 빈 블록 · 홀로 남은 `>` 도 없이", () => {
      for (const text of COMMENT_TEXTS) expect(body()).not.toContain(text);
      expect(body()).not.toMatch(/%%|<!--|^\s*>\s*$/m);
    });

    it("Notion 에서 다른 문단을 고쳐 받아도 주석은 제자리다", async () => {
      notion.edit(pageId, (page) => {
        page.body = page.body.replace("뒤 문단", "뒤 문단 — Notion 에서 고침");
      });

      expect(await orchestrator.pull()).toMatchObject({ updated: 1, failed: [] });

      expect(note("Note.md")).toBe(NOTE.replace("뒤 문단", "뒤 문단 — Notion 에서 고침").trimEnd());
    });

    it("Notion 에서 주석이 있는 문장을 고쳐도 주석은 그 문장의 같은 글 뒤에 남는다", async () => {
      notion.edit(pageId, (page) => {
        page.body = page.body.replace("첫 문단 이어서.", "첫 문단 고쳐서 이어서.");
      });

      await orchestrator.pull();

      expect(note("Note.md")).toBe(
        NOTE.replace(
          "첫 문단 %%문장 속 메모%% 이어서.",
          "첫 문단 %%문장 속 메모%% 고쳐서 이어서.",
        ).trimEnd(),
      );
    });

    it("Notion 에서 콜아웃 줄을 고쳐도 주석은 `>` 와 함께 콜아웃 안에 남는다", async () => {
      notion.edit(pageId, (page) => {
        page.body = page.body.replace("본문 줄입니다.", "본문 줄 고침.");
      });

      await orchestrator.pull();

      expect(note("Note.md")).toBe(NOTE.replace("본문 줄입니다.", "본문 줄 고침.").trimEnd());
    });

    it("Notion 에서 주석이 있던 목록 항목을 지우면 주석만 그 자리에 남는다", async () => {
      expect(body()).toContain("- 항목 둘\n");
      notion.edit(pageId, (page) => {
        page.body = page.body.replace("- 항목 둘\n", "");
      });

      expect(await orchestrator.pull()).toMatchObject({ updated: 1, failed: [] });

      expect(note("Note.md")).toBe(
        NOTE.replace("- 항목 <!-- 목록 메모 --> 둘\n", "<!-- 목록 메모 -->\n").trimEnd(),
      );
    });

    it("받은 노트를 다시 올려도 Notion 본문은 그대로다", async () => {
      notion.edit(pageId, (page) => {
        page.body = page.body.replace("본문 줄입니다.", "본문 줄 고침.");
      });
      await orchestrator.pull();
      const pulled = body();
      notion.client.replacePageMarkdown.mockClear();

      expect(await orchestrator.push()).toMatchObject({ created: 0, updated: 0, failed: [] });

      expect(notion.client.replacePageMarkdown).not.toHaveBeenCalled();
      expect(body()).toBe(pulled);
    });
  });

  describe("설정 DB 의 행", () => {
    let orchestrator: SyncOrchestrator;
    let rowId: string;
    const ROW = `---\ntitle: Row\n---\n${NOTE}`;

    beforeEach(async () => {
      notion.client.getDatabaseSchema.mockResolvedValue({ Name: { id: "title", type: "title" } });
      notion.client.getDatabaseViewsConfig.mockResolvedValue({
        databaseId: DB_ID,
        lastSynced: "",
        views: [],
      });
      orchestrator = build(
        createConfig({
          notion: {
            token: "ntn_test_token",
            rootPageId: "root-page-id",
            databases: [{ databaseId: DB_ID, localFolder: "Tasks", titleProperty: "Name" }],
          },
          advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
        }),
      );
      vault.write("Tasks/Row.md", ROW);
      expect(await orchestrator.push()).toMatchObject({ created: 1, failed: [] });
      rowId = db.getByPath("Tasks/Row.md")!.notionPageId!;
    });

    it("Notion 에서 글을 고쳐 받아도 주석은 제자리다", async () => {
      for (const text of COMMENT_TEXTS) expect(notion.pages.get(rowId)!.body).not.toContain(text);
      notion.edit(rowId, (page) => {
        page.body = page.body.replace("본문 줄입니다.", "본문 줄 고침.");
      });

      const pulled = await orchestrator.pull();

      expect(pulled.failed).toEqual([]);
      expect(note("Tasks/Row.md")).toBe(ROW.replace("본문 줄입니다.", "본문 줄 고침.").trimEnd());
    });
  });
});
