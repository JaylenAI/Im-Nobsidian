/**
 * 본문이 구분선(`---`)으로 시작하는 노트의 push 는 본문을 빠짐없이 보낸다.
 *
 * Notion 의 구분선으로 시작하는 페이지를 pull 하면 노트가 `---` 로 시작한다. gray-matter 는 그 줄을
 * frontmatter 의 여는 줄로 읽어, 다음 구분선까지(없으면 끝까지)를 YAML 로 읽고 본문에서 뺐다. 그
 * 노트를 고쳐 push 하면 그 구간이 Notion 본문에서 사라지고, YAML 이 목록 · 글로 읽힌 값은 속성
 * 블록(글이면 글자 단위)이 되어 올라갔다. 행은 속성이 글 · 목록이 되어 본문이 비었다.
 *
 * 첫 줄이 `---js` 면 gray-matter 가 그 사이를 JavaScript 로 실행했다.
 *
 * 실제 StateDB(임시 파일)와 메모리 볼트 · 메모리 Notion 으로(configured-db-row-push 와 같은 하니스).
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
import { MemoryVault, memoryNotion, type MemoryPage } from "../helpers/memory-sync.js";

const ROOT_DB_ID = "db000000-0000-4000-8000-0000000000d1";

/** 구분선 · 제목 · 목록 · 구분선 — gray-matter 는 목록을 속성으로, 제목을 YAML 주석으로 읽었다. */
const DIVIDER_LIST = "---\n## 개요\n- 항목 하나\n- 항목 둘\n---\n\n끝 문단\n";
/** 닫는 구분선이 없다 — gray-matter 는 본문 전체를 글 하나로 읽었다. */
const DIVIDER_OPEN = "---\n\n첫 문단\n\n둘째 문단\n";

function pageMode(): Config {
  return createConfig({
    notion: { token: "ntn_test_token", rootPageId: "root-page-id" },
    advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
  });
}

function databaseMode(): Config {
  return createConfig({
    notion: {
      token: "ntn_test_token",
      rootPageId: "root-page-id",
      parentMode: "database",
      databaseId: ROOT_DB_ID,
    },
    advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
  });
}

describe("구분선으로 시작하는 노트의 push", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  const build = (config: Config): SyncOrchestrator =>
    new SyncOrchestrator(config, db, notion.client as never, vault.fs());

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-divider-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
    notion.client.getDatabaseSchema.mockResolvedValue({ Name: { id: "title", type: "title" } });
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const pageOf = (path: string): MemoryPage => notion.pages.get(db.getByPath(path)!.notionPageId!)!;

  function expectWholeBody(page: MemoryPage, parts: readonly string[]): void {
    for (const part of parts) expect(page.body).toContain(part);
    expect(page.body).not.toContain("im-nobsidian:properties");
    expect(page.properties).toEqual({});
  }

  it.each([
    ["구분선 · 목록 · 구분선", DIVIDER_LIST, ["## 개요", "- 항목 하나", "- 항목 둘", "끝 문단"]],
    ["닫는 구분선 없음", DIVIDER_OPEN, ["첫 문단", "둘째 문단"]],
  ])("새 페이지도, 고친 페이지도 본문을 전부 보낸다 — %s", async (_label, note, parts) => {
    const orchestrator = build(pageMode());
    vault.write("Note.md", note);

    const created = await orchestrator.push();
    expect(created).toMatchObject({ created: 1, failed: [] });
    expectWholeBody(pageOf("Note.md"), parts);

    vault.write("Note.md", `${note}\n로컬에서 더한 문단\n`);
    const updated = await orchestrator.push();
    expect(updated).toMatchObject({ updated: 1, failed: [] });
    expectWholeBody(pageOf("Note.md"), [...parts, "로컬에서 더한 문단"]);
  });

  it("첫 줄이 `---js` 인 노트를 실행하지 않고 글로 보낸다", async () => {
    const probe = "__dividerPushEvalProbe";
    const orchestrator = build(pageMode());
    vault.write("Js.md", `---js\n\nglobalThis.${probe} = 1\n\n---\n\n본문 a\n`);

    const result = await orchestrator.push();

    expect(result).toMatchObject({ created: 1, failed: [] });
    expect((globalThis as Record<string, unknown>)[probe]).toBeUndefined();
    expectWholeBody(pageOf("Js.md"), ["---js", `globalThis.${probe} = 1`, "본문 a"]);
  });

  it("DB 모드의 행도 본문을 전부 보내고 속성을 만들지 않는다", async () => {
    const orchestrator = build(databaseMode());
    vault.write("Note.md", DIVIDER_OPEN);

    const result = await orchestrator.push();

    expect(result).toMatchObject({ created: 1, failed: [] });
    const row = pageOf("Note.md");
    expect(row.parentType).toBe("database");
    expect(row.title).toBe("Note");
    expectWholeBody(row, ["첫 문단", "둘째 문단"]);
  });
});
