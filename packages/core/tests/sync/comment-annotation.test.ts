/**
 * S-31 — 주석 속 서식 · frontmatter 값 속 `==` · `<u>` 가 push · pull 을 거쳐도 Notion 에 새지 않고, 노트에
 * 적힌 그대로 돌아오는지 끝까지 돌린다.
 *
 * 서식 보존(`InlineAnnotationPreserver`)이 frontmatter 분리 · 주석 제거보다 먼저 돌아, 주석 속
 * `==강조==` 가 있으면 주석이 통째로 Notion 에 올라갔고, 제목 · 속성 값 속 `==` 가 마커 글자
 * (`%%im-nobsidian:color:yellow_bg%%…`)로 Notion 에 실린 뒤 pull 로 노트의 frontmatter 까지 덮었다.
 *
 * 실제 StateDB(임시 파일) · 메모리 볼트 · 메모리 Notion 으로 돌린다(comment-roundtrip 과 같은 하니스).
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
import { splitFrontmatter } from "../../src/utils/frontmatter.js";

const DB_ID = "db000000-0000-4000-8000-0000000000c3";

/** Notion 에 새면 안 되는 글 — 주석의 메모 글 · `%%` · 서식 마커 글자. */
const LEAK_RE = /메모|%%|im-nobsidian:(?:color|underline)/;

/** 제목의 `==` · 문장 속 주석의 하이라이트 · 주석 밖 하이라이트. */
const NOTE = [
  "---",
  "title: a ==b== c",
  "---",
  "본문 %%메모 ==강조== 끝%% 이어서.",
  "",
  "==진짜 강조== 문단",
  "",
].join("\n");

describe("주석 속 서식 · 속성 값 속 `==` (S-31)", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  const build = (config: Config): SyncOrchestrator =>
    new SyncOrchestrator(config, db, notion.client as never, vault.fs());

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-annotation-"));
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

  it("페이지 — 제목은 적은 글 그대로, 주석은 통째로 빠지고, 받아도 노트 그대로다", async () => {
    const orchestrator = build(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases: [] },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
    );
    vault.write("Note.md", NOTE);
    expect(await orchestrator.push()).toMatchObject({ created: 1, failed: [] });
    const page = notion.pages.get(db.getByPath("Note.md")!.notionPageId!)!;

    expect(page.title).toBe("a ==b== c");
    expect(page.body).not.toMatch(LEAK_RE);
    expect(page.body).toContain("title: a ==b== c");
    expect(page.body).toContain('<span color="yellow_bg">진짜 강조</span>');

    notion.edit(page.id, (edited) => {
      edited.body = edited.body.replace("문단", "문단 고침");
    });
    expect(await orchestrator.pull()).toMatchObject({ updated: 1, failed: [] });

    expect(note("Note.md")).toBe(NOTE.replace("문단", "문단 고침").trimEnd());
  });

  it("설정 DB 의 행 — 제목 · 글 속성은 적은 글 그대로다", async () => {
    notion.client.getDatabaseSchema.mockResolvedValue({
      Name: { id: "title", type: "title" },
      Summary: { id: "sum", type: "rich_text" },
    });
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
    const row = NOTE.replace("title: a ==b== c", 'title: a ==b== c\nSummary: "x == y <u>z</u>"');
    vault.write("Tasks/Row.md", row);
    expect(await orchestrator.push()).toMatchObject({ created: 1, failed: [] });
    const page = notion.pages.get(db.getByPath("Tasks/Row.md")!.notionPageId!)!;

    expect(page.title).toBe("a ==b== c");
    expect(page.properties.Summary).toMatchObject({
      rich_text: [{ plain_text: "x == y <u>z</u>" }],
    });
    expect(page.body).not.toMatch(LEAK_RE);

    notion.edit(page.id, (edited) => {
      edited.body = edited.body.replace("문단", "문단 고침");
    });
    expect((await orchestrator.pull()).failed).toEqual([]);

    // 행의 frontmatter 는 Notion 속성에서 다시 쓴다 — 키 차례 · 따옴표는 이 시험 밖이라 값으로 견준다.
    const pulled = splitFrontmatter(note("Tasks/Row.md")!);
    expect(pulled.data).toEqual({ title: "a ==b== c", Summary: "x == y <u>z</u>" });
    expect(pulled.content.trim()).toBe(
      splitFrontmatter(row).content.replace("문단", "문단 고침").trim(),
    );
  });
});
