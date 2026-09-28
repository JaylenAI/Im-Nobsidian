/**
 * 원격 변경은 화면이 이름으로 보일 수 있게 경로 · 제목을 싣는다 — 변경 패널이 내부 id(`3e813b18...`)
 * 대신 노트 이름을 보이고, 그 노트만 받을 수 있게 한다.
 *
 * 실제 StateDB(임시 파일) · 메모리 볼트 · 메모리 Notion 으로 끝까지 돌린다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import {
  createConfig,
  createMockNotionClient,
  createMockStateDb,
  createMockVaultFs,
} from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DAY = "2026-09-04";

function at(hms: string): void {
  vi.setSystemTime(new Date(`${DAY}T${hms}.000Z`));
}

describe("원격 변경은 경로 · 제목을 싣는다", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  // deleteSync 를 켠 시험은 원격에서 지운 노트를 본다 — 전체 대조를 pull 마다 한다(ADR-027 — 이제
  // 전체 대조는 주기마다다. 예전에는 deleteSync 면 늘 전체 대조였다).
  const build = (deleteSync: boolean): SyncOrchestrator =>
    new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases: [] },
        sync: {
          ...DEFAULT_CONFIG.sync,
          deleteSync,
          fullReconcileInterval: deleteSync ? 0 : DEFAULT_CONFIG.sync.fullReconcileInterval,
        },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00:05");
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-remote-names-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion({ minuteClock: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  /** 두 노트를 올리고 한 번 받아 둔 뒤, Notion 에서 하나는 고치고 하나는 지우고 새 페이지를 만든다. */
  async function remoteEdits(orchestrator: SyncOrchestrator): Promise<void> {
    vault.write("a/Keep.md", "남길 노트\n");
    vault.write("Gone.md", "지울 노트\n");
    expect(await orchestrator.push()).toMatchObject({ created: 2, failed: [] });
    at("10:00:20");
    await orchestrator.pull();

    at("10:02:00");
    notion.edit(db.getByPath("a/Keep.md")!.notionPageId!, (page) => {
      page.body = "Notion 에서 고침";
    });
    notion.edit(db.getByPath("Gone.md")!.notionPageId!, (page) => {
      page.archived = true;
    });
    notion.add("root-page-id", "Notion 새 페이지", "새 본문");
    at("10:03:00");
  }

  it("전체 대조: 고친 · 지운 노트는 볼트 경로를, 새 페이지는 제목을 싣는다", async () => {
    const orchestrator = build(true);
    await remoteEdits(orchestrator);

    const { remoteChanges } = await orchestrator.status();
    const shown = remoteChanges.map((c) => [c.type, c.path ?? null, c.title ?? null]);

    expect(shown).toEqual(
      expect.arrayContaining([
        ["modified", "a/Keep.md", null],
        ["deleted", "Gone.md", null],
        ["created", null, "Notion 새 페이지"],
      ]),
    );
    expect(shown).toHaveLength(3);
  });

  it("증분 감지도 같다 — 고친 노트는 경로, 새 페이지는 제목", async () => {
    const orchestrator = build(false);
    await remoteEdits(orchestrator);

    const { remoteChanges } = await orchestrator.status();
    const shown = remoteChanges.map((c) => [c.type, c.path ?? null, c.title ?? null]);

    expect(shown).toEqual(
      expect.arrayContaining([
        ["modified", "a/Keep.md", null],
        ["created", null, "Notion 새 페이지"],
      ]),
    );
  });

  it("고친 노트 하나만 받으면 그 노트만 받는다", async () => {
    const orchestrator = build(true);
    await remoteEdits(orchestrator);

    const { remoteChanges } = await orchestrator.status();
    const keep = remoteChanges.find((c) => c.type === "modified")!;
    const result = await orchestrator.pull({ paths: [keep.path!] });

    expect(result).toMatchObject({ created: 0, updated: 1, deleted: 0, failed: [] });
    expect(vault.read("a/Keep.md")).toContain("Notion 에서 고침");
    expect(vault.read("Gone.md")).toBe("지울 노트\n");
  });

  it("지운 노트 하나만 받으면 그 노트만 지운다", async () => {
    const orchestrator = build(true);
    await remoteEdits(orchestrator);

    const { remoteChanges } = await orchestrator.status();
    const gone = remoteChanges.find((c) => c.type === "deleted")!;
    const result = await orchestrator.pull({ paths: [gone.path!] });

    expect(result).toMatchObject({ created: 0, updated: 0, deleted: 1, failed: [] });
    expect(vault.files.has("Gone.md")).toBe(false);
    expect(vault.read("a/Keep.md")).toBe("남길 노트\n");
  });
});

describe("DB 모드의 새 행도 제목을 싣는다", () => {
  it("DB 하나를 루트로 쓰는 볼트 — 아직 없는 행은 Notion 제목으로 보인다", async () => {
    const notion = createMockNotionClient();
    notion.queryAllDatabasePages.mockResolvedValue([
      { id: "row-new", last_edited_time: "2026-07-02T00:00:00.000Z" },
    ]);
    notion.extractTitle.mockImplementation((page: { id: string }) =>
      page.id === "row-new" ? "새 행 제목" : "다른 페이지",
    );
    const base = createConfig();
    const orchestrator = new SyncOrchestrator(
      { ...base, notion: { ...base.notion, parentMode: "database", databaseId: "db-root" } },
      createMockStateDb() as never,
      notion as never,
      createMockVaultFs() as never,
    );

    const { remoteChanges } = await orchestrator.status();

    expect(remoteChanges).toEqual([
      expect.objectContaining({ pageId: "row-new", type: "created", title: "새 행 제목" }),
    ]);
  });
});
