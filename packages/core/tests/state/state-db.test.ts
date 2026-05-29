import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateDB } from "../../src/state/state-db.js";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("StateDB", () => {
  let db: StateDB;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-test-"));
    db = StateDB.open(join(tempDir, "test.db"));
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true });
  });

  describe("sync_state CRUD", () => {
    it("upsert로 새 레코드 생성", () => {
      const record = db.upsert({
        obsidianPath: "notes/hello.md",
        notionPageId: "page-123",
        notionParentId: "parent-456",
        contentHash: "abc123",
        localLastModified: "2026-05-08T10:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "synced",
      });

      expect(record.obsidianPath).toBe("notes/hello.md");
      expect(record.notionPageId).toBe("page-123");
      expect(record.status).toBe("synced");
      expect(record.version).toBe(1);
    });

    it("getByPath로 조회", () => {
      db.upsert({
        obsidianPath: "test.md",
        contentHash: "hash1",
        localLastModified: "2026-05-08T10:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "pending",
      });

      const result = db.getByPath("test.md");
      expect(result).not.toBeNull();
      expect(result!.obsidianPath).toBe("test.md");
    });

    it("getByNotionId로 조회", () => {
      db.upsert({
        obsidianPath: "test.md",
        notionPageId: "notion-id-1",
        contentHash: "hash1",
        localLastModified: "2026-05-08T10:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "synced",
      });

      const result = db.getByNotionId("notion-id-1");
      expect(result).not.toBeNull();
      expect(result!.obsidianPath).toBe("test.md");
    });

    it("upsert로 기존 레코드 업데이트 (version 증가)", () => {
      db.upsert({
        obsidianPath: "test.md",
        contentHash: "hash1",
        localLastModified: "2026-05-08T10:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "pending",
      });

      const updated = db.upsert({
        obsidianPath: "test.md",
        contentHash: "hash2",
        localLastModified: "2026-05-08T11:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "synced",
      });

      expect(updated.contentHash).toBe("hash2");
      expect(updated.version).toBe(2);
    });

    it("updateStatus", () => {
      const record = db.upsert({
        obsidianPath: "test.md",
        contentHash: "hash1",
        localLastModified: "2026-05-08T10:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "pending",
      });

      db.updateStatus(record.id, "synced");
      const updated = db.getByPath("test.md");
      expect(updated!.status).toBe("synced");
    });

    it("delete", () => {
      const record = db.upsert({
        obsidianPath: "test.md",
        contentHash: "hash1",
        localLastModified: "2026-05-08T10:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "synced",
      });

      db.delete(record.id);
      expect(db.getByPath("test.md")).toBeNull();
    });

    it("getByStatus", () => {
      db.upsert({
        obsidianPath: "a.md",
        contentHash: "h1",
        localLastModified: "2026-05-08T10:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "synced",
      });
      db.upsert({
        obsidianPath: "b.md",
        contentHash: "h2",
        localLastModified: "2026-05-08T10:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "conflict",
      });

      const synced = db.getByStatus("synced");
      expect(synced).toHaveLength(1);
      expect(synced[0]!.obsidianPath).toBe("a.md");
    });
  });

  describe("wikilink_map", () => {
    it("upsertWikilink + resolveWikilink (title)", () => {
      db.upsertWikilink({
        obsidianPath: "notes/project.md",
        notionPageId: "page-abc",
        title: "Project Plan",
        aliases: ["PP", "Plan"],
      });

      const result = db.resolveWikilink("Project Plan");
      expect(result).not.toBeNull();
      expect(result!.notionPageId).toBe("page-abc");
    });

    it("resolveWikilink (alias)", () => {
      db.upsertWikilink({
        obsidianPath: "notes/project.md",
        notionPageId: "page-abc",
        title: "Project Plan",
        aliases: ["PP", "Plan"],
      });

      const result = db.resolveWikilink("PP");
      expect(result).not.toBeNull();
      expect(result!.title).toBe("Project Plan");
    });

    it("resolvePageId", () => {
      db.upsertWikilink({
        obsidianPath: "notes/project.md",
        notionPageId: "page-abc",
        title: "Project Plan",
        aliases: [],
      });

      const result = db.resolvePageId("page-abc");
      expect(result).not.toBeNull();
      expect(result!.obsidianPath).toBe("notes/project.md");
    });

    it("deleteWikilink — 경로로 항목 제거", () => {
      db.upsertWikilink({
        obsidianPath: "notes/project.md",
        notionPageId: "page-abc",
        title: "Project Plan",
        aliases: ["PP"],
      });
      expect(db.resolvePageId("page-abc")).not.toBeNull();

      db.deleteWikilink("notes/project.md");

      expect(db.resolvePageId("page-abc")).toBeNull();
      expect(db.resolveWikilink("Project Plan")).toBeNull();
    });

    it("deleteWikilink — 없는 경로는 무시(no-op)", () => {
      expect(() => db.deleteWikilink("does/not/exist.md")).not.toThrow();
    });
  });

  describe("sync_metadata", () => {
    it("setMeta + getMeta", () => {
      db.setMeta("last_sync_at", "2026-05-08T14:00:00Z");
      expect(db.getMeta("last_sync_at")).toBe("2026-05-08T14:00:00Z");
    });

    it("존재하지 않는 키는 null", () => {
      expect(db.getMeta("nonexistent")).toBeNull();
    });

    it("덮어쓰기", () => {
      db.setMeta("key", "value1");
      db.setMeta("key", "value2");
      expect(db.getMeta("key")).toBe("value2");
    });
  });

  describe("transaction", () => {
    it("트랜잭션 내 다중 작업 원자적 수행", () => {
      db.transaction(() => {
        db.upsert({
          obsidianPath: "a.md",
          contentHash: "h1",
          localLastModified: "2026-05-08T10:00:00Z",
          syncDirection: "both",
          fileType: "file",
          status: "synced",
        });
        db.upsert({
          obsidianPath: "b.md",
          contentHash: "h2",
          localLastModified: "2026-05-08T10:00:00Z",
          syncDirection: "both",
          fileType: "file",
          status: "synced",
        });
      });

      expect(db.getAll()).toHaveLength(2);
    });
  });

  describe("file_registry", () => {
    it("파일 등록 및 조회", () => {
      db.registerFile({
        localPath: "images/photo.png",
        notionPageId: "page-123",
        fileUploadId: "upload-456",
        fileType: "image",
        fileHash: "hash123",
        fileSize: 1024,
      });

      expect(db.isFileRegistered("images/photo.png")).toBe(true);
      expect(db.isFileRegistered("images/other.png")).toBe(false);

      const entry = db.getFileRegistry("images/photo.png");
      expect(entry).not.toBeNull();
      expect(entry!.localPath).toBe("images/photo.png");
      expect(entry!.fileType).toBe("image");
      expect(entry!.fileHash).toBe("hash123");
      expect(entry!.fileSize).toBe(1024);
    });

    it("페이지별 파일 조회", () => {
      db.registerFile({
        localPath: "docs/report.pdf",
        notionPageId: "page-abc",
        fileUploadId: "upload-1",
        fileType: "pdf",
        fileHash: "h1",
        fileSize: 2048,
      });
      db.registerFile({
        localPath: "docs/data.xlsx",
        notionPageId: "page-abc",
        fileUploadId: "upload-2",
        fileType: "file",
        fileHash: "h2",
        fileSize: 4096,
      });
      db.registerFile({
        localPath: "other/img.png",
        notionPageId: "page-xyz",
        fileUploadId: "upload-3",
        fileType: "image",
        fileHash: "h3",
        fileSize: 512,
      });

      const abcFiles = db.getFilesByPageId("page-abc");
      expect(abcFiles).toHaveLength(2);

      const xyzFiles = db.getFilesByPageId("page-xyz");
      expect(xyzFiles).toHaveLength(1);
    });

    it("파일 삭제", () => {
      db.registerFile({
        localPath: "temp/file.zip",
        notionPageId: "page-1",
        fileUploadId: "upload-1",
        fileType: "file",
        fileHash: "h1",
        fileSize: 100,
      });

      expect(db.isFileRegistered("temp/file.zip")).toBe(true);
      db.deleteFileRegistry("temp/file.zip");
      expect(db.isFileRegistered("temp/file.zip")).toBe(false);
    });

    it("동일 경로 재등록 시 덮어쓰기", () => {
      db.registerFile({
        localPath: "photo.png",
        notionPageId: "page-1",
        fileUploadId: "upload-old",
        fileType: "image",
        fileHash: "old-hash",
        fileSize: 100,
      });

      db.registerFile({
        localPath: "photo.png",
        notionPageId: "page-1",
        fileUploadId: "upload-new",
        fileType: "image",
        fileHash: "new-hash",
        fileSize: 200,
      });

      const entry = db.getFileRegistry("photo.png");
      expect(entry!.fileHash).toBe("new-hash");
      expect(entry!.fileUploadId).toBe("upload-new");
    });
  });

  describe("pending_operations (I12 WAL)", () => {
    // pending_operations.sync_state_id 는 sync_state(id) 를 FK CASCADE 로 참조하므로
    // op 기록 전에 부모 sync_state 행이 반드시 존재해야 한다(쓰기-우선).
    function newState(path = "wal/note.md"): string {
      const rec = db.upsert({
        obsidianPath: path,
        notionPageId: null,
        notionParentId: "parent-1",
        contentHash: "",
        localLastModified: "2026-05-29T00:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "pending",
      });
      return rec.id;
    }

    it("recordPendingOperation + getIncompletePendingOperations", () => {
      const sid = newState();
      const opId = db.recordPendingOperation({
        syncStateId: sid,
        operation: "create",
        direction: "push",
        payload: JSON.stringify({ path: "wal/note.md", parentId: "parent-1", title: "note" }),
      });

      expect(typeof opId).toBe("string");
      const incomplete = db.getIncompletePendingOperations();
      expect(incomplete).toHaveLength(1);
      expect(incomplete[0]!.id).toBe(opId);
      expect(incomplete[0]!.syncStateId).toBe(sid);
      expect(incomplete[0]!.operation).toBe("create");
      expect(incomplete[0]!.direction).toBe("push");
      expect(incomplete[0]!.status).toBe("pending");
      expect(JSON.parse(incomplete[0]!.payload!).title).toBe("note");
    });

    it("getIncompleteOpByState — 같은 state·operation 미완료 op 재사용(중복 기록 방지)", () => {
      const sid = newState();
      const opId = db.recordPendingOperation({
        syncStateId: sid,
        operation: "create",
        direction: "push",
        payload: null,
      });

      expect(db.getIncompleteOpByState(sid, "create")?.id).toBe(opId);
      // 다른 operation 은 매칭되지 않음.
      expect(db.getIncompleteOpByState(sid, "update")).toBeNull();
    });

    it("markPendingCompleted — 완료 처리 후 미완료 목록에서 제외", () => {
      const sid = newState();
      const opId = db.recordPendingOperation({
        syncStateId: sid,
        operation: "create",
        direction: "push",
        payload: null,
      });

      db.markPendingCompleted(opId);
      expect(db.getIncompletePendingOperations()).toHaveLength(0);
      expect(db.getIncompleteOpByState(sid, "create")).toBeNull();
    });

    it("markPendingFailed — 실패 처리 시 retry_count 증가·errorMessage 기록", () => {
      const sid = newState();
      const opId = db.recordPendingOperation({
        syncStateId: sid,
        operation: "create",
        direction: "push",
        payload: null,
      });

      db.markPendingFailed(opId, "boom");
      // 실패도 더 이상 미완료 아님.
      expect(db.getIncompletePendingOperations()).toHaveLength(0);
    });

    it("clearCompletedOperations — 완료/실패 항목만 정리, 미완료는 보존", () => {
      const sid1 = newState("wal/a.md");
      const sid2 = newState("wal/b.md");
      const sid3 = newState("wal/c.md");
      const done = db.recordPendingOperation({
        syncStateId: sid1,
        operation: "create",
        direction: "push",
      });
      const failed = db.recordPendingOperation({
        syncStateId: sid2,
        operation: "create",
        direction: "push",
      });
      db.recordPendingOperation({ syncStateId: sid3, operation: "create", direction: "push" });

      db.markPendingCompleted(done);
      db.markPendingFailed(failed, "x");
      db.clearCompletedOperations();

      const remaining = db.getIncompletePendingOperations();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.syncStateId).toBe(sid3);
    });

    it("FK CASCADE — sync_state 삭제 시 연결된 pending op 도 함께 제거", () => {
      const sid = newState();
      db.recordPendingOperation({ syncStateId: sid, operation: "create", direction: "push" });
      expect(db.getIncompletePendingOperations()).toHaveLength(1);

      db.delete(sid);
      expect(db.getIncompletePendingOperations()).toHaveLength(0);
    });
  });
});
