import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSqlJsMock } from "../helpers/mock-sqljs.js";

vi.mock("sql.js", () => createSqlJsMock());

vi.mock("@im-nobsidian/core", () => {
  let counter = 1000;
  return {
    generateId: () => `edge-id-${++counter}`,
  };
});

import { SqlJsStateDB } from "../../src/state/sqljs-state-db.js";

describe("SqlJsStateDB 엣지 케이스", () => {
  let db: SqlJsStateDB;

  beforeEach(async () => {
    db = await SqlJsStateDB.open();
  });

  afterEach(() => {
    db.close();
  });

  it("한글 경로 처리", () => {
    const record = db.upsert({
      obsidianPath: "노트/프로젝트/회의록.md",
      notionPageId: "page-kr",
      notionParentId: null,
      contentHash: "kr-hash",
      notionLastEdited: null,
      localLastModified: "2026-05-22T00:00:00Z",
      syncDirection: "both",
      fileType: "file",
      status: "synced",
      baseSnapshot: null,
      localMtime: null,
      localFileSize: null,
    });

    expect(db.getByPath("노트/프로젝트/회의록.md")).not.toBeNull();
    expect(record.obsidianPath).toBe("노트/프로젝트/회의록.md");
  });

  it("특수문자 포함 경로", () => {
    db.upsert({
      obsidianPath: "notes/my file (2026).md",
      notionPageId: null,
      notionParentId: null,
      contentHash: "special-hash",
      notionLastEdited: null,
      localLastModified: "2026-05-22T00:00:00Z",
      syncDirection: "both",
      fileType: "file",
      status: "synced",
      baseSnapshot: null,
      localMtime: null,
      localFileSize: null,
    });

    expect(db.getByPath("notes/my file (2026).md")).not.toBeNull();
  });

  it("db-row 파일 타입", () => {
    const record = db.upsert({
      obsidianPath: "database/entry.md",
      notionPageId: "db-page-1",
      notionParentId: "db-parent-1",
      contentHash: "db-hash",
      notionLastEdited: null,
      localLastModified: "2026-05-22T00:00:00Z",
      syncDirection: "push",
      fileType: "db-row",
      status: "synced",
      baseSnapshot: null,
      localMtime: null,
      localFileSize: null,
    });

    expect(record.fileType).toBe("db-row");
    expect(record.syncDirection).toBe("push");
  });

  it("error 상태 저장", () => {
    db.upsert({
      obsidianPath: "error.md",
      notionPageId: null,
      notionParentId: null,
      contentHash: "err-hash",
      notionLastEdited: null,
      localLastModified: "2026-05-22T00:00:00Z",
      syncDirection: "both",
      fileType: "file",
      status: "error",
      baseSnapshot: null,
      localMtime: null,
      localFileSize: null,
    });

    const errors = db.getByStatus("error");
    expect(errors.length).toBe(1);
    expect(errors[0]!.status).toBe("error");
  });

  it("동일 경로 여러 번 upsert (idempotent)", () => {
    for (let i = 0; i < 3; i++) {
      db.upsert({
        obsidianPath: "repeated.md",
        notionPageId: null,
        notionParentId: null,
        contentHash: `hash-v${i}`,
        notionLastEdited: null,
        localLastModified: "2026-05-22T00:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "synced",
        baseSnapshot: null,
        localMtime: null,
        localFileSize: null,
      });
    }

    const all = db.getAll();
    const matchingPath = all.filter((r) => r.obsidianPath === "repeated.md");
    expect(matchingPath.length).toBe(1);
    expect(matchingPath[0]!.contentHash).toBe("hash-v2");
  });

  it("위키링크 업서트 덮어쓰기", () => {
    db.upsertWikilink({
      obsidianPath: "wiki.md",
      notionPageId: "old-page",
      title: "Wiki",
      aliases: [],
    });

    db.upsertWikilink({
      obsidianPath: "wiki.md",
      notionPageId: "new-page",
      title: "Wiki Updated",
      aliases: ["w"],
    });

    const found = db.resolveWikilink("Wiki Updated");
    expect(found).not.toBeNull();
    expect(found!.notionPageId).toBe("new-page");
  });

  it("메타데이터로 JSON 저장", () => {
    const config = { views: ["gallery", "board"], theme: "dark" };
    db.setMeta("viewConfig:db-1", JSON.stringify(config));

    const raw = db.getMeta("viewConfig:db-1");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.views).toEqual(["gallery", "board"]);
  });

  it("파일 레지스트리 삭제 후 재등록", () => {
    db.registerFile({
      localPath: "attach/file.pdf",
      notionPageId: "page-1",
      fileUploadId: "upload-v1",
      fileType: "pdf",
      fileHash: "hash-v1",
      fileSize: 500,
    });

    expect(db.isFileRegistered("attach/file.pdf")).toBe(true);

    db.deleteFileRegistry("attach/file.pdf");
    expect(db.isFileRegistered("attach/file.pdf")).toBe(false);

    db.registerFile({
      localPath: "attach/file.pdf",
      notionPageId: "page-1",
      fileUploadId: "upload-v2",
      fileType: "pdf",
      fileHash: "hash-v2",
      fileSize: 800,
    });

    const entry = db.getFileRegistry("attach/file.pdf");
    expect(entry).not.toBeNull();
    expect(entry!.fileHash).toBe("hash-v2");
    expect(entry!.fileSize).toBe(800);
  });

  it("preserve markers JSON 무결성", () => {
    const complexMarkers = [
      {
        type: "toggle" as const,
        id: "t1",
        content: '내용에 "따옴표"와 \n개행이 있음',
        position: 0,
      },
      { type: "column" as const, id: "c1", content: "컬럼 {json: true}", position: 10 },
    ];

    db.storePreserveMarkers("complex.md", complexMarkers);
    const retrieved = db.getPreserveMarkers("complex.md");
    expect(retrieved.length).toBe(2);
    expect(retrieved[0]!.content).toContain("따옴표");
  });

  it("stat cache에 큰 파일 크기 저장", () => {
    const record = db.upsert({
      obsidianPath: "big.md",
      notionPageId: null,
      notionParentId: null,
      contentHash: "big-hash",
      notionLastEdited: null,
      localLastModified: "2026-05-22T00:00:00Z",
      syncDirection: "both",
      fileType: "file",
      status: "synced",
      baseSnapshot: null,
      localMtime: null,
      localFileSize: null,
    });

    db.updateStatCache(record.id, "2026-05-22T00:00:00Z", 104857600);
    const updated = db.getByPath("big.md");
    expect(updated!.localFileSize).toBe(104857600);
  });

  it("삭제된 레코드 재생성", () => {
    const record = db.upsert({
      obsidianPath: "temp.md",
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
    expect(db.getByPath("temp.md")).toBeNull();

    const recreated = db.upsert({
      obsidianPath: "temp.md",
      notionPageId: "new-page",
      notionParentId: null,
      contentHash: "h2",
      notionLastEdited: null,
      localLastModified: "2026-05-22T01:00:00Z",
      syncDirection: "both",
      fileType: "file",
      status: "pending",
      baseSnapshot: null,
      localMtime: null,
      localFileSize: null,
    });

    expect(recreated.notionPageId).toBe("new-page");
    expect(recreated.contentHash).toBe("h2");
  });
});
