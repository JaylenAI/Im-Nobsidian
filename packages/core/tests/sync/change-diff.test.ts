/**
 * 변경 패널의 줄 비교 — 변경 하나를 무엇과 무엇으로 견주는가.
 *
 * 로컬 변경은 지난 동기화 때의 글과 지금 볼트의 글, 원격 변경은 지난 동기화 때의 글과 Notion 의 지금 글.
 * 실제 StateDB(임시 파일) · 메모리 볼트 · 메모리 Notion 으로 끝까지 돌린다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { LocalChange, RemoteChange } from "../../src/types/sync.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const DAY = "2026-09-04";
const ORIGINAL = "# 노트\n\n처음 본문\n";

function at(hms: string): void {
  vi.setSystemTime(new Date(`${DAY}T${hms}.000Z`));
}

describe("변경 하나의 두 글 — 줄 비교", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let orchestrator: SyncOrchestrator;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at("10:00:05");
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-change-diff-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion({ minuteClock: true });
    orchestrator = new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases: [] },
        sync: { ...DEFAULT_CONFIG.sync, deleteSync: true },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );
    vault.write("Note.md", ORIGINAL);
    expect(await orchestrator.push()).toMatchObject({ created: 1, failed: [] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  /** 변경 목록이 이 경로에 보인 변경. */
  async function localChange(path: string): Promise<LocalChange> {
    const change = (await orchestrator.statusLocal()).localChanges.find((c) => c.path === path);
    expect(change).toBeDefined();
    return change!;
  }

  describe("로컬 변경 — 지난 동기화 때의 글과 지금 볼트의 글", () => {
    it("고친 노트", async () => {
      vault.write("Note.md", "# 노트\n\n고친 본문\n");

      expect(await orchestrator.localChangeDiff(await localChange("Note.md"))).toEqual({
        path: "Note.md",
        type: "modified",
        before: ORIGINAL,
        after: "# 노트\n\n고친 본문\n",
      });
    });

    it("새 노트는 옛 글이 없다", async () => {
      vault.write("New.md", "새 노트\n");

      expect(await orchestrator.localChangeDiff(await localChange("New.md"))).toEqual({
        path: "New.md",
        type: "created",
        before: null,
        after: "새 노트\n",
      });
    });

    it("지운 노트는 지금 글이 없다", async () => {
      vault.files.delete("Note.md");

      expect(await orchestrator.localChangeDiff(await localChange("Note.md"))).toEqual({
        path: "Note.md",
        type: "deleted",
        before: ORIGINAL,
        after: null,
      });
    });

    it("옮긴 노트는 옛 자리의 지난 글과 새 자리의 지금 글을 견준다", async () => {
      vault.rename("Note.md", "Moved/Note.md");

      expect(await orchestrator.localChangeDiff(await localChange("Moved/Note.md"))).toEqual({
        path: "Moved/Note.md",
        type: "moved",
        movedFrom: "Note.md",
        before: ORIGINAL,
        after: ORIGINAL,
      });
    });

    it("옮기며 고친 노트는 고친 것까지 보인다", async () => {
      vault.rename("Note.md", "Moved/Renamed.md");
      orchestrator.recordLocalRename("Note.md", "Moved/Renamed.md", "file");
      vault.write("Moved/Renamed.md", "# 노트\n\n옮기며 고친 본문\n");

      expect(await orchestrator.localChangeDiff(await localChange("Moved/Renamed.md"))).toEqual({
        path: "Moved/Renamed.md",
        type: "moved",
        movedFrom: "Note.md",
        before: ORIGINAL,
        after: "# 노트\n\n옮기며 고친 본문\n",
      });
    });

    it("그 사이 올려 기록이 바뀐 변경은 거절한다 — 엉뚱한 옛 글과 견주지 않는다", async () => {
      vault.write("Note.md", "# 노트\n\n고친 본문\n");
      const stale = await localChange("Note.md");
      await orchestrator.push();
      vault.write("Note.md", "# 노트\n\n또 고친 본문\n");

      await expect(orchestrator.localChangeDiff(stale)).rejects.toThrow(
        "지난 동기화 기록이 변경 목록과 맞지 않습니다 — 새로고침한 뒤 다시 보세요 (Note.md)",
      );
    });

    it("지난 동기화 사본이 없으면 거절한다 — 모든 줄을 새 줄로 보이지 않는다", async () => {
      const record = db.getByPath("Note.md")!;
      db.updateHash(record.id, record.contentHash, null);
      vault.write("Note.md", "# 노트\n\n고친 본문\n");

      await expect(orchestrator.localChangeDiff(await localChange("Note.md"))).rejects.toThrow(
        "지난 동기화 사본이 없어 비교할 수 없습니다 — Note.md",
      );
    });
  });

  describe("원격 변경 — 지난 동기화 때의 글과 Notion 의 지금 글", () => {
    /** 한 번 받아 두고 Notion 에서 고친 뒤의 원격 변경 목록. */
    async function remoteChangesAfter(edit: () => void): Promise<RemoteChange[]> {
      at("10:00:20");
      await orchestrator.pull();
      at("10:02:00");
      edit();
      at("10:03:00");
      return (await orchestrator.status()).remoteChanges;
    }

    const pageId = () => db.getByPath("Note.md")!.notionPageId!;

    it("Notion 에서 고친 노트 — 로컬 편집이 아니라 지난 동기화와 견주고, 볼트 · 기록은 그대로 둔다", async () => {
      const [change] = await remoteChangesAfter(() =>
        notion.edit(pageId(), (page) => {
          page.body = "Notion 에서 고친 본문";
        }),
      );
      vault.write("Note.md", "# 노트\n\n로컬에서 고친 본문\n");
      const record = db.getByPath("Note.md")!;

      const diff = await orchestrator.remoteChangeDiff(change!);

      expect(diff).toMatchObject({ path: "Note.md", type: "modified", before: ORIGINAL });
      expect(diff.after).toContain("Notion 에서 고친 본문");
      expect(diff.after).not.toContain("로컬에서 고친 본문");
      expect(vault.read("Note.md")).toBe("# 노트\n\n로컬에서 고친 본문\n");
      expect(db.getByPath("Note.md")).toEqual(record);
    });

    it("노트 자리는 추적 기록에서 찾는다 — 볼트 경로를 싣지 않은 변경도 견준다", async () => {
      const [change] = await remoteChangesAfter(() =>
        notion.edit(pageId(), (page) => {
          page.body = "Notion 에서 고친 본문";
        }),
      );
      const { pageId: id, type, lastEdited, previousEdited } = change!;

      expect(
        await orchestrator.remoteChangeDiff({ pageId: id, type, lastEdited, previousEdited }),
      ).toMatchObject({ path: "Note.md", type: "modified", before: ORIGINAL });
    });

    it("Notion 에서 지운 페이지는 지금 글이 없다", async () => {
      const [change] = await remoteChangesAfter(() =>
        notion.edit(pageId(), (page) => {
          page.archived = true;
        }),
      );

      expect(await orchestrator.remoteChangeDiff(change!)).toEqual({
        path: "Note.md",
        type: "deleted",
        before: ORIGINAL,
        after: null,
      });
    });

    it("아직 받지 않은 새 페이지는 견줄 글이 없다고 거절한다", async () => {
      const [change] = await remoteChangesAfter(() =>
        notion.add("root-page-id", "Notion 새 페이지", "새 본문"),
      );

      await expect(orchestrator.remoteChangeDiff(change!)).rejects.toThrow(
        "아직 받지 않은 새 페이지라 견줄 글이 없습니다 — Notion 새 페이지",
      );
    });

    it("폴더는 견줄 글이 없다고 거절한다", async () => {
      vault.write("Folder/Child.md", "자식\n");
      await orchestrator.push();
      const folder = db.getByPath("Folder")!;

      await expect(
        orchestrator.remoteChangeDiff({
          pageId: folder.notionPageId!,
          type: "modified",
          lastEdited: "2026-09-04T10:02:00.000Z",
          previousEdited: null,
          path: "Folder",
        }),
      ).rejects.toThrow("폴더라 견줄 글이 없습니다 — Folder");
    });
  });
});
