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
});
