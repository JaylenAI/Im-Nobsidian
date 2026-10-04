/**
 * S-22 — 코드에 ``` 로 시작하는 줄이 있는 코드 블록이 push · pull 을 거쳐 노트에 적힌 그대로 돌아오는지
 * 끝까지 돌린다.
 *
 * Notion Markdown API 는 그런 코드를 어떤 펜스로 보내도 그 줄에서 블록을 가른다(2026-10-04 실측) —
 * 예전에는 코드 블록 하나가 코드 둘 · 문단으로 쪼개져 올라갔다. 이제 push 는 자리표시만 보내고 본문을
 * 쓴 뒤 그 코드 블록의 글을 블록 API 로 채운다. pull 은 Notion 이 펜스를 넓히지 않고 내보낸 본문에서
 * 코드 범위를 정해 경계 펜스를 넓힌다.
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
import { deferredCodeMarker } from "../../src/constants/markers.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DB_ID = "db000000-0000-4000-8000-0000000000c2";

/** 맨 위 · 콜아웃 안 코드에 펜스 줄이 든 노트 — 펜스 줄이 없는 코드도 하나 둔다. */
const NOTE = [
  "앞 문단",
  "",
  "````md",
  "```js",
  "nested();",
  "```",
  "````",
  "",
  "> [!tip] 콜아웃",
  "> ````md",
  "> ```py",
  "> z = 1",
  "> ```",
  "> ````",
  "",
  "```ts",
  "const plain = 1;",
  "```",
  "",
  "뒤 문단",
  "",
].join("\n");

const TOP_CODE = "```js\nnested();\n```";
const CALLOUT_CODE = "```py\nz = 1\n```";

describe("코드 속 펜스 줄 왕복(S-22)", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  const build = (config: Config): SyncOrchestrator =>
    new SyncOrchestrator(config, db, notion.client as never, vault.fs());

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-nested-fence-"));
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
      fill = notion.client.updateCodeBlockText.getMockImplementation()!;
    });

    const body = (): string => notion.pages.get(pageId)!.body;
    /** 메모리 Notion 의 코드 채우기 — 실패를 흉내 낸 뒤 되돌린다. */
    let fill: (...args: never[]) => Promise<void>;

    it("본문에는 자리표시를 보내고 코드는 블록으로 채운다", () => {
      const sent = notion.client.createPageWithMarkdown.mock.calls[0]![0].markdown as string;
      expect(sent).toContain(`\`\`\`markdown\n${deferredCodeMarker(0)}\n\`\`\``);
      expect(sent).toContain(`\t\`\`\`markdown\n${deferredCodeMarker(1)}\n\t\`\`\``);
      expect(sent).not.toContain("nested();");

      expect(notion.client.updateCodeBlockText.mock.calls.map((call) => call.slice(1))).toEqual([
        [TOP_CODE, "markdown"],
        [CALLOUT_CODE, "markdown"],
      ]);
      expect(body()).toContain(`\`\`\`markdown\n${TOP_CODE}\n\`\`\``);
      expect(body()).toContain(`\t\`\`\`markdown\n${CALLOUT_CODE}\n\t\`\`\``);
      expect(body()).toContain("```typescript\nconst plain = 1;\n```");
    });

    it("채운 뒤의 수정 시각을 적는다 — 다시 올려도 아무것도 보내지 않는다", async () => {
      notion.client.replacePageMarkdown.mockClear();
      notion.client.updateCodeBlockText.mockClear();

      expect(await orchestrator.push()).toMatchObject({ created: 0, updated: 0, failed: [] });
      expect(await orchestrator.pull()).toMatchObject({ updated: 0, failed: [] });

      expect(notion.client.replacePageMarkdown).not.toHaveBeenCalled();
      expect(notion.client.updateCodeBlockText).not.toHaveBeenCalled();
      expect(note("Note.md")).toBe(NOTE.trimEnd());
    });

    it("Notion 에서 글을 고쳐 받아도 코드 블록은 노트에 적힌 그대로다", async () => {
      notion.edit(pageId, (page) => {
        page.body = page.body.replace("앞 문단", "앞 문단 — Notion 에서 고침");
      });

      expect(await orchestrator.pull()).toMatchObject({ updated: 1, failed: [] });

      expect(note("Note.md")).toBe(NOTE.replace("앞 문단", "앞 문단 — Notion 에서 고침").trimEnd());
    });

    it("Notion 에서 코드 속 줄을 고치면 그 코드를 받는다", async () => {
      notion.edit(pageId, (page) => {
        page.body = page.body.replace("nested();", "changed();");
      });

      await orchestrator.pull();

      expect(note("Note.md")).toBe(NOTE.replace("nested();", "changed();").trimEnd());
    });

    it("노트를 고쳐 올리면 바꾼 본문에도 코드를 다시 채운다", async () => {
      vault.write("Note.md", NOTE.replace("뒤 문단", "뒤 문단 — 고침"));
      notion.client.updateCodeBlockText.mockClear();

      expect(await orchestrator.push()).toMatchObject({ updated: 1, failed: [] });

      const sent = notion.client.replacePageMarkdown.mock.calls.at(-1)![1] as string;
      expect(sent).toContain(deferredCodeMarker(0));
      expect(notion.client.updateCodeBlockText).toHaveBeenCalledTimes(2);
      expect(body()).toContain(`\`\`\`markdown\n${TOP_CODE}\n\`\`\``);
      expect(body()).not.toContain(deferredCodeMarker(0));

      notion.client.replacePageMarkdown.mockClear();
      expect(await orchestrator.pull()).toMatchObject({ updated: 0, failed: [] });
      expect(await orchestrator.push()).toMatchObject({ updated: 0, failed: [] });
      expect(notion.client.replacePageMarkdown).not.toHaveBeenCalled();
    });

    it("채우다 한 번 멈추면 이번 실행의 재시도가 본문을 다시 보내 채운다", async () => {
      vault.write("Note.md", NOTE.replace("뒤 문단", "뒤 문단 — 고침"));
      notion.client.updateCodeBlockText.mockRejectedValueOnce(new Error("rate limited"));

      expect(await orchestrator.push()).toMatchObject({ updated: 1, failed: [] });

      expect(body()).toContain(`\`\`\`markdown\n${TOP_CODE}\n\`\`\``);
      expect(body()).not.toContain("deferred-code");
    });

    it("계속 채우지 못하면 그 이유로 실패하고, 자리표시가 든 본문은 받지 않으며, 다음 push 가 채운다", async () => {
      vault.write("Note.md", NOTE.replace("뒤 문단", "뒤 문단 — 고침"));
      notion.client.updateCodeBlockText.mockRejectedValue(new Error("rate limited"));

      const result = await orchestrator.push();
      expect(result.failed).toHaveLength(1);
      // 재시도가 pull 을 먼저 하라며 거절하지 않는다 — 원격은 이 도구가 쓴 본문이다.
      expect(result.failed[0]!.error).toContain("rate limited");
      expect(body()).toContain(deferredCodeMarker(0));

      expect(await orchestrator.pull()).toMatchObject({ updated: 0, failed: [] });
      expect(note("Note.md")).toBe(NOTE.replace("뒤 문단", "뒤 문단 — 고침").trimEnd());

      notion.client.updateCodeBlockText.mockReset();
      notion.client.updateCodeBlockText.mockImplementation(fill);
      expect(await orchestrator.push()).toMatchObject({ updated: 1, failed: [] });
      expect(body()).toContain(`\`\`\`markdown\n${TOP_CODE}\n\`\`\``);
      expect(body()).not.toContain("deferred-code");
    });
  });

  describe("만들며 채우지 못한 페이지", () => {
    it("자리표시가 든 본문은 받지 않고, 다음 push 가 본문을 다시 보내 채운다", async () => {
      const orchestrator = build(
        createConfig({
          notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases: [] },
          advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
        }),
      );
      const fill = notion.client.updateCodeBlockText.getMockImplementation()!;
      notion.client.updateCodeBlockText.mockRejectedValue(new Error("rate limited"));
      vault.write("Note.md", NOTE);

      const result = await orchestrator.push();
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.error).toContain("rate limited");
      const pageId = db.getByPath("Note.md")!.notionPageId!;
      expect(notion.pages.get(pageId)!.body).toContain(deferredCodeMarker(0));

      // 원격은 이 도구가 막 쓴 본문이다 — 받을 것도 충돌도 없다.
      expect(await orchestrator.pull()).toMatchObject({ updated: 0, conflicts: [], failed: [] });
      expect(note("Note.md")).toBe(NOTE.trimEnd());

      notion.client.updateCodeBlockText.mockReset();
      notion.client.updateCodeBlockText.mockImplementation(fill);
      expect(await orchestrator.push()).toMatchObject({ updated: 1, failed: [] });
      expect(notion.pages.get(pageId)!.body).toContain(`\`\`\`markdown\n${TOP_CODE}\n\`\`\``);
      expect(notion.pages.get(pageId)!.body).not.toContain("deferred-code");
      expect(await orchestrator.pull()).toMatchObject({ updated: 0, failed: [] });
      expect(note("Note.md")).toBe(NOTE.trimEnd());
    });
  });

  describe("만들며 채우지 못한 행", () => {
    it("받을 것도 충돌도 없고, 다음 push 가 본문을 다시 보내 채운다", async () => {
      notion.client.getDatabaseSchema.mockResolvedValue({ Name: { id: "title", type: "title" } });
      notion.client.getDatabaseViewsConfig.mockResolvedValue({
        databaseId: DB_ID,
        lastSynced: "",
        views: [],
      });
      const orchestrator = build(
        createConfig({
          notion: {
            token: "ntn_test_token",
            rootPageId: "root-page-id",
            databases: [{ databaseId: DB_ID, localFolder: "Tasks", titleProperty: "Name" }],
          },
          advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
        }),
      );
      const ROW = `---\ntitle: Row\n---\n${NOTE}`;
      const fill = notion.client.updateCodeBlockText.getMockImplementation()!;
      notion.client.updateCodeBlockText.mockRejectedValue(new Error("rate limited"));
      vault.write("Tasks/Row.md", ROW);

      const result = await orchestrator.push();
      expect(result.failed.map((f) => f.error)).toEqual([expect.stringContaining("rate limited")]);
      const rowId = db.getByPath("Tasks/Row.md")!.notionPageId!;

      expect(await orchestrator.pull()).toMatchObject({ updated: 0, conflicts: [], failed: [] });
      expect(vault.read("Tasks/Row.md")).toBe(ROW);

      notion.client.updateCodeBlockText.mockReset();
      notion.client.updateCodeBlockText.mockImplementation(fill);
      expect(await orchestrator.push()).toMatchObject({ updated: 1, failed: [] });
      expect(notion.pages.get(rowId)!.body).toContain(`\`\`\`markdown\n${TOP_CODE}\n\`\`\``);
      expect(notion.pages.get(rowId)!.body).not.toContain("deferred-code");
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

    it("행 본문에도 코드를 채우고, Notion 에서 고쳐 받아도 그대로다", async () => {
      expect(notion.pages.get(rowId)!.body).toContain(`\`\`\`markdown\n${TOP_CODE}\n\`\`\``);
      notion.edit(rowId, (page) => {
        page.body = page.body.replace("앞 문단", "앞 문단 — Notion 에서 고침");
      });

      await orchestrator.pull();

      expect(note("Tasks/Row.md")).toContain(
        NOTE.replace("앞 문단", "앞 문단 — Notion 에서 고침").trimEnd(),
      );
    });

    it("행을 고쳐 올려도 코드를 다시 채운다", async () => {
      vault.write("Tasks/Row.md", ROW.replace("뒤 문단", "뒤 문단 — 고침"));
      notion.client.updateCodeBlockText.mockClear();

      expect(await orchestrator.push()).toMatchObject({ updated: 1, failed: [] });

      expect(notion.client.updateCodeBlockText).toHaveBeenCalledTimes(2);
      expect(notion.pages.get(rowId)!.body).not.toContain("deferred-code");
    });
  });
});
