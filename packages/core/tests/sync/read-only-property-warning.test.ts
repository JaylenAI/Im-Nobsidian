/**
 * 볼트에서 고친 읽기 전용 속성(수식 · 롤업 · ID …) — Notion 이 값을 정해 보낼 수 없다.
 *
 * 예전에는 정보 로그 한 줄만 남기고 넘어가, 다음 pull 이 고친 값을 Notion 값으로 말없이 되돌렸다. 이제 push 결과의
 * `readOnlySkipped` 로 돌려주고 경고 로그를 남긴다 — CLI · 플러그인이 그것으로 알린다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { parseFrontmatter } from "../../src/utils/frontmatter.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { getLogger, setLogger, type Logger } from "../../src/utils/logger.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const ROW_DB_ID = "db000000-0000-4000-8000-0000000000e7";

describe("읽기 전용 속성 편집 경고", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let previous: Logger;
  /** 읽기 전용 속성 로그 — 결과(`readOnlySkipped`)가 화면에 알리므로 정보 로그다(경고로 내면 CLI 가 두 번 말했다). */
  const logged = vi.fn();

  const build = (): SyncOrchestrator =>
    new SyncOrchestrator(
      createConfig({
        notion: {
          token: "ntn_test_token",
          rootPageId: "root-page-id",
          databases: [{ databaseId: ROW_DB_ID, localFolder: "Tasks", titleProperty: "Name" }],
        },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-readonly-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
    notion.client.getDatabaseSchema.mockResolvedValue({
      Name: { id: "title", type: "title" },
      Status: { id: "status", type: "select" },
      Score: { id: "score", type: "formula" },
    });
    previous = getLogger();
    logged.mockClear();
    setLogger({ ...previous, warn: () => {}, info: logged });
  });

  afterEach(async () => {
    vi.useRealTimers();
    setLogger(previous);
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function pulledRow(orchestrator: SyncOrchestrator): Promise<string> {
    const row = notion.add(ROW_DB_ID, "Task", "행 본문", {
      properties: {
        Status: { select: { name: "할 일" } },
        Score: { formula: { type: "number", number: 1 } },
      },
    });
    expect(await orchestrator.pull()).toMatchObject({ created: 1, failed: [] });
    return db.getByNotionId(row.id)!.obsidianPath;
  }

  it("수식을 고친 행은 다른 속성은 올리고, 수식은 결과 · 경고로 알린다", async () => {
    const orchestrator = build();
    const path = await pulledRow(orchestrator);
    vault.write(
      path,
      vault.read(path)!.replace("Score: 1", "Score: 99").replace("Status: 할 일", "Status: 끝"),
    );

    const result = await orchestrator.push();

    expect(result).toMatchObject({ updated: 1, failed: [] });
    expect(result.readOnlySkipped).toEqual([{ path, properties: ["Score"] }]);
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining("다음 pull 이 Notion 값으로 되돌린다"),
    );
    const sent = notion.pages.get(db.getByPath(path)!.notionPageId!)!;
    expect(sent.properties.Status).toMatchObject({ select: { name: "끝" } });

    // 알린 그대로 — 다음 pull 은 Notion 값으로 되돌리고, 그 뒤로는 고요하다.
    // 예전에는 사본에 볼트의 값이 남고 원격은 «우리가 쓴 그대로» 라 받지 않아, Notion 이 그 행을 바꿀 때까지 달랐다.
    expect(await orchestrator.pull()).toMatchObject({ updated: 1, failed: [], conflicts: [] });
    expect(parseFrontmatter(vault.read(path)!).data).toMatchObject({ Score: 1, Status: "끝" });
    const quiet = await orchestrator.push();
    expect(quiet).toMatchObject({ updated: 0 });
    expect(quiet.readOnlySkipped ?? []).toEqual([]);
    expect(await orchestrator.pull()).toMatchObject({ updated: 0 });
  });

  it("수식만 고친 행도 다음 pull 이 되돌린다 — Notion 이 그대로라 바뀐 것만 찾는 pull 이어도", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-28T10:00:00.000Z"));
    const orchestrator = build();
    const path = await pulledRow(orchestrator);
    // 행이 바뀐 것만 찾는 pull 의 조회 창 밖으로 — 실측의 행은 오래전에 만들었다. 전체 대조는 아직 때가 아니다.
    vi.setSystemTime(new Date("2026-10-28T10:50:00.000Z"));
    // 실제 클라이언트처럼 `since` 뒤에 고친 것만 준다. 메모리 하네스는 다 주는데, 그러면 이 행의 DB 를 «바뀌었다» 로
    // 보고 조회해 결함을 가린다(하네스의 수정 시각은 기기 시계와 따로 가 하네스를 고치면 다른 시험이 깨진다).
    const search = notion.client.searchRecentPages.getMockImplementation()!;
    notion.client.searchRecentPages.mockImplementation(async (since: string) =>
      (await search(since)).filter((page) => Date.parse(page.last_edited_time) > Date.parse(since)),
    );
    vault.write(path, vault.read(path)!.replace("Score: 1", "Score: 99"));

    const result = await orchestrator.push();
    expect(result.readOnlySkipped).toEqual([{ path, properties: ["Score"] }]);

    // 보낸 것이 없어 Notion 의 행도 DB 도 그대로다. 예전에는 바뀐 것만 찾는 pull 이 그 DB 를 «그대로» 로 건너뛰어,
    // 알림과 달리 볼트에 고친 값이 남았다(실측 2026-10-28) — 강제 전체 대조만 되돌렸다.
    const pulled = await orchestrator.pull();
    expect(pulled).toMatchObject({ updated: 1, failed: [], remoteScan: { kind: "incremental" } });
    expect(parseFrontmatter(vault.read(path)!).data).toMatchObject({ Score: 1 });
    expect(await orchestrator.pull()).toMatchObject({ updated: 0 });
  });

  it("읽기 전용 속성을 건드리지 않은 push 는 아무것도 알리지 않는다", async () => {
    const orchestrator = build();
    const path = await pulledRow(orchestrator);
    vault.write(path, vault.read(path)!.replace("Status: 할 일", "Status: 끝"));

    const result = await orchestrator.push();

    expect(result).toMatchObject({ updated: 1, failed: [] });
    expect(result.readOnlySkipped).toEqual([]);
    expect(logged).not.toHaveBeenCalledWith(expect.stringContaining("읽기 전용"));
  });

  it("dry-run 도 올리지 않을 읽기 전용 속성을 미리 알린다 — 보내지는 않는다", async () => {
    const orchestrator = build();
    const path = await pulledRow(orchestrator);
    vault.write(
      path,
      vault.read(path)!.replace("Score: 1", "Score: 99").replace("Status: 할 일", "Status: 끝"),
    );

    const planned = await orchestrator.push({ dryRun: true });

    expect(planned).toMatchObject({ updated: 1, failed: [] });
    expect(planned.readOnlySkipped).toEqual([{ path, properties: ["Score"] }]);
    const remote = notion.pages.get(db.getByPath(path)!.notionPageId!)!;
    expect(remote.properties.Status).toMatchObject({ select: { name: "할 일" } });

    // 읽기 전용을 건드리지 않았으면 알릴 것이 없다.
    vault.write(path, vault.read(path)!.replace("Score: 99", "Score: 1"));
    expect((await orchestrator.push({ dryRun: true })).readOnlySkipped ?? []).toEqual([]);
  });
});
