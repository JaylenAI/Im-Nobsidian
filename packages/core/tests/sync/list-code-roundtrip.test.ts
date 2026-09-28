/**
 * S-24 — 목록 안 코드블록이 push · pull 을 거쳐 목록 안에 남는지 끝까지 돌린다.
 *
 * Notion 은 목록 항목의 자식 코드블록을 경계 펜스만 탭으로 들여쓰고 코드 줄은 열 0 에 둔 채
 * 내보낸다(실측). 그대로 쓰면 Obsidian 은 열 0 의 코드 줄에서 목록을 끝내, 목록 안에는 빈
 * 코드블록이 · 목록 밖에는 코드가 문단으로 보였다. 이제 pull 은 코드 줄을 펜스 깊이로 맞추고
 * 목록 줄처럼 4칸으로 편다 — 노트에 4칸으로 쓴 목록 코드가 그대로 돌아온다.
 *
 * 실제 StateDB(임시 파일) · 메모리 볼트 · 메모리 Notion 으로, 처음 push 가 만든 레코드를 그대로
 * 이어 쓴다(code-language-roundtrip 과 같은 하니스).
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

/** Obsidian 에서 쓴 노트 — 목록 줄 · 펜스 · 코드 줄 모두 4칸. */
const NOTE = [
  "앞 문단",
  "",
  "- 설치",
  "    ```bash",
  "    npm install",
  "    ```",
  "- 설정",
  "    - 중첩",
  "        ```json",
  '        { "strict": true }',
  "        ```",
  "1. 번호",
  "    ```python",
  "    def f():",
  "        return 1",
  "    ```",
  "",
  "뒤 문단",
  "",
].join("\n");

/** 같은 노트를 Notion 이 내보내는 모양 — 경계 펜스만 탭, 코드 줄은 열 0, 블록 사이 빈 줄 없음(실측). */
const NOTION_EXPORT = [
  "앞 문단",
  "- 설치",
  "\t```bash",
  "npm install",
  "\t```",
  "- 설정",
  "\t- 중첩",
  "\t\t```json",
  '{ "strict": true }',
  "\t\t```",
  "1. 번호",
  "\t```python",
  "def f():",
  "    return 1",
  "\t```",
  "뒤 문단",
].join("\n");

describe("목록 안 코드블록 왕복(S-24)", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  const build = (config: Config): SyncOrchestrator =>
    new SyncOrchestrator(config, db, notion.client as never, vault.fs());

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-list-code-"));
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

    it("올리는 본문은 4칸 목록 · 4칸 펜스 그대로다 — Notion 이 같은 구조로 읽는 모양(실측)", () => {
      expect(body().trimEnd()).toBe(NOTE.trimEnd());
    });

    it("Notion 이 내보낸 모양으로 받아도 코드는 목록 안에 남는다", async () => {
      notion.edit(pageId, (page) => {
        page.body = NOTION_EXPORT.replace("뒤 문단", "뒤 문단 — Notion 에서 고침");
      });

      expect(await orchestrator.pull()).toMatchObject({ updated: 1, failed: [] });

      expect(note("Note.md")).toBe(NOTE.replace("뒤 문단", "뒤 문단 — Notion 에서 고침").trimEnd());
    });

    it("Notion 에서 목록 안 코드를 고쳐도 목록 안에 받는다", async () => {
      notion.edit(pageId, (page) => {
        page.body = NOTION_EXPORT.replace("npm install", "npm ci");
      });

      await orchestrator.pull();

      expect(note("Note.md")).toBe(NOTE.replace("npm install", "npm ci").trimEnd());
    });

    it("받은 노트를 고쳐 올려도 목록 안 코드는 4칸 구조로 간다", async () => {
      notion.edit(pageId, (page) => {
        page.body = NOTION_EXPORT;
      });
      await orchestrator.pull();
      vault.write("Note.md", `${note("Note.md")!.replace("앞 문단", "앞 문단 — 로컬에서 고침")}\n`);

      expect(await orchestrator.push()).toMatchObject({ updated: 1, failed: [] });

      expect(body().trimEnd()).toBe(NOTE.replace("앞 문단", "앞 문단 — 로컬에서 고침").trimEnd());
    });

    it("받은 노트를 다시 올려도 Notion 본문은 그대로다", async () => {
      notion.edit(pageId, (page) => {
        page.body = NOTION_EXPORT;
      });
      await orchestrator.pull();
      notion.client.replacePageMarkdown.mockClear();

      expect(await orchestrator.push()).toMatchObject({ created: 0, updated: 0, failed: [] });

      expect(notion.client.replacePageMarkdown).not.toHaveBeenCalled();
      expect(body()).toBe(NOTION_EXPORT);
    });
  });

  describe("설정 DB 의 행", () => {
    let orchestrator: SyncOrchestrator;
    let rowId: string;
    // 압축 export 를 받으면 프론트매터 뒤에 빈 줄 하나가 선다(BlockSpacer) — 그 정본 모양으로 쓴다.
    const ROW = `---\ntitle: Row\n---\n\n${NOTE}`;

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

    it("Notion 이 내보낸 모양으로 받아도 코드는 목록 안에 남는다", async () => {
      notion.edit(rowId, (page) => {
        page.body = NOTION_EXPORT.replace("뒤 문단", "뒤 문단 — Notion 에서 고침");
      });

      const pulled = await orchestrator.pull();

      expect(pulled.failed).toEqual([]);
      expect(note("Tasks/Row.md")).toBe(
        ROW.replace("뒤 문단", "뒤 문단 — Notion 에서 고침").trimEnd(),
      );
    });
  });
});
