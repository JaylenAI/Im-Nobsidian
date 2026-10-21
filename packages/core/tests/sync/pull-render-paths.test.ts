/**
 * B9 — 새로 받기와 다시 받기가 같은 노트를 만든다.
 *
 * 두 길(`createPulledPage` · `renderRemotePage`)이 렌더를 따로 들고 있어, 한쪽에만 고친 것이 다른 쪽에 없었다.
 * 지금은 한 길(`renderPageNote`)이다. 받은 노트를 Notion 이 그대로일 때 다시 그려(`rerender`) 바뀌는 것이
 * 없으면 두 길이 같다.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

describe("B9 — 새로 받은 노트와 다시 그린 노트", () => {
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
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-render-paths-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it.each([
    ["파일 이름이 곧 제목", "회의 기록"],
    ["파일 이름으로 되살릴 수 없는 제목", "질문: 왜?"],
  ])("%s — 다시 그려도 바뀌지 않는다", async (_name, title) => {
    notion.add(
      "root-page-id",
      title,
      '# 머리\n\n<callout icon="💡">\n\t메모\n</callout>\n- 항목\n\t- 하위\n\n$`x^2`$ 와 글 \\$5',
    );

    expect(await build().pull()).toMatchObject({ created: 1, failed: [] });
    const [record] = db.getAll();
    const pulled = vault.read(record!.obsidianPath);

    expect(await build().pull({ rerender: true })).toMatchObject({ updated: 0, failed: [] });
    expect(vault.read(record!.obsidianPath)).toBe(pulled);
  });
});
