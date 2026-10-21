/**
 * Phase 5 — 원격 훑기와 작업 잠금 (B6 · B7 · B8 · B15), 오케스트레이터 배선 수준.
 *
 * B6: 원격까지 보는 상태 확인은 분 단위가 걸릴 수 있는데 취소 신호를 받지 않았다 — 플러그인을 내려도 끝까지 돌았다.
 * B7: 충돌 목록은 원격 본문을 렌더하며 첨부를 볼트에 받는데 작업 잠금 밖에서 돌아, 도는 sync 와 겹쳤다.
 * B8: 바뀐 페이지를 찾는 증분 훑기가 조회 창에 든 루트 페이지를 매번 한 번 더 읽었다.
 * B15: Obsidian 은 `노트.MD` 도 노트로 여는데 CLI 볼트 목록은 첨부로 보고, 경로 → 제목 함수 둘의 답이 달랐다.
 *
 * 실제 StateDB(임시 파일)와 메모리 볼트 · 메모리 Notion.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { SyncBusyError } from "../../src/sync/operation-gate.js";
import { RemoteDriftChecker } from "../../src/sync/remote-drift.js";
import type { RemoteChange } from "../../src/types/sync.js";
import { NodeVaultFS } from "../../src/sync/node-vault-fs.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { extractTitle } from "../../src/sync/note-title.js";
import { wikilinkTitleFromPath } from "../../src/utils/wikilink-title.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

describe("원격 훑기와 작업 잠금 (Phase 5)", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;
  let rootId: string;

  const build = (): SyncOrchestrator =>
    new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: rootId },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-remote-scan-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    // 루트 아래에 페이지를 만들면 루트의 수정 시각도 바뀐다 — Notion 처럼.
    notion = memoryNotion({ bumpParentOnCreate: true });
    rootId = notion.add("workspace", "루트").id;
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("B8 — 증분 훑기의 요청 수", () => {
    /** 추적하는 노트가 있어야 바뀐 것만 찾는다 — 처음 받기는 전체 대조다. */
    const tracked = async () => {
      vault.write("가.md", "가\n");
      await build().push();
      await build().pull();
    };

    it("루트 밖에서 고친 페이지는 다시 읽지 않는다 — search 가 준 부모로 가른다", async () => {
      await tracked();
      const elsewhere = notion.add("workspace", "다른 곳 글", "본문");
      notion.client.getPage.mockClear();

      expect(await build().pull()).toMatchObject({ created: 0, failed: [] });

      expect(notion.client.searchRecentPages).toHaveBeenCalled();
      expect(notion.client.getPage).not.toHaveBeenCalledWith(elsewhere.id);
      expect(notion.client.getPage).not.toHaveBeenCalledWith(rootId);
    });

    it("루트 아래 새 페이지는 받는다 — 그 페이지를 본문 받을 때 한 번만 읽는다", async () => {
      await tracked();
      const created = notion.add(rootId, "새 글", "본문");
      notion.client.getPage.mockClear();

      expect(await build().pull()).toMatchObject({ created: 1, failed: [] });

      expect(vault.read("새 글.md")).toContain("본문");
      expect(notion.client.getPage.mock.calls.filter(([id]) => id === created.id)).toHaveLength(1);
    });

    it("루트는 새 페이지 후보가 아니다 — 부모가 블록이어도 거슬러 읽지 않는다", async () => {
      await tracked();
      const search = notion.client.searchRecentPages.getMockImplementation()!;
      notion.client.searchRecentPages.mockImplementation(async (...args: never[]) =>
        (await search(...args)).map((page: { id: string }) =>
          page.id === rootId
            ? { ...page, parent: { type: "block_id", block_id: "column-1" } }
            : page,
        ),
      );
      const getBlock = vi.fn(async () => ({ parent: { type: "page_id", page_id: "workspace" } }));
      Object.assign(notion.client, { getBlock });
      notion.touch(rootId);

      await build().pull();

      expect(getBlock).not.toHaveBeenCalled();
    });
  });

  describe("B6 — 상태 확인 취소", () => {
    it("취소한 신호를 받으면 원격을 훑지 않고 취소로 끝난다 — 잠금도 푼다", async () => {
      const orchestrator = build();
      const abort = new AbortController();
      abort.abort();

      await expect(orchestrator.status({ signal: abort.signal })).rejects.toThrow("취소됨");

      expect(notion.client.searchRecentPages).not.toHaveBeenCalled();
      expect(notion.client.getChildPagesRecursive).not.toHaveBeenCalled();
      expect(orchestrator.runningOperation).toBeNull();
      await expect(orchestrator.status()).resolves.toMatchObject({ remoteChanges: [] });
    });

    it("훑는 도중 취소하면 바뀐 페이지를 하나씩 읽지 않는다", async () => {
      vault.write("가.md", "가\n");
      vault.write("나.md", "나\n");
      await build().push();
      await build().pull();
      const abort = new AbortController();
      const search = notion.client.searchRecentPages.getMockImplementation()!;
      notion.client.searchRecentPages.mockImplementation(async (...args: never[]) => {
        const found = await search(...args);
        abort.abort();
        return found;
      });
      notion.add(rootId, "다", "본문");
      notion.client.getPage.mockClear();

      await expect(build().status({ signal: abort.signal })).rejects.toThrow("취소됨");

      expect(notion.client.getPage).not.toHaveBeenCalled();
    });

    it("바뀐 페이지를 하나씩 견주는 중에도 취소를 본다", async () => {
      const record = { notionPageId: "page-1" };
      const drift = new RemoteDriftChecker(
        {} as never,
        { getByNotionId: () => record } as never,
        notion.client as never,
        {} as never,
        {} as never,
        {} as never,
      );
      const abort = new AbortController();
      abort.abort();
      const change = { pageId: "page-1", type: "modified", unverified: true } as RemoteChange;

      await expect(drift.withoutUnchangedRemotes([change], abort.signal)).rejects.toThrow("취소됨");
      expect(notion.client.getPage).not.toHaveBeenCalled();
    });
  });

  describe("B7 — 충돌 목록과 작업 잠금", () => {
    it("pull 이 도는 동안 충돌 목록을 읽지 않는다", async () => {
      notion.add(rootId, "글", "본문");
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const markdown = notion.client.getPageMarkdown.getMockImplementation()!;
      notion.client.getPageMarkdown.mockImplementation(async (...args: never[]) => {
        await held;
        return markdown(...args);
      });
      const orchestrator = build();

      const pulling = orchestrator.pull();
      await expect(orchestrator.listConflicts()).rejects.toBeInstanceOf(SyncBusyError);
      release();

      expect(await pulling).toMatchObject({ created: 1, failed: [] });
      await expect(orchestrator.listConflicts()).resolves.toEqual([]);
    });
  });

  describe("B15 — 확장자 `.MD` 노트", () => {
    it.each([
      "노트.md",
      "폴더/노트.MD",
      "폴더/노트.Md",
      "보고서.MD.md",
      "그림.png",
      "폴더/이름 없음",
    ])("경로 → 제목 두 함수가 같은 답을 낸다 — %s", (path) => {
      expect(extractTitle(path)).toBe(wikilinkTitleFromPath(path));
    });

    it("`.MD` 노트를 올리면 제목에 확장자가 붙지 않고, `[[대문자]]` 가 그 노트로 풀린다", async () => {
      vault.write("대문자.MD", "본문\n");
      vault.write("링크.md", "[[대문자]] 를 본다\n");

      expect(await build().push()).toMatchObject({ created: 2, failed: [] });

      const pageId = db.getByPath("대문자.MD")!.notionPageId!;
      expect(notion.pages.get(pageId)!.title).toBe("대문자");
      expect(db.resolveWikilink("대문자")).toMatchObject({ obsidianPath: "대문자.MD" });
    });

    it("CLI 볼트 목록은 `.MD` 를 노트로 보고 첨부로 보지 않는다 — Obsidian 처럼", async () => {
      const root = join(tempDir, "vault");
      await mkdir(root);
      await writeFile(join(root, "대문자.MD"), "본문\n");
      await writeFile(join(root, "그림.png"), "png");
      const fs = new NodeVaultFS(root);

      expect((await fs.listMarkdownFileStats()).map((f) => f.path)).toEqual(["대문자.MD"]);
      expect((await fs.listMarkdownFiles()).map((f) => f.path)).toEqual(["대문자.MD"]);
      expect((await fs.listNonMarkdownFiles()).map((f) => f.path)).toEqual(["그림.png"]);
    });
  });
});
