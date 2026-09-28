/**
 * S-20 — 코드 펜스의 언어 표기가 push · pull 을 거쳐 노트에 적힌 그대로 돌아오는지 끝까지 돌린다.
 *
 * Notion 은 모르는 언어 · 언어 없는 펜스를 javascript 로 저장하고(실측), 아는 별칭은 제 이름으로
 * 바꾼다(`ts` → typescript). 그래서 Dataview 쿼리 펜스가 Notion 에서 JavaScript 로 보이고 칠해졌고,
 * 받으면 노트의 `ts` 가 `typescript` 로 바뀌었다. 이제 push 는 Notion 이름으로 보내고(모르면
 * plain text), pull 은 받기 직전의 로컬 노트에서 원래 표기를 찾아 되돌린다.
 *
 * 실제 StateDB(임시 파일) · 메모리 볼트 · 메모리 Notion 으로, 처음 push 가 만든 레코드를 그대로
 * 이어 쓴다(embedded-media-roundtrip 과 같은 하니스).
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

const DB_ID = "db000000-0000-4000-8000-0000000000c1";

/** 언어 없는 펜스 · Obsidian 플러그인 펜스 · 별칭 · 물결 펜스 — Notion 이 제 이름으로 바꾸는 것들. */
const NOTE = [
  "앞 문단",
  "",
  "```",
  "그냥 글",
  "```",
  "",
  "```dataview",
  'TABLE file.name FROM "notes"',
  "```",
  "",
  "```ts",
  "const x: number = 1;",
  "```",
  "",
  "~~~bash",
  "echo hi",
  "~~~",
  "",
  "뒤 문단",
  "",
].join("\n");

/** Notion 이 저장한 펜스 줄 — 여는 줄만. */
function fenceLines(body: string): string[] {
  return body.split("\n").filter((line) => /^(?:```|~~~)\S/.test(line));
}

describe("코드 펜스 언어 왕복(S-20)", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  const build = (config: Config): SyncOrchestrator =>
    new SyncOrchestrator(config, db, notion.client as never, vault.fs());

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-code-language-"));
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

    it("Notion 에는 Notion 이름으로 올라간다 — 모르는 언어는 plain text", () => {
      expect(fenceLines(body())).toEqual([
        "```plain text",
        "```plain text",
        "```typescript",
        "```bash",
      ]);
    });

    it("Notion 에서 글을 고쳐 받아도 펜스는 노트에 적힌 그대로다", async () => {
      notion.edit(pageId, (page) => {
        page.body = page.body.replace("앞 문단", "앞 문단 — Notion 에서 고침");
      });

      expect(await orchestrator.pull()).toMatchObject({ updated: 1, failed: [] });

      expect(note("Note.md")).toBe(NOTE.replace("앞 문단", "앞 문단 — Notion 에서 고침").trimEnd());
    });

    it("Notion 에서 코드를 고쳐도 원래 언어 표기로 받는다", async () => {
      notion.edit(pageId, (page) => {
        page.body = page.body.replace('FROM "notes"', 'FROM "archive"');
      });

      await orchestrator.pull();

      expect(note("Note.md")).toBe(NOTE.replace('FROM "notes"', 'FROM "archive"').trimEnd());
    });

    it("Notion 에서 언어를 바꾸면 그 언어를 받는다", async () => {
      notion.edit(pageId, (page) => {
        page.body = page.body.replace("```typescript", "```python");
      });

      await orchestrator.pull();

      expect(note("Note.md")).toBe(NOTE.replace("```ts", "```python").trimEnd());
    });

    it("이 버전 전에 올린 페이지 — Notion 이 javascript 로 저장한 펜스도 노트 표기로 돌아온다", async () => {
      // 예전 push 는 정보 문자열을 그대로 보냈고, Notion 은 모르는 것을 javascript 로 저장했다.
      notion.edit(pageId, (page) => {
        page.body = page.body
          .replaceAll("```plain text", "```javascript")
          .replace("뒤 문단", "뒤 문단 — Notion 에서 고침");
      });

      await orchestrator.pull();

      expect(note("Note.md")).toBe(NOTE.replace("뒤 문단", "뒤 문단 — Notion 에서 고침").trimEnd());
    });

    it("받은 노트를 다시 올려도 Notion 본문은 그대로다", async () => {
      notion.edit(pageId, (page) => {
        page.body = page.body.replace("앞 문단", "앞 문단 — Notion 에서 고침");
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

    it("Notion 에서 글을 고쳐 받아도 펜스는 노트에 적힌 그대로다", async () => {
      expect(fenceLines(notion.pages.get(rowId)!.body)).toEqual([
        "```plain text",
        "```plain text",
        "```typescript",
        "```bash",
      ]);
      notion.edit(rowId, (page) => {
        page.body = page.body.replace("앞 문단", "앞 문단 — Notion 에서 고침");
      });

      const pulled = await orchestrator.pull();

      expect(pulled.failed).toEqual([]);
      expect(note("Tasks/Row.md")).toBe(
        ROW.replace("앞 문단", "앞 문단 — Notion 에서 고침").trimEnd(),
      );
    });
  });
});
