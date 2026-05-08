import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConflictResolver } from "../../src/conflict/resolver.js";
import type { Conflict, SyncRecord } from "../../src/types/sync.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";

function createMockVaultFs(): VaultFS {
  return {
    readFile: vi.fn().mockResolvedValue(""),
    writeFile: vi.fn().mockResolvedValue(undefined),
    writeBinary: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    moveFile: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
    ensureFolder: vi.fn().mockResolvedValue(undefined),
    listMarkdownFiles: vi.fn().mockResolvedValue([]),
  };
}

function createMockStateDb() {
  return {
    updateHash: vi.fn(),
    updateStatus: vi.fn(),
  };
}

function createConflict(overrides?: Partial<Conflict>): Conflict {
  return {
    syncRecord: {
      id: "1",
      obsidianPath: "test.md",
      notionPageId: "notion-123",
      notionParentId: "parent-456",
      contentHash: "old-hash",
      notionLastEdited: "2025-01-01T00:00:00.000Z",
      localLastModified: "2025-01-01T00:00:00.000Z",
      syncDirection: "both",
      fileType: "file",
      status: "conflict",
      baseSnapshot: Buffer.from("base content"),
      version: 1,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    } as SyncRecord,
    localChange: {
      path: "test.md",
      type: "modified",
      currentHash: "local-hash",
      previousHash: "old-hash",
    },
    remoteChange: {
      pageId: "notion-123",
      type: "modified",
      lastEdited: "2026-01-01T00:00:00.000Z",
      previousEdited: "2025-01-01T00:00:00.000Z",
    },
    baseContent: "base content",
    localContent: "local modified content",
    remoteContent: "remote modified content",
    ...overrides,
  };
}

describe("ConflictResolver", () => {
  let resolver: ConflictResolver;
  let mockVaultFs: ReturnType<typeof createMockVaultFs>;
  let mockStateDb: ReturnType<typeof createMockStateDb>;

  beforeEach(() => {
    mockVaultFs = createMockVaultFs();
    mockStateDb = createMockStateDb();
    resolver = new ConflictResolver(mockStateDb as any, mockVaultFs);
  });

  describe("resolve - local", () => {
    it("로컬 유지: 파일 안 건드리고 상태만 synced로", async () => {
      const conflict = createConflict();
      const result = await resolver.resolve(conflict, "local");

      expect(result.success).toBe(true);
      expect(result.choice).toBe("local");
      expect(mockVaultFs.writeFile).not.toHaveBeenCalled();
      expect(mockStateDb.updateStatus).toHaveBeenCalledWith("1", "synced");
      expect(mockStateDb.updateHash).toHaveBeenCalled();
    });
  });

  describe("resolve - remote", () => {
    it("원격 유지: 파일을 원격 내용으로 덮어쓰기", async () => {
      const conflict = createConflict();
      const result = await resolver.resolve(conflict, "remote");

      expect(result.success).toBe(true);
      expect(result.choice).toBe("remote");
      expect(mockVaultFs.writeFile).toHaveBeenCalledWith("test.md", "remote modified content");
      expect(mockStateDb.updateStatus).toHaveBeenCalledWith("1", "synced");
    });
  });

  describe("resolve - merge", () => {
    it("3-way merge 성공 (충돌 없는 경우)", async () => {
      const conflict = createConflict({
        baseContent: "line1\nline2\nline3",
        localContent: "line1\nlocal change\nline3",
        remoteContent: "line1\nline2\nremote change",
      });

      const result = await resolver.resolve(conflict, "merge");

      expect(result.success).toBe(true);
      expect(result.mergeHadConflicts).toBe(false);
      expect(mockVaultFs.writeFile).toHaveBeenCalled();
      expect(mockStateDb.updateStatus).toHaveBeenCalledWith("1", "synced");

      const writtenContent = (mockVaultFs.writeFile as any).mock.calls[0][1] as string;
      expect(writtenContent).toContain("local change");
      expect(writtenContent).toContain("remote change");
    });

    it("3-way merge 충돌 (같은 줄 수정)", async () => {
      const conflict = createConflict({
        baseContent: "same line to edit",
        localContent: "local edit",
        remoteContent: "remote edit",
      });

      const result = await resolver.resolve(conflict, "merge");

      expect(result.success).toBe(false);
      expect(result.mergeHadConflicts).toBe(true);

      const writtenContent = (mockVaultFs.writeFile as any).mock.calls[0][1] as string;
      expect(writtenContent).toContain("<<<<<<< LOCAL");
      expect(writtenContent).toContain(">>>>>>> REMOTE");
    });

    it("base가 null이면 빈 문자열로 처리", async () => {
      const conflict = createConflict({ baseContent: null });
      const result = await resolver.resolve(conflict, "merge");

      expect(result.choice).toBe("merge");
      expect(mockVaultFs.writeFile).toHaveBeenCalled();
    });
  });

  describe("resolve - duplicate", () => {
    it("원본 유지 + .conflict.md 파일 생성", async () => {
      const conflict = createConflict();
      const result = await resolver.resolve(conflict, "duplicate");

      expect(result.success).toBe(true);
      expect(result.choice).toBe("duplicate");
      expect(mockVaultFs.writeFile).toHaveBeenCalledWith(
        "test.conflict.md",
        "remote modified content",
      );
      expect(mockStateDb.updateStatus).toHaveBeenCalledWith("1", "synced");
    });
  });

  describe("resolveByStrategy", () => {
    it("local-first → local 선택", async () => {
      const conflict = createConflict();
      const result = await resolver.resolveByStrategy(conflict, "local-first");
      expect(result.choice).toBe("local");
    });

    it("remote-first → remote 선택", async () => {
      const conflict = createConflict();
      const result = await resolver.resolveByStrategy(conflict, "remote-first");
      expect(result.choice).toBe("remote");
    });

    it("duplicate → duplicate 선택", async () => {
      const conflict = createConflict();
      const result = await resolver.resolveByStrategy(conflict, "duplicate");
      expect(result.choice).toBe("duplicate");
    });

    it("manual → merge 선택", async () => {
      const conflict = createConflict();
      const result = await resolver.resolveByStrategy(conflict, "manual");
      expect(result.choice).toBe("merge");
    });
  });

  describe("resolveAll", () => {
    it("여러 충돌 일괄 해결", async () => {
      const conflicts = [createConflict(), createConflict()];
      const results = await resolver.resolveAll(conflicts, "local-first");

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.success)).toBe(true);
    });
  });

  describe("generateDiff", () => {
    it("diff 출력 생성", () => {
      const conflict = createConflict();
      const diff = resolver.generateDiff(conflict);

      expect(diff).toContain("--- local:");
      expect(diff).toContain("+++ remote:");
      expect(diff).toContain("- local modified content");
      expect(diff).toContain("+ remote modified content");
    });
  });
});
