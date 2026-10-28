/**
 * 페이지 제목의 서식(D9) — 볼트는 제목을 평문으로만 안다.
 *
 * 예전에는 노트 이름 · frontmatter `title` 을 바꾸면 평문을 그대로 보내, 한 글자만 고쳐도 Notion 제목의 굵게 · 색 ·
 * 링크가 모두 지워졌다. DB 행 제목은 이미 원격의 서식 위에 바뀐 글자만 고쳐 보냈다(F-08). 이제 페이지도 같다.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { titleProperty } from "../../src/sync/note-title.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const PLAIN = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default",
};

/** Notion 이 돌려주는 제목 조각. */
function run(text: string, annotations: Partial<typeof PLAIN> = {}) {
  return {
    type: "text",
    plain_text: text,
    text: { content: text, link: null },
    annotations: { ...PLAIN, ...annotations },
  };
}

/** `**굵은** 회의 메모` — 앞 낱말만 굵고 빨갛다. */
const FORMATTED = {
  title: {
    id: "title",
    type: "title",
    title: [run("굵은", { bold: true, color: "red" }), run(" 회의 메모")],
  },
};

describe("titleProperty", () => {
  it("원격 제목의 서식 위에 바뀐 글자만 고친다", () => {
    expect(titleProperty("굵은 회의 기록", FORMATTED)).toEqual({
      title: {
        title: [
          { text: { content: "굵은" }, annotations: { ...PLAIN, bold: true, color: "red" } },
          { text: { content: " 회의 기록" } },
        ],
      },
    });
  });

  it("원격을 모르면 예전처럼 평문이다", () => {
    expect(titleProperty("새 제목")).toEqual({
      title: { title: [{ text: { content: "새 제목" } }] },
    });
  });
});

describe("페이지 제목을 바꾼 push", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  const build = (): SyncOrchestrator =>
    new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases: [] },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-title-format-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("노트 이름을 바꾸면 굵게 · 색이 남은 제목으로 보낸다", async () => {
    const orchestrator = build();
    const page = notion.add("root-page-id", "굵은 회의 메모", "본문");
    notion.edit(page.id, (p) => {
      p.properties.title = FORMATTED.title as never;
    });
    expect(await orchestrator.pull()).toMatchObject({ created: 1, failed: [] });
    expect(vault.read("굵은 회의 메모.md")).toBeDefined();

    vault.rename("굵은 회의 메모.md", "굵은 회의 기록.md");
    notion.client.updatePageProperties.mockClear();
    expect(await orchestrator.push()).toMatchObject({ failed: [] });

    const sent = notion.client.updatePageProperties.mock.calls.map((call) => call[1]);
    expect(sent).toContainEqual({
      title: {
        title: [
          { text: { content: "굵은" }, annotations: { ...PLAIN, bold: true, color: "red" } },
          { text: { content: " 회의 기록" } },
        ],
      },
    });
  });
});
