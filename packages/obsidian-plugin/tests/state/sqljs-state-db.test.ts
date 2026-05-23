import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSqlJsMock, DatabaseMock } from "../helpers/mock-sqljs.js";

vi.mock("sql.js", () => createSqlJsMock());

vi.mock("@im-nobsidian/core", () => {
  let counter = 0;
  return {
    generateId: () => `test-id-${++counter}`,
  };
});

import { SqlJsStateDB } from "../../src/state/sqljs-state-db.js";

describe("SqlJsStateDB", () => {
  let db: SqlJsStateDB;

  beforeEach(async () => {
    db = await SqlJsStateDB.open();
  });

  afterEach(() => {
    db.close();
  });

  // --- open / close ---

  describe("open", () => {
    it("빈 DB로 열기", async () => {
      const newDb = await SqlJsStateDB.open();
      expect(newDb).toBeDefined();
      newDb.close();
    });

    it("기존 데이터로 열기", async () => {
      const data = db.export();
      const newDb = await SqlJsStateDB.open(data);
      expect(newDb).toBeDefined();
      newDb.close();
    });

    it("flushFn 콜백과 함께 열기", async () => {
      const flushFn = vi.fn();
      const newDb = await SqlJsStateDB.open(null, flushFn);
      expect(newDb).toBeDefined();
      newDb.close();
    });
  });

  // --- sync_state CRUD ---

  describe("upsert / getByPath", () => {
    it("새 레코드 삽입", () => {
      const record = db.upsert({
        obsidianPath: "test/note.md",
        notionPageId: "page-123",
        notionParentId: "parent-456",
        contentHash: "hash-abc",
        notionLastEdited: "2026-05-22T00:00:00Z",
        localLastModified: "2026-05-22T00:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "synced",
        baseSnapshot: null,
        localMtime: null,
        localFileSize: null,
      });

      expect(record).toBeDefined();
      expect(record.obsidianPath).toBe("test/note.md");
      expect(record.notionPageId).toBe("page-123");
      expect(record.status).toBe("synced");
    });

    it("기존 레코드 업데이트", () => {
      db.upsert({
        obsidianPath: "test/note.md",
        notionPageId: "page-123",
        notionParentId: null,
        contentHash: "hash-v1",
        notionLastEdited: null,
        localLastModified: "2026-05-22T00:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "synced",
        baseSnapshot: null,
        localMtime: null,
        localFileSize: null,
      });

      const updated = db.upsert({
        obsidianPath: "test/note.md",
        notionPageId: "page-123",
        notionParentId: null,
        contentHash: "hash-v2",
        notionLastEdited: null,
        localLastModified: "2026-05-22T01:00:00Z",
        syncDirection: "push",
        fileType: "file",
        status: "pending",
        baseSnapshot: null,
        localMtime: null,
        localFileSize: null,
      });

      expect(updated.contentHash).toBe("hash-v2");
      expect(updated.status).toBe("pending");
    });

    it("존재하지 않는 경로는 null 반환", () => {
      expect(db.getByPath("nonexistent.md")).toBeNull();
    });
  });

  describe("getByNotionId", () => {
    it("Notion 페이지 ID로 조회", () => {
      db.upsert({
        obsidianPath: "test/note.md",
        notionPageId: "page-999",
        notionParentId: null,
        contentHash: "hash-1",
        notionLastEdited: null,
        localLastModified: "2026-05-22T00:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "synced",
        baseSnapshot: null,
        localMtime: null,
        localFileSize: null,
      });

      const found = db.getByNotionId("page-999");
      expect(found).not.toBeNull();
      expect(found!.obsidianPath).toBe("test/note.md");
    });

    it("존재하지 않는 ID는 null 반환", () => {
      expect(db.getByNotionId("nonexistent")).toBeNull();
    });
  });

  describe("getByStatus", () => {
    it("상태별 필터링", () => {
      db.upsert({
        obsidianPath: "a.md",
        notionPageId: null,
        notionParentId: null,
        contentHash: "h1",
        notionLastEdited: null,
        localLastModified: "2026-05-22T00:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "synced",
        baseSnapshot: null,
        localMtime: null,
        localFileSize: null,
      });
      db.upsert({
        obsidianPath: "b.md",
        notionPageId: null,
        notionParentId: null,
        contentHash: "h2",
        notionLastEdited: null,
        localLastModified: "2026-05-22T00:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "pending",
        baseSnapshot: null,
        localMtime: null,
        localFileSize: null,
      });

      const synced = db.getByStatus("synced");
      expect(synced.length).toBe(1);
      expect(synced[0]!.obsidianPath).toBe("a.md");

      const pending = db.getByStatus("pending");
      expect(pending.length).toBe(1);
      expect(pending[0]!.obsidianPath).toBe("b.md");
    });
  });

  describe("getAll", () => {
    it("전체 레코드 반환", () => {
      db.upsert({
        obsidianPath: "a.md",
        notionPageId: null,
        notionParentId: null,
        contentHash: "h1",
        notionLastEdited: null,
        localLastModified: "2026-05-22T00:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "synced",
        baseSnapshot: null,
        localMtime: null,
        localFileSize: null,
      });
      db.upsert({
        obsidianPath: "b.md",
        notionPageId: null,
        notionParentId: null,
        contentHash: "h2",
        notionLastEdited: null,
        localLastModified: "2026-05-22T00:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "synced",
        baseSnapshot: null,
        localMtime: null,
        localFileSize: null,
      });

      const all = db.getAll();
      expect(all.length).toBe(2);
    });
  });

  // --- updateStatus / updateHash / setNotionLastEdited ---

  describe("updateStatus", () => {
    it("상태 변경", () => {
      const record = db.upsert({
        obsidianPath: "test.md",
        notionPageId: null,
        notionParentId: null,
        contentHash: "h1",
        notionLastEdited: null,
        localLastModified: "2026-05-22T00:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "pending",
        baseSnapshot: null,
        localMtime: null,
        localFileSize: null,
      });

      db.updateStatus(record.id, "synced");
      const updated = db.getByPath("test.md");
      expect(updated!.status).toBe("synced");
    });
  });

  describe("updateHash", () => {
    it("해시 업데이트 (스냅샷 없음)", () => {
      const record = db.upsert({
        obsidianPath: "test.md",
        notionPageId: null,
        notionParentId: null,
        contentHash: "old-hash",
        notionLastEdited: null,
        localLastModified: "2026-05-22T00:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "synced",
        baseSnapshot: null,
        localMtime: null,
        localFileSize: null,
      });

      db.updateHash(record.id, "new-hash");
      const updated = db.getByPath("test.md");
      expect(updated!.contentHash).toBe("new-hash");
    });

    it("해시 + 스냅샷 업데이트", () => {
      const record = db.upsert({
        obsidianPath: "test.md",
        notionPageId: null,
        notionParentId: null,
        contentHash: "old-hash",
        notionLastEdited: null,
        localLastModified: "2026-05-22T00:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "synced",
        baseSnapshot: null,
        localMtime: null,
        localFileSize: null,
      });

      const snapshot = new Uint8Array([1, 2, 3]);
      db.updateHash(record.id, "new-hash", snapshot);
      const updated = db.getByPath("test.md");
      expect(updated!.contentHash).toBe("new-hash");
    });
  });

  describe("setNotionLastEdited", () => {
    it("Notion 편집 시간 업데이트", () => {
      const record = db.upsert({
        obsidianPath: "test.md",
        notionPageId: "page-1",
        notionParentId: null,
        contentHash: "h1",
        notionLastEdited: null,
        localLastModified: "2026-05-22T00:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "synced",
        baseSnapshot: null,
        localMtime: null,
        localFileSize: null,
      });

      db.setNotionLastEdited(record.id, "2026-05-22T12:00:00Z");
      const updated = db.getByPath("test.md");
      expect(updated!.notionLastEdited).toBe("2026-05-22T12:00:00Z");
    });
  });

  describe("updateStatCache", () => {
    it("stat 캐시 업데이트", () => {
      const record = db.upsert({
        obsidianPath: "test.md",
        notionPageId: null,
        notionParentId: null,
        contentHash: "h1",
        notionLastEdited: null,
        localLastModified: "2026-05-22T00:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "synced",
        baseSnapshot: null,
        localMtime: null,
        localFileSize: null,
      });

      db.updateStatCache(record.id, "2026-05-22T12:00:00Z", 1024);
      const updated = db.getByPath("test.md");
      expect(updated!.localMtime).toBe("2026-05-22T12:00:00Z");
      expect(updated!.localFileSize).toBe(1024);
    });
  });

  describe("setNotionParentId", () => {
    it("부모 ID 설정", () => {
      const record = db.upsert({
        obsidianPath: "test.md",
        notionPageId: null,
        notionParentId: null,
        contentHash: "h1",
        notionLastEdited: null,
        localLastModified: "2026-05-22T00:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "synced",
        baseSnapshot: null,
        localMtime: null,
        localFileSize: null,
      });

      db.setNotionParentId(record.id, "parent-abc");
      const updated = db.getByPath("test.md");
      expect(updated!.notionParentId).toBe("parent-abc");
    });
  });

  describe("delete", () => {
    it("레코드 삭제", () => {
      const record = db.upsert({
        obsidianPath: "test.md",
        notionPageId: null,
        notionParentId: null,
        contentHash: "h1",
        notionLastEdited: null,
        localLastModified: "2026-05-22T00:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "synced",
        baseSnapshot: null,
        localMtime: null,
        localFileSize: null,
      });

      db.delete(record.id);
      expect(db.getByPath("test.md")).toBeNull();
    });
  });

  // --- wikilink_map ---

  describe("wikilink", () => {
    it("위키링크 upsert + 제목으로 조회", () => {
      db.upsertWikilink({
        obsidianPath: "notes/meeting.md",
        notionPageId: "page-w1",
        title: "회의록",
        aliases: ["meeting"],
      });

      const found = db.resolveWikilink("회의록");
      expect(found).not.toBeNull();
      expect(found!.notionPageId).toBe("page-w1");
    });

    it("별칭으로 조회", () => {
      db.upsertWikilink({
        obsidianPath: "notes/meeting.md",
        notionPageId: "page-w1",
        title: "회의록",
        aliases: ["meeting", "mtg"],
      });

      const found = db.resolveWikilink("meeting");
      expect(found).not.toBeNull();
      expect(found!.title).toBe("회의록");
    });

    it("파일명으로 조회", () => {
      db.upsertWikilink({
        obsidianPath: "notes/meeting.md",
        notionPageId: "page-w1",
        title: "회의록",
        aliases: [],
      });

      const found = db.resolveWikilink("meeting");
      expect(found).not.toBeNull();
    });

    it("resolvePageId로 Notion ID → 위키링크 조회", () => {
      db.upsertWikilink({
        obsidianPath: "notes/meeting.md",
        notionPageId: "page-w1",
        title: "회의록",
        aliases: [],
      });

      const found = db.resolvePageId("page-w1");
      expect(found).not.toBeNull();
      expect(found!.obsidianPath).toBe("notes/meeting.md");
    });

    it("존재하지 않는 위키링크는 null", () => {
      expect(db.resolveWikilink("존재안함")).toBeNull();
    });

    it("존재하지 않는 페이지 ID는 null", () => {
      expect(db.resolvePageId("no-such-page")).toBeNull();
    });
  });

  // --- sync_metadata ---

  describe("getMeta / setMeta", () => {
    it("메타데이터 저장 및 조회", () => {
      db.setMeta("lastSyncAt", "2026-05-22T00:00:00Z");
      expect(db.getMeta("lastSyncAt")).toBe("2026-05-22T00:00:00Z");
    });

    it("존재하지 않는 키는 null", () => {
      expect(db.getMeta("nonexistent")).toBeNull();
    });

    it("메타데이터 덮어쓰기", () => {
      db.setMeta("key1", "value1");
      db.setMeta("key1", "value2");
      expect(db.getMeta("key1")).toBe("value2");
    });
  });

  // --- file_registry ---

  describe("file registry", () => {
    it("파일 등록 + 조회", () => {
      db.registerFile({
        localPath: "attachments/image.png",
        notionPageId: "page-1",
        fileUploadId: "upload-1",
        fileType: "image",
        fileHash: "img-hash-1",
        fileSize: 2048,
      });

      expect(db.isFileRegistered("attachments/image.png")).toBe(true);
      expect(db.isFileRegistered("nonexistent.png")).toBe(false);

      const entry = db.getFileRegistry("attachments/image.png");
      expect(entry).not.toBeNull();
      expect(entry!.fileHash).toBe("img-hash-1");
      expect(entry!.fileSize).toBe(2048);
    });

    it("페이지 ID로 파일 목록 조회", () => {
      db.registerFile({
        localPath: "attachments/img1.png",
        notionPageId: "page-1",
        fileUploadId: "up-1",
        fileType: "image",
        fileHash: "h1",
        fileSize: 100,
      });
      db.registerFile({
        localPath: "attachments/img2.png",
        notionPageId: "page-1",
        fileUploadId: "up-2",
        fileType: "image",
        fileHash: "h2",
        fileSize: 200,
      });

      const files = db.getFilesByPageId("page-1");
      expect(files.length).toBe(2);
    });

    it("파일 레지스트리 삭제", () => {
      db.registerFile({
        localPath: "attachments/temp.png",
        notionPageId: "page-1",
        fileUploadId: "up-1",
        fileType: "image",
        fileHash: "h1",
        fileSize: 100,
      });

      db.deleteFileRegistry("attachments/temp.png");
      expect(db.isFileRegistered("attachments/temp.png")).toBe(false);
    });
  });

  // --- preserve markers ---

  describe("preserve markers", () => {
    it("마커 저장 및 조회", () => {
      const markers = [
        { type: "toggle" as const, id: "m1", content: "toggle content", position: 0 },
        { type: "column" as const, id: "m2", content: "col content", position: 5 },
      ];

      db.storePreserveMarkers("test.md", markers);
      const retrieved = db.getPreserveMarkers("test.md");
      expect(retrieved.length).toBe(2);
      expect(retrieved[0]!.type).toBe("toggle");
    });

    it("빈 배열로 마커 삭제", () => {
      db.storePreserveMarkers("test.md", [
        { type: "toggle" as const, id: "m1", content: "content", position: 0 },
      ]);
      db.storePreserveMarkers("test.md", []);
      expect(db.getPreserveMarkers("test.md")).toEqual([]);
    });

    it("마커 없는 파일은 빈 배열", () => {
      expect(db.getPreserveMarkers("no-markers.md")).toEqual([]);
    });
  });

  // --- transaction ---

  describe("transaction", () => {
    it("성공적인 트랜잭션", () => {
      const result = db.transaction(() => {
        db.upsert({
          obsidianPath: "tx-test.md",
          notionPageId: null,
          notionParentId: null,
          contentHash: "h1",
          notionLastEdited: null,
          localLastModified: "2026-05-22T00:00:00Z",
          syncDirection: "both",
          fileType: "file",
          status: "synced",
          baseSnapshot: null,
          localMtime: null,
          localFileSize: null,
        });
        return "done";
      });

      expect(result).toBe("done");
      expect(db.getByPath("tx-test.md")).not.toBeNull();
    });

    it("실패한 트랜잭션은 롤백", () => {
      try {
        db.transaction(() => {
          db.setMeta("tx-key", "tx-value");
          throw new Error("의도적 에러");
        });
      } catch (e) {
        expect((e as Error).message).toBe("의도적 에러");
      }
    });
  });

  // --- flush / export ---

  describe("flush", () => {
    it("dirty 상태일 때 flush 호출", async () => {
      const flushFn = vi.fn();
      const flushDb = await SqlJsStateDB.open(null, flushFn);

      flushDb.setMeta("key", "val");
      await flushDb.flush();

      expect(flushFn).toHaveBeenCalledWith(expect.any(Uint8Array));
      flushDb.close();
    });

    it("clean 상태이면 flush 안 함", async () => {
      const flushFn = vi.fn();
      const flushDb = await SqlJsStateDB.open(null, flushFn);

      await flushDb.flush();
      expect(flushFn).not.toHaveBeenCalled();
      flushDb.close();
    });
  });

  describe("export", () => {
    it("DB를 Uint8Array로 내보내기", () => {
      const data = db.export();
      expect(data).toBeInstanceOf(Uint8Array);
    });
  });
});
