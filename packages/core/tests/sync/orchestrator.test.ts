import { describe, it, expect, vi, beforeEach } from "vitest";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import type { Config } from "../../src/types/config.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { computeHash } from "../../src/utils/hash.js";
import {
  createMockVaultFs,
  createMockStateDb,
  createMockNotionClient,
  createConfig,
} from "../helpers/mock-orchestrator.js";
import type { WikilinkResolver } from "../../src/notion/property-mapper.js";

describe("SyncOrchestrator", () => {
  let orchestrator: SyncOrchestrator;
  let mockVaultFs: ReturnType<typeof createMockVaultFs>;
  let mockStateDb: ReturnType<typeof createMockStateDb>;
  let mockNotionClient: ReturnType<typeof createMockNotionClient>;
  let config: Config;

  beforeEach(() => {
    mockVaultFs = createMockVaultFs();
    mockStateDb = createMockStateDb();
    mockNotionClient = createMockNotionClient();
    config = createConfig();

    orchestrator = new SyncOrchestrator(
      config,
      mockStateDb as any,
      mockNotionClient as any,
      mockVaultFs,
    );
  });

  describe("M1 — 페이지 모드 relation resolver 배선", () => {
    // 페이지 모드 pull(notionClient.extractProperties)이 raw UUID 대신 [[제목]]으로
    // relation 을 해소하려면, orchestrator 가 생성 시 동일 resolver 를 client 에도
    // 주입해야 한다. 주입이 끊기면 매 pull 마다 relation 이 raw UUID 로 재생성되는
    // 2-write churn 이 재발한다(DB 모드는 자체 mapper 가 면역이라 이 회귀를 못 잡는다).
    const capturedResolver = (): WikilinkResolver =>
      (mockNotionClient.setWikilinkResolver as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as WikilinkResolver;

    it("orchestrator 생성 시 notionClient 에 resolver 를 주입한다", () => {
      expect(mockNotionClient.setWikilinkResolver).toHaveBeenCalledTimes(1);
    });

    it("resolvePageId 는 페이지 id 를 원시 제목이 아니라 파일 basename 으로 해소한다 (M4 SSOT)", () => {
      mockStateDb.resolvePageId.mockReturnValue({
        obsidianPath: "DB/돈키호테 CEO.md",
        notionPageId: "pid-1",
        title: "돈키호테 CEO_", // 원시 제목(끝 언더스코어) — 이것이 아니라 파일명이 쓰여야 함
        aliases: [],
      });
      expect(capturedResolver().resolvePageId("pid-1")).toBe("돈키호테 CEO");
    });

    it("매핑 없는 페이지 id 는 null 을 반환해 후처리 안전망에 위임한다", () => {
      mockStateDb.resolvePageId.mockReturnValue(null);
      expect(capturedResolver().resolvePageId("unknown-id")).toBeNull();
    });

    it("resolve 는 위키링크 제목을 notionPageId 로 해소한다", () => {
      mockStateDb.resolveWikilink.mockReturnValue({
        obsidianPath: "X.md",
        notionPageId: "pid-x",
        title: "X",
        aliases: [],
      });
      expect(capturedResolver().resolve("X")).toBe("pid-x");
    });
  });

  describe("push", () => {
    it("변경 없으면 빈 결과 반환", async () => {
      const result = await orchestrator.push();

      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.deleted).toBe(0);
      expect(result.failed).toHaveLength(0);
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it("새 파일 생성 시 Notion에 페이지 생성", async () => {
      const now = new Date().toISOString();
      (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "new-note.md", mtime: now, size: 100 },
      ]);
      (mockVaultFs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue("# Hello\n\nWorld");

      const result = await orchestrator.push();

      expect(result.created).toBe(1);
      expect(mockNotionClient.createPageWithMarkdown).toHaveBeenCalled();
      expect(mockStateDb.upsert).toHaveBeenCalled();
      expect(mockStateDb.setMeta).toHaveBeenCalledWith("last_push_at", expect.any(String));
    });

    it("수정된 파일 Notion에 업데이트", async () => {
      const now = new Date().toISOString();
      mockStateDb.getByPath.mockReturnValue({
        id: 1,
        obsidianPath: "existing.md",
        notionPageId: "page-123",
        contentHash: "old-hash",
        localMtime: "2020-01-01T00:00:00.000Z",
        localFileSize: 50,
      });

      (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "existing.md", mtime: now, size: 100 },
      ]);
      (mockVaultFs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
        "# Updated\n\nNew content",
      );

      const result = await orchestrator.push();

      expect(result.updated).toBe(1);
      expect(mockNotionClient.replacePageMarkdown).toHaveBeenCalledWith(
        "page-123",
        expect.any(String),
      );
    });

    it("삭제된 파일 Notion에서 아카이브", async () => {
      const deletedRecord = {
        id: 1,
        obsidianPath: "deleted.md",
        notionPageId: "page-del",
        contentHash: "some-hash",
        status: "synced",
      };

      mockStateDb.getByPath.mockImplementation((path: string) =>
        path === "deleted.md" ? deletedRecord : null,
      );
      mockStateDb.getByStatus.mockImplementation((status: string) =>
        status === "synced" ? [deletedRecord] : [],
      );

      (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      config = createConfig({ sync: { ...DEFAULT_CONFIG.sync, deleteSync: true } });
      orchestrator = new SyncOrchestrator(
        config,
        mockStateDb as any,
        mockNotionClient as any,
        mockVaultFs,
      );

      const result = await orchestrator.push();

      expect(result.deleted).toBe(1);
      expect(mockNotionClient.archivePage).toHaveBeenCalledWith("page-del");
      // 레코드 삭제 시 stale wikilink 도 함께 제거한다
      expect(mockStateDb.deleteWikilink).toHaveBeenCalledWith("deleted.md");
    });

    // 회귀 잠금: deleteSync=false 면 로컬 삭제를 Notion 에 전파하지 않는다.
    // archive 호출 없음 + 레코드는 pending 으로만 표시 + deleted 카운트는 0(정직한 보고).
    it("deleteSync=false 면 로컬 삭제를 Notion 에 전파하지 않고 deleted=0", async () => {
      const deletedRecord = {
        id: 7,
        obsidianPath: "keep-remote.md",
        notionPageId: "page-keep",
        contentHash: "some-hash",
        status: "synced",
      };

      mockStateDb.getByPath.mockImplementation((path: string) =>
        path === "keep-remote.md" ? deletedRecord : null,
      );
      mockStateDb.getByStatus.mockImplementation((status: string) =>
        status === "synced" ? [deletedRecord] : [],
      );
      (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      config = createConfig({ sync: { ...DEFAULT_CONFIG.sync, deleteSync: false } });
      orchestrator = new SyncOrchestrator(
        config,
        mockStateDb as any,
        mockNotionClient as any,
        mockVaultFs,
      );

      const result = await orchestrator.push();

      expect(result.deleted).toBe(0);
      expect(mockNotionClient.archivePage).not.toHaveBeenCalled();
      expect(mockStateDb.delete).not.toHaveBeenCalled();
      expect(mockStateDb.deleteWikilink).not.toHaveBeenCalled();
      expect(mockStateDb.updateStatus).toHaveBeenCalledWith(7, "pending");
    });

    it("dryRun 모드에서는 실제 작업 안 하고 예정 수량 반환", async () => {
      const now = new Date().toISOString();
      (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "new.md", mtime: now, size: 50 },
      ]);
      (mockVaultFs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue("# Test");

      const result = await orchestrator.push({ dryRun: true });

      expect(result.created).toBe(1);
      expect(mockNotionClient.createPage).not.toHaveBeenCalled();
    });

    it("paths 필터링 동작", async () => {
      const now = new Date().toISOString();
      (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "notes/a.md", mtime: now, size: 30 },
        { path: "other/b.md", mtime: now, size: 30 },
      ]);
      (mockVaultFs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (p: string) =>
        p === "notes/a.md" ? "# A" : "# B",
      );

      const result = await orchestrator.push({ paths: ["notes/"] });

      expect(result.created).toBe(1);
    });

    it("API 오류 시 failed에 기록", async () => {
      const now = new Date().toISOString();
      (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "bad.md", mtime: now, size: 40 },
      ]);
      (mockVaultFs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue("# Bad");
      mockNotionClient.createPageWithMarkdown.mockRejectedValue(new Error("API limit"));
      mockNotionClient.createPage.mockRejectedValue(new Error("API limit"));

      const result = await orchestrator.push();

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.error).toBe("API limit");
    });

    it("페이지 생성 직후 pending 상태로 매핑을 먼저 기록(원자성)", async () => {
      const now = new Date().toISOString();
      (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "atomic.md", mtime: now, size: 60 },
      ]);
      (mockVaultFs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue("# Atomic\n\nbody");

      await orchestrator.push();

      // 페이지 생성 직후·이미지 업로드/최종 동기화 이전에 notionPageId+pending 으로 선기록해야
      // 한다. 이래야 이후 단계가 실패/크래시해도 다음 시도가 중복 생성이 아닌 업데이트로 이어진다.
      expect(mockStateDb.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          obsidianPath: "atomic.md",
          notionPageId: "page-id-123",
          contentHash: "",
          status: "pending",
        }),
      );
    });

    it("이미 notionPageId 가 매핑된 created 변경은 중복 생성 없이 업데이트로 위임(멱등)", async () => {
      const now = new Date().toISOString();
      (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "idempotent.md", mtime: now, size: 80 },
      ]);
      (mockVaultFs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue("# Idem\n\nbody");

      // 감지 시점엔 레코드가 없어 "created" 로 분류되지만, pushCreate 진입 시점엔
      // 이전 시도가 페이지 생성까지 성공해 notionPageId 가 이미 매핑돼 있다고 가정한다.
      let calls = 0;
      mockStateDb.getByPath.mockImplementation((p: string) => {
        if (p !== "idempotent.md") return null;
        calls++;
        return calls === 1
          ? null
          : {
              id: 1,
              obsidianPath: "idempotent.md",
              notionPageId: "page-id-123",
              contentHash: "",
            };
      });

      const result = await orchestrator.push();

      // 분류상 created 카운트는 유지되지만 새 페이지는 만들지 않고 업데이트 경로로 위임한다.
      expect(result.created).toBe(1);
      expect(mockNotionClient.createPageWithMarkdown).not.toHaveBeenCalled();
      expect(mockNotionClient.replacePageMarkdown).toHaveBeenCalled();
    });
  });

  describe("I12 중단 재개(reconcile)", () => {
    // 중단된 create op + state.notion_page_id=null 상황을 결정론적으로 재현하는 회귀 잠금.
    function incompleteCreateOp(
      path: string,
      parentId = "parent-1",
      title = "note",
    ): Record<string, unknown> {
      return {
        id: "op-1",
        syncStateId: "s-1",
        operation: "create",
        direction: "push",
        payload: JSON.stringify({ path, parentId, title }),
        retryCount: 0,
        errorMessage: null,
        status: "pending",
        createdAt: "2026-05-29T00:00:00Z",
        completedAt: null,
      };
    }

    it("Window A — 고아 페이지를 부모에서 제목으로 찾아 입양(중복 생성 차단)", async () => {
      const path = "recover/orphan.md";
      mockStateDb.getIncompletePendingOperations.mockReturnValue([incompleteCreateOp(path)]);
      // 매핑 전 중단 → state 는 있으나 notionPageId=null.
      mockStateDb.getByPath.mockImplementation((p: string) =>
        p === path ? { id: "s-1", obsidianPath: path, notionPageId: null, contentHash: "" } : null,
      );
      // 부모에 제목이 일치하는 child_page 가 이미 존재(생성은 적용됐던 것).
      mockNotionClient.fetchAllChildren.mockResolvedValue([
        { id: "orphan-page", type: "child_page", child_page: { title: "note" } },
      ]);
      mockNotionClient.getPage.mockResolvedValue({ id: "orphan-page", archived: false });

      await orchestrator.push();

      // 입양: 매핑을 고아 페이지로 채우고 op 완료 처리. 새 페이지는 만들지 않는다.
      expect(mockStateDb.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          obsidianPath: path,
          notionPageId: "orphan-page",
          contentHash: "",
          status: "pending",
        }),
      );
      expect(mockStateDb.markPendingCompleted).toHaveBeenCalledWith("op-1");
      expect(mockStateDb.delete).not.toHaveBeenCalled();
      expect(mockNotionClient.createPageWithMarkdown).not.toHaveBeenCalled();
    });

    it("고아 페이지 미발견 — 자리표시 레코드 제거(다음 push 가 새로 생성)", async () => {
      const path = "recover/missing.md";
      mockStateDb.getIncompletePendingOperations.mockReturnValue([incompleteCreateOp(path)]);
      mockStateDb.getByPath.mockImplementation((p: string) =>
        p === path ? { id: "s-1", obsidianPath: path, notionPageId: null, contentHash: "" } : null,
      );
      // 부모에 일치하는 child_page 없음 → 생성이 적용되지 않았던 것.
      mockNotionClient.fetchAllChildren.mockResolvedValue([]);

      await orchestrator.push();

      expect(mockStateDb.delete).toHaveBeenCalledWith("s-1");
      expect(mockStateDb.markPendingCompleted).not.toHaveBeenCalledWith("op-1");
    });

    it("이미 매핑된 state — 추가 검색 없이 op 완료 처리", async () => {
      const path = "recover/mapped.md";
      mockStateDb.getIncompletePendingOperations.mockReturnValue([incompleteCreateOp(path)]);
      mockStateDb.getByPath.mockImplementation((p: string) =>
        p === path
          ? { id: "s-1", obsidianPath: path, notionPageId: "already-mapped", contentHash: "" }
          : null,
      );

      await orchestrator.push();

      expect(mockStateDb.markPendingCompleted).toHaveBeenCalledWith("op-1");
      // 매핑이 이미 있으므로 고아 검색(fetchAllChildren)을 하지 않는다.
      expect(mockNotionClient.fetchAllChildren).not.toHaveBeenCalled();
      expect(mockStateDb.delete).not.toHaveBeenCalled();
    });

    it("지원하지 않는 op(예: pull/update)는 실패 처리만", async () => {
      mockStateDb.getIncompletePendingOperations.mockReturnValue([
        { ...incompleteCreateOp("x.md"), direction: "pull", operation: "update" },
      ]);

      await orchestrator.push();

      expect(mockStateDb.markPendingFailed).toHaveBeenCalledWith("op-1", expect.any(String));
      expect(mockNotionClient.fetchAllChildren).not.toHaveBeenCalled();
    });
  });

  describe("pull", () => {
    it("원격 변경 없으면 빈 결과", async () => {
      const result = await orchestrator.pull();

      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.deleted).toBe(0);
      expect(result.conflicts).toHaveLength(0);
    });

    it("새 원격 페이지 로컬에 생성", async () => {
      mockNotionClient.getChildPagesRecursive.mockResolvedValue([
        {
          id: "new-page",
          last_edited_time: "2026-01-01T00:00:00.000Z",
          parent: { type: "page_id", page_id: "root-page-id" },
        },
      ]);
      mockNotionClient.getPage.mockResolvedValue({
        id: "new-page",
        last_edited_time: "2026-01-01T00:00:00.000Z",
        parent: { type: "page_id", page_id: "root-page-id" },
        properties: {
          title: { type: "title", title: [{ plain_text: "New Page" }] },
        },
      });
      mockNotionClient.listChildren.mockResolvedValue({ results: [] });

      const result = await orchestrator.pull();

      expect(result.created).toBe(1);
      expect(mockVaultFs.writeFile).toHaveBeenCalled();
      expect(mockStateDb.upsert).toHaveBeenCalled();
    });

    it("수정된 원격 페이지 로컬에 업데이트 (로컬 미변경)", async () => {
      const existingRecord = {
        id: 1,
        obsidianPath: "existing.md",
        notionPageId: "mod-page",
        contentHash: "34a780ad578b997db55b260beb60b501f3e04d30ba1a51fcf43cd8dd1241780d",
        notionLastEdited: "2025-01-01T00:00:00.000Z",
        notionParentId: "root-page-id",
        syncDirection: "both",
        fileType: "file",
        baseSnapshot: Buffer.from("old content"),
      };

      mockStateDb.getByNotionId.mockImplementation((id: string) =>
        id === "mod-page" ? existingRecord : null,
      );
      mockStateDb.getAll.mockReturnValue([existingRecord]);

      mockNotionClient.getChildPagesRecursive.mockResolvedValue([
        {
          id: "mod-page",
          last_edited_time: "2026-06-01T00:00:00.000Z",
          parent: { type: "page_id", page_id: "root-page-id" },
        },
      ]);
      mockNotionClient.getPage.mockResolvedValue({
        id: "mod-page",
        last_edited_time: "2026-06-01T00:00:00.000Z",
        parent: { type: "page_id", page_id: "root-page-id" },
        properties: {
          title: { type: "title", title: [{ plain_text: "Existing" }] },
        },
      });

      mockVaultFs.readFile = vi.fn().mockResolvedValue("old content");

      const result = await orchestrator.pull();

      expect(result.updated).toBe(1);
      expect(mockVaultFs.writeFile).toHaveBeenCalled();
      // pull 업데이트 시 제목/별칭 변경 반영을 위해 wikilink 도 갱신한다
      // (extractTitle 모킹이 전역 "Test Page" 를 반환)
      expect(mockStateDb.upsertWikilink).toHaveBeenCalledWith(
        expect.objectContaining({
          obsidianPath: "existing.md",
          notionPageId: "mod-page",
          title: "Test Page",
        }),
      );
    });

    it("로컬+원격 동시 수정 시 충돌 감지", async () => {
      const existingRecord = {
        id: 1,
        obsidianPath: "conflict.md",
        notionPageId: "conflict-page",
        contentHash: "base-hash",
        notionLastEdited: "2025-01-01T00:00:00.000Z",
        notionParentId: "root-page-id",
        syncDirection: "both",
        fileType: "file",
        baseSnapshot: Buffer.from("base content"),
      };

      mockStateDb.getByNotionId.mockImplementation((id: string) =>
        id === "conflict-page" ? existingRecord : null,
      );
      mockStateDb.getAll.mockReturnValue([existingRecord]);

      mockNotionClient.getChildPagesRecursive.mockResolvedValue([
        {
          id: "conflict-page",
          last_edited_time: "2026-06-01T00:00:00.000Z",
          parent: { type: "page_id", page_id: "root-page-id" },
        },
      ]);
      mockNotionClient.getPage.mockResolvedValue({
        id: "conflict-page",
        last_edited_time: "2026-06-01T00:00:00.000Z",
        parent: { type: "page_id", page_id: "root-page-id" },
        properties: {
          title: { type: "title", title: [{ plain_text: "Conflict" }] },
        },
      });

      mockVaultFs.readFile = vi.fn().mockResolvedValue("locally modified content");

      const result = await orchestrator.pull();

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]!.localContent).toBe("locally modified content");
      expect(mockStateDb.updateStatus).toHaveBeenCalledWith(1, "conflict");
    });

    it("dryRun 모드에서 예정 수량 반환", async () => {
      mockNotionClient.getChildPagesRecursive.mockResolvedValue([
        {
          id: "new-page",
          last_edited_time: "2026-01-01T00:00:00.000Z",
          parent: { type: "page_id", page_id: "root-page-id" },
        },
      ]);

      const result = await orchestrator.pull({ dryRun: true });

      expect(result.created).toBe(1);
      expect(mockVaultFs.writeFile).not.toHaveBeenCalled();
    });

    it("M2: 본문 변경 0·설정 DB 0 이어도 디스커버리된 DB 행에 링크 후처리를 실행한다", async () => {
      // 본문 변경 없음 + 설정 DB 없음 → 디스커버리 전용 조기 반환 경로.
      // 과거엔 이 경로가 resolveNotionLinks 를 건너뛰어, 디스커버리된 행의 본문 링크·
      // frontmatter relation 이 UUID 그대로 남았다(M2). finalize() 가 기록된 경로로
      // 반드시 후처리를 돌려야 한다.
      const resolveSpy = vi
        .spyOn(
          orchestrator as unknown as { resolveNotionLinks: (p: string[]) => Promise<number> },
          "resolveNotionLinks",
        )
        .mockResolvedValue(3);
      vi.spyOn(
        orchestrator as unknown as {
          pullDiscoveredDatabases: (w: string[]) => Promise<{ created: number; updated: number }>;
        },
        "pullDiscoveredDatabases",
      ).mockImplementation(async (wp: string[]) => {
        wp.push("databases/wiki/Row.md");
        return { created: 1, updated: 0 };
      });

      const result = await orchestrator.pull();

      expect(resolveSpy).toHaveBeenCalledWith(["databases/wiki/Row.md"]);
      expect(result.created).toBe(1);
      expect(result.linkCount).toBe(3);
      expect(result.writtenPaths).toEqual(["databases/wiki/Row.md"]);
    });

    it("M2: 디스커버리 기록이 0건이면 후처리를 호출하지 않고 빈 결과로 마감한다", async () => {
      const resolveSpy = vi
        .spyOn(
          orchestrator as unknown as { resolveNotionLinks: (p: string[]) => Promise<number> },
          "resolveNotionLinks",
        )
        .mockResolvedValue(0);
      vi.spyOn(
        orchestrator as unknown as {
          pullDiscoveredDatabases: (w: string[]) => Promise<{ created: number; updated: number }>;
        },
        "pullDiscoveredDatabases",
      ).mockResolvedValue({ created: 0, updated: 0 });

      const result = await orchestrator.pull();

      expect(resolveSpy).not.toHaveBeenCalled();
      expect(result.created).toBe(0);
      expect(result.linkCount).toBe(0);
    });
  });

  describe("sync", () => {
    it("pull + push 순서로 실행", async () => {
      const result = await orchestrator.sync();

      expect(result.pull).toBeDefined();
      expect(result.push).toBeDefined();
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it("sync 결과에 pull conflicts 전달", async () => {
      const result = await orchestrator.sync();

      expect(result.conflicts).toEqual([]);
      expect(result.pull.conflicts).toEqual([]);
    });
  });

  describe("status", () => {
    it("현재 상태 반환", async () => {
      const result = await orchestrator.status();

      expect(result.localChanges).toEqual([]);
      expect(result.remoteChanges).toEqual([]);
      expect(result.conflicts).toEqual([]);
      expect(result.conflictRecords).toEqual([]);
      expect(result.pendingOperations).toBe(0);
      expect(result.lastSyncAt).toBeNull();
    });

    it("충돌 레코드가 있으면 conflicts 배열에 반영", async () => {
      const conflictRecord = {
        id: "rec-1",
        obsidianPath: "conflict-note.md",
        notionPageId: "page-conflict",
        notionParentId: "parent-1",
        contentHash: "hash-old",
        notionLastEdited: "2026-01-01T00:00:00.000Z",
        localLastModified: "2026-01-01T00:00:00.000Z",
        syncDirection: "both" as const,
        fileType: "file" as const,
        status: "conflict" as const,
        baseSnapshot: Buffer.from("base content"),
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };

      mockStateDb.getByStatus.mockReturnValue([conflictRecord]);

      const result = await orchestrator.status();

      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]!.syncRecord).toBe(conflictRecord);
      expect(result.conflicts[0]!.baseContent).toBe("base content");
      expect(result.conflicts[0]!.localContent).toBe("# Test\n\nContent");
      expect(result.conflictRecords).toHaveLength(1);
      expect(result.pendingOperations).toBe(1);
    });

    it("lastSyncAt 값이 있으면 반환", async () => {
      mockStateDb.getMeta.mockImplementation((key: string) =>
        key === "last_sync_at" ? "2026-05-10T12:00:00.000Z" : null,
      );

      const result = await orchestrator.status();

      expect(result.lastSyncAt).toBe("2026-05-10T12:00:00.000Z");
    });

    it("로컬 변경사항 감지", async () => {
      mockVaultFs.listMarkdownFiles = vi
        .fn()
        .mockResolvedValue([
          { path: "new-note.md", content: "# New", mtime: new Date().toISOString() },
        ]);

      const result = await orchestrator.status();

      expect(result.localChanges).toHaveLength(1);
      expect(result.localChanges[0]!.path).toBe("new-note.md");
      expect(result.localChanges[0]!.type).toBe("created");
    });
  });

  describe("push - 폴더 계층", () => {
    it("하위 폴더 파일 push 시 폴더 페이지 생성", async () => {
      const now = new Date().toISOString();
      (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "projects/deep/note.md", mtime: now, size: 80 },
      ]);
      (mockVaultFs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue("# Deep Note");

      mockNotionClient.listChildren.mockResolvedValue({ results: [] });

      const result = await orchestrator.push();

      expect(result.created).toBe(1);
      expect(mockNotionClient.createPageWithMarkdown).toHaveBeenCalled();
    });

    it("다중 파일 동시 push", async () => {
      const now = new Date().toISOString();
      (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "a.md", mtime: now, size: 30 },
        { path: "b.md", mtime: now, size: 30 },
        { path: "c.md", mtime: now, size: 30 },
      ]);
      (mockVaultFs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (p: string) => {
        const map: Record<string, string> = { "a.md": "# A", "b.md": "# B", "c.md": "# C" };
        return map[p] ?? "";
      });

      const result = await orchestrator.push();

      expect(result.created).toBe(3);
      expect(mockNotionClient.createPageWithMarkdown).toHaveBeenCalledTimes(3);
    });
  });

  describe("sync.direction 설정", () => {
    it("direction=pull이면 push가 실행되지 않음", async () => {
      const pullOnlyConfig = {
        ...DEFAULT_CONFIG,
        notion: { ...DEFAULT_CONFIG.notion, token: "ntn_test", rootPageId: "root-id" },
        sync: { ...DEFAULT_CONFIG.sync, direction: "pull" as const },
      };

      const pullOnlyOrchestrator = new SyncOrchestrator(
        pullOnlyConfig,
        mockStateDb as never,
        mockNotionClient as never,
        mockVaultFs,
      );

      const now = new Date().toISOString();
      (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "new.md", mtime: now, size: 30 },
      ]);
      (mockVaultFs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue("# New");

      const result = await pullOnlyOrchestrator.push();

      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.deleted).toBe(0);
      expect(mockNotionClient.createPageWithMarkdown).not.toHaveBeenCalled();
    });

    it("direction=push이면 pull이 실행되지 않음", async () => {
      const pushOnlyConfig = {
        ...DEFAULT_CONFIG,
        notion: { ...DEFAULT_CONFIG.notion, token: "ntn_test", rootPageId: "root-id" },
        sync: { ...DEFAULT_CONFIG.sync, direction: "push" as const },
      };

      const pushOnlyOrchestrator = new SyncOrchestrator(
        pushOnlyConfig,
        mockStateDb as never,
        mockNotionClient as never,
        mockVaultFs,
      );

      mockNotionClient.getChildPagesRecursive.mockResolvedValue([
        { id: "new-page", last_edited_time: "2026-01-01T00:00:00.000Z" },
      ]);

      const result = await pushOnlyOrchestrator.pull();

      expect(result.created).toBe(0);
      expect(mockVaultFs.writeFile).not.toHaveBeenCalled();
    });
  });

  describe("force 옵션", () => {
    it("force=true이면 충돌 파일도 push", async () => {
      mockStateDb.getByStatus.mockReturnValue([
        { obsidianPath: "conflict.md", notionPageId: "page-c", id: "rec-c", status: "conflict" },
      ]);

      const now = new Date().toISOString();
      (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "conflict.md", mtime: now, size: 60 },
      ]);
      (mockVaultFs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue("# Conflict");

      const result = await orchestrator.push({ force: true });

      expect(result.created).toBe(1);
    });
  });

  describe("dryRun 실제 수량", () => {
    it("push dryRun — created/updated/deleted 수량 반환", async () => {
      const now = new Date().toISOString();
      (mockVaultFs.listMarkdownFileStats as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "new1.md", mtime: now, size: 40 },
        { path: "new2.md", mtime: now, size: 40 },
      ]);
      (mockVaultFs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (p: string) =>
        p === "new1.md" ? "# New1" : "# New2",
      );

      const result = await orchestrator.push({ dryRun: true });

      expect(result.created).toBe(2);
      expect(result.updated).toBe(0);
      expect(result.deleted).toBe(0);
      expect(mockNotionClient.createPageWithMarkdown).not.toHaveBeenCalled();
    });
  });

  describe("in_progress 클린업", () => {
    it("push 시작 시 이전 중단된 플래그 정리", async () => {
      mockStateDb.getMeta.mockImplementation((key: string) => {
        if (key === "push_in_progress") return "true";
        return null;
      });

      await orchestrator.push();

      expect(mockStateDb.setMeta).toHaveBeenCalledWith("push_in_progress", "");
    });
  });
});

// 수정1 잠금: resolveNotionLinks 가 디스크 내용을 위키링크 형태로 재작성한 뒤
// 해당 sync record 의 해시·stat 을 새 내용으로 동기화해야 한다. 이걸 빠뜨리면
// 디스크(`[[Title]]`)와 저장 해시(`/p/<id>`)가 영구 불일치해 매 sync 마다 "modified"
// 로 오검지되는 fixpoint 위반(I5)이 발생한다(폴더노트 무한 churn 의 근본 원인).
describe("SyncOrchestrator.resolveNotionLinks 해시 동기화 (I5 fixpoint 잠금)", () => {
  it("링크 재작성 후 record 해시를 디스크 내용 해시로 갱신한다", async () => {
    const targetId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // 32 hex
    const sourceRec = {
      id: 1,
      obsidianPath: "source.md",
      notionPageId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    };
    const targetRec = { id: 2, obsidianPath: "Target.md", notionPageId: targetId };

    const original =
      "# Source\n\n" +
      `[[notion:${targetId}]] 그리고 ` +
      `[링크텍스트](/p/${targetId}?pvs=4) 참조.\n`;

    let written = "";
    const vaultFs = createMockVaultFs();
    (vaultFs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(original);
    (vaultFs.writeFile as ReturnType<typeof vi.fn>).mockImplementation(
      async (_path: string, content: string) => {
        written = content;
      },
    );
    (vaultFs.getFileStat as ReturnType<typeof vi.fn>).mockResolvedValue({
      mtime: "2026-05-30T00:00:00.000Z",
      size: 999,
    });

    const stateDb = createMockStateDb();
    stateDb.getAll.mockReturnValue([sourceRec, targetRec]);
    stateDb.getByPath.mockImplementation((p: string) => (p === "source.md" ? sourceRec : null));

    const orchestrator = new SyncOrchestrator(
      createConfig(),
      stateDb as any,
      createMockNotionClient() as any,
      vaultFs,
    );

    const resolved = await (
      orchestrator as unknown as { resolveNotionLinks(paths: string[]): Promise<number> }
    ).resolveNotionLinks(["source.md"]);

    // 두 링크 형태(`[[notion:id]]`, `/p/<id>`) 모두 위키링크로 해소
    expect(resolved).toBe(2);
    expect(written).toContain("[[Target]]");
    expect(written).toContain("[[Target|링크텍스트]]");
    expect(written).not.toContain("notion:");
    expect(written).not.toContain("/p/");

    // 핵심 잠금: 저장 해시가 디스크에 쓴 바로 그 내용의 해시와 일치 → 다음 detect 시 "modified" 아님
    expect(stateDb.updateHash).toHaveBeenCalledTimes(1);
    expect(stateDb.updateHash).toHaveBeenCalledWith(
      sourceRec.id,
      computeHash(written),
      expect.any(Buffer),
    );
    // stat 캐시도 새 파일 stat 으로 동기화 (mtime+size 빠른 경로 일치)
    expect(stateDb.updateStatCache).toHaveBeenCalledWith(
      sourceRec.id,
      "2026-05-30T00:00:00.000Z",
      999,
    );
  });

  it("변경 없는 파일은 write/해시 갱신을 하지 않는다(불필요한 churn 방지)", async () => {
    const stateDb = createMockStateDb();
    stateDb.getAll.mockReturnValue([
      { id: 1, obsidianPath: "plain.md", notionPageId: "cccccccccccccccccccccccccccccccc" },
    ]);
    const vaultFs = createMockVaultFs();
    (vaultFs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue("# Plain\n\n링크 없음.\n");

    const orchestrator = new SyncOrchestrator(
      createConfig(),
      stateDb as any,
      createMockNotionClient() as any,
      vaultFs,
    );

    const resolved = await (
      orchestrator as unknown as { resolveNotionLinks(paths: string[]): Promise<number> }
    ).resolveNotionLinks(["plain.md"]);

    expect(resolved).toBe(0);
    expect(vaultFs.writeFile).not.toHaveBeenCalled();
    expect(stateDb.updateHash).not.toHaveBeenCalled();
    expect(stateDb.updateStatCache).not.toHaveBeenCalled();
  });
});

// 수정2 잠금: child page/database 를 보유한 페이지의 본문 push 는 자식을 삭제하지
// 않도록 가드된다(실Notion probe 확인: replace_content[allow_deleting_content] 와
// block 삭제-후-append 경로 모두 자식 child_page 를 in_trash 로 삭제). 가드는 본문
// 갱신을 건너뛰고 destructive API 를 호출하지 않는다.
describe("SyncOrchestrator.pushUpdatePage 자식 삭제 가드 (데이터 손실 방지)", () => {
  it("자식 페이지 보유 시 replacePageMarkdown/deleteBlock 을 호출하지 않는다", async () => {
    const notion = createMockNotionClient();
    // 직속 자식에 child_page 1개 존재
    (notion.fetchAllChildren as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "leaf-1", type: "child_page" },
    ]);

    const orchestrator = new SyncOrchestrator(
      createConfig(),
      createMockStateDb() as any,
      notion as any,
      createMockVaultFs(),
    );

    await (
      orchestrator as unknown as {
        pushUpdatePage(id: string, md: string): Promise<void>;
      }
    ).pushUpdatePage("hub-page", "# Hub\n\n수정된 본문.\n");

    // 파괴적 본문 갱신 경로(둘 다)를 절대 타지 않아야 한다
    expect(notion.replacePageMarkdown).not.toHaveBeenCalled();
    expect(notion.deleteBlock).not.toHaveBeenCalled();
    expect(notion.appendChildren).not.toHaveBeenCalled();
  });

  it("자식이 없으면 정상적으로 replacePageMarkdown 으로 본문을 갱신한다", async () => {
    const notion = createMockNotionClient();
    (notion.fetchAllChildren as ReturnType<typeof vi.fn>).mockResolvedValue([]); // 자식 없음

    const orchestrator = new SyncOrchestrator(
      createConfig(),
      createMockStateDb() as any,
      notion as any,
      createMockVaultFs(),
    );

    await (
      orchestrator as unknown as {
        pushUpdatePage(id: string, md: string): Promise<void>;
      }
    ).pushUpdatePage("leaf-page", "# Leaf\n\n본문.\n");

    expect(notion.replacePageMarkdown).toHaveBeenCalledTimes(1);
  });
});

describe("SyncOrchestrator — 접근불가 링크드 DB graceful degrade (결함9)", () => {
  type Privates = {
    buildDiscoveredDbConfig(
      dbId: string,
      parentPageId: string,
    ): Promise<
      | { kind: "ok"; config: { databaseId: string; localFolder: string; titleProperty: string } }
      | { kind: "inaccessible" }
      | { kind: "error" }
    >;
    pullDiscoveredDatabases(w: string[], f: unknown[], c: unknown[]): Promise<unknown>;
  };

  function makeOrchestrator(stateDb?: ReturnType<typeof createMockStateDb>) {
    const notion = createMockNotionClient();
    const sdb = stateDb ?? createMockStateDb();
    const orch = new SyncOrchestrator(
      createConfig(),
      sdb as any,
      notion as any,
      createMockVaultFs(),
    );
    return { orch: orch as unknown as Privates, notion, sdb };
  }

  describe("layer 1 — 발견 단계 선제 차단 (buildDiscoveredDbConfig)", () => {
    it("queryable=true 면 kind=ok + 폴더 설정 생성", async () => {
      const { orch, notion } = makeOrchestrator();
      notion.getDatabaseSyncability.mockResolvedValue({ title: "프로덕트 위키", queryable: true });
      const out = await orch.buildDiscoveredDbConfig("db-ok", "");
      expect(out.kind).toBe("ok");
      if (out.kind === "ok") {
        expect(out.config.databaseId).toBe("db-ok");
        expect(out.config.localFolder).toContain("위키"); // sanitize 후 제목 반영
      }
    });

    it("queryable=false + linked 해소 실패(미공유 등) 면 kind=inaccessible — 빈 폴더/.base 오염 방지", async () => {
      const { orch, notion } = makeOrchestrator();
      notion.getDatabaseSyncability.mockResolvedValue({ title: "링크드", queryable: false });
      const out = await orch.buildDiscoveredDbConfig("db-linked", "");
      expect(out.kind).toBe("inaccessible");
    });

    it("queryable=false 라도 linked view 가 해소되면 kind=linked 로 원본 id 를 전달(F22)", async () => {
      const { orch, notion } = makeOrchestrator();
      notion.getDatabaseSyncability.mockResolvedValue({ title: "", queryable: false });
      notion.resolveLinkedDatabase.mockResolvedValue({
        originalDbId: "db-orig",
        viewName: "Project 갤러리",
      });
      const out = await orch.buildDiscoveredDbConfig("db-linked", "");
      expect(out.kind).toBe("linked");
      if (out.kind === "linked") expect(out.originalDbId).toBe("db-orig");
    });

    it("404(삭제된 DB) 면 kind=inaccessible — 재시도하지 않음", async () => {
      const { orch, notion } = makeOrchestrator();
      notion.getDatabaseSyncability.mockRejectedValue({ code: "object_not_found", status: 404 });
      const out = await orch.buildDiscoveredDbConfig("db-deleted", "");
      expect(out.kind).toBe("inaccessible");
    });

    it("일시/실제 오류(500)는 kind=error — 다음 pull 에 재시도 여지", async () => {
      const { orch, notion } = makeOrchestrator();
      notion.getDatabaseSyncability.mockRejectedValue({ status: 500 });
      const out = await orch.buildDiscoveredDbConfig("db-flaky", "");
      expect(out.kind).toBe("error");
    });
  });

  describe("layer 2 — 쿼리 시점 방어/자가정리 (pullDiscoveredDatabases)", () => {
    it("캐시에 있던 DB 가 행 조회 404 면 denylist 등록 + discovered_dbs 에서 제거", async () => {
      const sdb = createMockStateDb();
      const meta: Record<string, string | null> = {
        discovered_dbs: JSON.stringify([
          { databaseId: "db-linked", localFolder: "p/db-linked", titleProperty: "Name" },
        ]),
        inaccessible_dbs: null,
      };
      sdb.getMeta.mockImplementation((key: string) => meta[key] ?? null);
      const setMetaCalls: Array<[string, string]> = [];
      sdb.setMeta.mockImplementation((k: string, v: string) => {
        setMetaCalls.push([k, v]);
      });

      const { orch, notion } = makeOrchestrator(sdb);
      // 행 조회가 404 → pullDatabase 가 throw → orchestrator 가 404 로 강등
      notion.queryAllDatabasePages.mockRejectedValue({ code: "object_not_found", status: 404 });

      await orch.pullDiscoveredDatabases([], [], []);

      const inaccessibleWrite = setMetaCalls.find(([k]) => k === "inaccessible_dbs");
      expect(inaccessibleWrite).toBeDefined();
      expect(JSON.parse(inaccessibleWrite![1])).toContain("dblinked"); // 하이픈 정규화 저장

      const discoveredWrite = setMetaCalls.filter(([k]) => k === "discovered_dbs").pop();
      expect(discoveredWrite).toBeDefined();
      expect(JSON.parse(discoveredWrite![1])).toEqual([]); // 접근불가 DB 가 캐시에서 제거됨
    });

    it("이미 denylist 에 있는 DB 는 행 조회조차 시도하지 않음(노이즈 0)", async () => {
      const sdb = createMockStateDb();
      const meta: Record<string, string | null> = {
        discovered_dbs: JSON.stringify([
          { databaseId: "db-linked", localFolder: "p/db-linked", titleProperty: "Name" },
        ]),
        inaccessible_dbs: JSON.stringify(["dblinked"]),
      };
      sdb.getMeta.mockImplementation((key: string) => meta[key] ?? null);

      const { orch, notion } = makeOrchestrator(sdb);
      await orch.pullDiscoveredDatabases([], [], []);

      // denylist 에 있으므로 pullDatabase 경로(schema/query) 진입 안 함
      expect(notion.queryAllDatabasePages).not.toHaveBeenCalled();
      expect(notion.getDatabaseSchema).not.toHaveBeenCalled();
    });

    it("404 가 아닌 실제 오류는 denylist 에 넣지 않고 캐시에 유지(재시도 보존)", async () => {
      const sdb = createMockStateDb();
      const meta: Record<string, string | null> = {
        discovered_dbs: JSON.stringify([
          { databaseId: "db-flaky", localFolder: "p/db-flaky", titleProperty: "Name" },
        ]),
        inaccessible_dbs: null,
      };
      sdb.getMeta.mockImplementation((key: string) => meta[key] ?? null);
      const setMetaCalls: Array<[string, string]> = [];
      sdb.setMeta.mockImplementation((k: string, v: string) => {
        setMetaCalls.push([k, v]);
      });

      const { orch, notion } = makeOrchestrator(sdb);
      notion.queryAllDatabasePages.mockRejectedValue({ status: 500 }); // 일시 오류

      await orch.pullDiscoveredDatabases([], [], []);

      expect(setMetaCalls.find(([k]) => k === "inaccessible_dbs")).toBeUndefined();
      // 캐시 재기록이 일어나도 flaky DB 는 유지되어야 한다(빈 배열로 제거 금지)
      const discoveredWrite = setMetaCalls.filter(([k]) => k === "discovered_dbs").pop();
      if (discoveredWrite) {
        expect(JSON.parse(discoveredWrite[1])).toHaveLength(1);
      }
    });
  });
});

describe("SyncOrchestrator — linked view 컨테이너 이중 pull 해소 (F25)", () => {
  // 신 API(2025-09-03)에서 원본이 공유 범위에 있으면 linked view 컨테이너도
  // databases.retrieve 가 성공하고 data_sources 가 채워져 와, queryable 판정만으로는
  // 원본처럼 캐시에 오등록된다(실측 8개). 같은 data source 를 2~4개 config 가 각각
  // pull 하며 행을 폴더 릴레이 재배치해 steady churn(매 pull 66 updated)을 만들었다.
  type Privates = {
    buildDiscoveredDbConfig(
      dbId: string,
      parentPageId: string,
    ): Promise<
      | { kind: "ok"; config: { databaseId: string; localFolder: string; titleProperty: string } }
      | { kind: "linked"; originalDbId: string }
      | { kind: "inaccessible" }
      | { kind: "error" }
    >;
    pullDiscoveredDatabases(w: string[], f: unknown[], c: unknown[]): Promise<unknown>;
  };

  function makeOrchestrator(stateDb?: ReturnType<typeof createMockStateDb>) {
    const notion = createMockNotionClient();
    const sdb = stateDb ?? createMockStateDb();
    const orch = new SyncOrchestrator(
      createConfig(),
      sdb as any,
      notion as any,
      createMockVaultFs(),
    );
    return { orch: orch as unknown as Privates, notion, sdb };
  }

  it("발견 단계: queryable=true 라도 ds 소유자가 다르면 kind=linked 로 원본 id 전달", async () => {
    const { orch, notion } = makeOrchestrator();
    notion.getDatabaseSyncability.mockResolvedValue({
      title: "습관-목록",
      queryable: true,
      linkedOriginalDbId: "db-orig",
    });
    const out = await orch.buildDiscoveredDbConfig("db-linked", "");
    expect(out.kind).toBe("linked");
    if (out.kind === "linked") expect(out.originalDbId).toBe("db-orig");
  });

  it("pull 단계 자가 치유: 캐시의 컨테이너가 행 parent 로 판정되면 캐시 제거 + linked_dbs 매핑 기록", async () => {
    const sdb = createMockStateDb();
    const meta: Record<string, string | null> = {
      discovered_dbs: JSON.stringify([
        { databaseId: "db-orig", localFolder: "루틴/목록", titleProperty: "Name" },
        { databaseId: "db-linked", localFolder: "루틴/습관-목록", titleProperty: "Name" },
      ]),
    };
    sdb.getMeta.mockImplementation((key: string) => meta[key] ?? null);
    const setMetaCalls: Array<[string, string]> = [];
    sdb.setMeta.mockImplementation((k: string, v: string) => {
      setMetaCalls.push([k, v]);
    });

    const { orch, notion } = makeOrchestrator(sdb);
    // 컨테이너(db-linked)의 행 parent 가 원본(db-orig)을 가리킨다 — 추가 API 0회 판정 근거.
    notion.queryAllDatabasePages.mockImplementation(async (dbId: string) =>
      dbId === "db-linked"
        ? [
            {
              id: "row-1",
              parent: { type: "data_source_id", data_source_id: "ds-1", database_id: "db-orig" },
              last_edited_time: "2026-01-01T00:00:00.000Z",
              properties: {},
            },
          ]
        : [],
    );

    await orch.pullDiscoveredDatabases([], [], []);

    // 컨테이너는 캐시에서 제거되고 원본만 남는다 — 다음 pull 부터 이중 방문 자체가 소멸.
    const discoveredWrite = setMetaCalls.filter(([k]) => k === "discovered_dbs").pop();
    expect(discoveredWrite).toBeDefined();
    const remaining = JSON.parse(discoveredWrite![1]) as Array<{ databaseId: string }>;
    expect(remaining.map((c) => c.databaseId)).toEqual(["db-orig"]);

    // 컨테이너 → 원본 매핑 기록(placeholder 임베드가 원본 .base 로 향하게).
    const linkedWrite = setMetaCalls.filter(([k]) => k === "linked_dbs").pop();
    expect(linkedWrite).toBeDefined();
    expect(JSON.parse(linkedWrite![1])).toEqual({ dblinked: "dborig" });
  });

  it("원본이 캐시/설정에 없으면 컨테이너가 행을 계속 소유(유일 통로 폴백) — 캐시·매핑 불변", async () => {
    const sdb = createMockStateDb();
    const meta: Record<string, string | null> = {
      discovered_dbs: JSON.stringify([
        { databaseId: "db-linked", localFolder: "루틴/습관-목록", titleProperty: "Name" },
      ]),
    };
    sdb.getMeta.mockImplementation((key: string) => meta[key] ?? null);
    const setMetaCalls: Array<[string, string]> = [];
    sdb.setMeta.mockImplementation((k: string, v: string) => {
      setMetaCalls.push([k, v]);
    });

    const { orch, notion } = makeOrchestrator(sdb);
    notion.queryAllDatabasePages.mockResolvedValue([
      {
        id: "row-1",
        parent: { type: "data_source_id", data_source_id: "ds-1", database_id: "db-orig" },
        last_edited_time: "2026-01-01T00:00:00.000Z",
        properties: {},
      },
    ]);

    await orch.pullDiscoveredDatabases([], [], []);

    // 정상 pull 경로 진입(행 소유 유지) — 스키마 로드가 그 증거.
    expect(notion.getDatabaseSchema).toHaveBeenCalledWith("db-linked");
    // linked 매핑은 기록하지 않고, 캐시 재기록이 있어도 컨테이너는 유지된다.
    expect(setMetaCalls.find(([k]) => k === "linked_dbs")).toBeUndefined();
    const discoveredWrite = setMetaCalls.filter(([k]) => k === "discovered_dbs").pop();
    if (discoveredWrite) {
      const remaining = JSON.parse(discoveredWrite[1]) as Array<{ databaseId: string }>;
      expect(remaining.map((c) => c.databaseId)).toContain("db-linked");
    }
  });
});

describe("SyncOrchestrator — 인라인 DB 임베드 재작성 마감 (F22 잔여)", () => {
  const A32 = "a".repeat(32);
  const B32 = "b".repeat(32);
  const marker = (id: string, title: string) =>
    `%%im-nobsidian:child-database:id=${id}&title=${encodeURIComponent(title)}%%`;

  type Privates = {
    rewriteDbPlaceholderEmbeds(
      paths: string[],
      dbConfigs: Array<{ databaseId: string; localFolder: string }>,
      linkedMap: Map<string, string>,
    ): Promise<void>;
    pullDiscoveredDatabases(w: string[], f: unknown[], c: unknown[]): Promise<unknown>;
    buildDiscoveredDbConfig(
      dbId: string,
      parentPageId: string,
    ): Promise<{ kind: string; config?: { localFolder: string } }>;
    databaseSyncer: {
      baseFileInfo: Map<string, { basePath: string; title: string }>;
      pullDatabase: (cfg: unknown) => Promise<unknown>;
    };
  };

  function make(stateDb?: ReturnType<typeof createMockStateDb>) {
    const notion = createMockNotionClient();
    const sdb = stateDb ?? createMockStateDb();
    const vaultFs = createMockVaultFs();
    const orch = new SyncOrchestrator(createConfig(), sdb as any, notion as any, vaultFs);
    return { orch: orch as unknown as Privates, notion, sdb, vaultFs };
  }

  it("재작성은 DatabaseSyncer 가 실제 기록한 .base 경로(baseFileInfo)를 쓴다 — 폴더명 추측 금지", async () => {
    const { orch, sdb, vaultFs } = make();
    // 폴더명은 "0-인박스"(하이픈 새니타이즈), 실제 .base 는 "0. 인박스.base"(제목 보존)
    orch.databaseSyncer.baseFileInfo.set(A32, {
      basePath: "para/0-인박스/0. 인박스.base",
      title: "0. 인박스",
    });
    (vaultFs.exists as ReturnType<typeof vi.fn>).mockImplementation((p: string) =>
      Promise.resolve(p === "para/0-인박스/0. 인박스.base"),
    );
    (vaultFs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      `# 노트\n\n**0. 인박스** *(Notion DB)*${marker(A32, "0. 인박스")}\n`,
    );
    (sdb.getByPath as ReturnType<typeof vi.fn>).mockReturnValue(null);

    await orch.rewriteDbPlaceholderEmbeds(
      ["page.md"],
      [{ databaseId: A32, localFolder: "para/0-인박스" }],
      new Map(),
    );

    const write = (vaultFs.writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
      ([p]) => p === "page.md",
    );
    expect(write).toBeDefined();
    expect(write![1]).toContain("![[para/0-인박스/0. 인박스.base|0. 인박스]]");
    expect(write![1]).not.toContain("0-인박스/0-인박스.base"); // 추측 경로 회귀 방지
  });

  it(".base 가 디스크에 없으면 재작성하지 않고 placeholder 를 마커째 보존한다", async () => {
    const { orch, vaultFs } = make();
    (vaultFs.exists as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (vaultFs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue(
      `**목록** *(Notion DB)*${marker(A32, "목록")}\n`,
    );

    await orch.rewriteDbPlaceholderEmbeds(
      ["page.md"],
      [{ databaseId: A32, localFolder: "p/목록" }],
      new Map(),
    );

    expect(vaultFs.writeFile).not.toHaveBeenCalled();
  });

  it("DB row 본문에 중첩된 child DB 를 라운드 반복으로 발견·등록·동기화한다", async () => {
    const sdb = createMockStateDb();
    const meta: Record<string, string | null> = {
      discovered_dbs: JSON.stringify([
        { databaseId: "db-a", localFolder: "p/db-a", titleProperty: "Name" },
      ]),
    };
    sdb.getMeta.mockImplementation((key: string) => meta[key] ?? null);
    const setMetaCalls: Array<[string, string]> = [];
    sdb.setMeta.mockImplementation((k: string, v: string) => {
      setMetaCalls.push([k, v]);
    });
    // row md → Notion 페이지 역조회(발견된 DB 의 부모가 되는 row 페이지)
    sdb.getByPath.mockImplementation((p: string) =>
      p === "p/db-a/row.md" ? { id: 5, notionPageId: "row-page-1", obsidianPath: p } : null,
    );
    sdb.getByNotionId.mockImplementation((id: string) =>
      id === "row-page-1" ? { obsidianPath: "p/db-a/row.md" } : null,
    );

    const { orch, notion, vaultFs } = make(sdb);
    notion.getDatabaseSyncability.mockResolvedValue({ title: "중첩 DB", queryable: true });
    (vaultFs.readFile as ReturnType<typeof vi.fn>).mockImplementation((p: string) =>
      Promise.resolve(
        p === "p/db-a/row.md" ? `본문\n\n**중첩 DB** *(Notion DB)*${marker(B32, "중첩 DB")}\n` : "",
      ),
    );
    const pullDatabase = vi
      .spyOn(orch.databaseSyncer, "pullDatabase")
      .mockResolvedValueOnce({
        created: 1,
        updated: 0,
        conflicts: [],
        failed: [],
        writtenPaths: ["p/db-a/row.md"],
      })
      .mockResolvedValue({
        created: 0,
        updated: 0,
        conflicts: [],
        failed: [],
        writtenPaths: [],
      });

    await orch.pullDiscoveredDatabases([], [], []);

    // 라운드 1: db-a 동기화 → row.md 스캔 → B32 발견 → 라운드 2: 중첩 DB 동기화
    expect(pullDatabase).toHaveBeenCalledTimes(2);
    const second = pullDatabase.mock.calls[1]![0] as { databaseId: string; localFolder: string };
    expect(second.databaseId.replace(/-/g, "")).toBe(B32);
    // row 파일은 folder note 가 아니므로 페이지명 하위로 중첩(형제 row 동명 DB 충돌 방지)
    expect(second.localFolder).toBe("p/db-a/row/중첩-DB");

    const discoveredWrite = setMetaCalls.filter(([k]) => k === "discovered_dbs").pop();
    expect(discoveredWrite).toBeDefined();
    expect(JSON.parse(discoveredWrite![1])).toHaveLength(2);
  });

  it("buildDiscoveredDbConfig — folder note 부모는 기존 폴더, 플레인 md 부모는 페이지명 하위로", async () => {
    const { orch, notion, sdb } = make();
    notion.getDatabaseSyncability.mockResolvedValue({ title: "회고", queryable: true });

    sdb.getByNotionId.mockReturnValue({ obsidianPath: "OKR/Key-Results/1주차.md" });
    const row = await orch.buildDiscoveredDbConfig("db-x", "row-1");
    expect(row.kind).toBe("ok");
    expect(row.config?.localFolder).toBe("OKR/Key-Results/1주차/회고");

    sdb.getByNotionId.mockReturnValue({ obsidianPath: "AI Engineer/AI Engineer.md" });
    const note = await orch.buildDiscoveredDbConfig("db-y", "page-1");
    expect(note.config?.localFolder).toBe("AI Engineer/회고");
  });
});
