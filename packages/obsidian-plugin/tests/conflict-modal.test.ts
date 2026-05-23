import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConflictModal } from "../src/conflict-modal.js";
import type { Conflict } from "@im-nobsidian/core";

vi.mock("@im-nobsidian/core", () => ({}));

describe("ConflictModal", () => {
  let modal: ConflictModal;
  let onResolve: ReturnType<typeof vi.fn>;
  let mockConflict: Conflict;

  beforeEach(() => {
    vi.clearAllMocks();

    onResolve = vi.fn();
    mockConflict = {
      syncRecord: {
        id: "rec-1",
        obsidianPath: "notes/conflict.md",
        notionPageId: "page-1",
        notionParentId: null,
        contentHash: "h1",
        notionLastEdited: null,
        localLastModified: "2026-05-22T00:00:00Z",
        syncDirection: "both",
        fileType: "file",
        status: "conflict",
        baseSnapshot: null,
        localMtime: null,
        localFileSize: null,
        version: 1,
        createdAt: "2026-05-22T00:00:00Z",
        updatedAt: "2026-05-22T00:00:00Z",
      },
      localChange: {
        path: "notes/conflict.md",
        type: "modified",
        currentHash: "h2",
        previousHash: "h1",
      },
      remoteChange: {
        pageId: "page-1",
        type: "modified",
        lastEdited: "2026-05-22T01:00:00Z",
        previousEdited: "2026-05-22T00:00:00Z",
      },
      baseContent: "base content",
      localContent: "local line 1\nlocal line 2",
      remoteContent: "remote line 1\nremote line 2",
    } as Conflict;

    modal = new ConflictModal({} as never, mockConflict, onResolve);
  });

  it("onOpen 에러 없이 실행", () => {
    expect(() => modal.onOpen()).not.toThrow();
  });

  it("onClose 에러 없이 실행", () => {
    expect(() => modal.onClose()).not.toThrow();
  });

  it("인스턴스 생성 가능", () => {
    expect(modal).toBeDefined();
  });

  it("onOpen 호출 후 onClose 호출 가능", () => {
    modal.onOpen();
    expect(() => modal.onClose()).not.toThrow();
  });

  it("다른 충돌 데이터로도 생성 가능", () => {
    const anotherConflict = {
      ...mockConflict,
      localContent: "different local",
      remoteContent: "different remote",
    } as Conflict;

    const anotherModal = new ConflictModal({} as never, anotherConflict, vi.fn());
    expect(anotherModal).toBeDefined();
    expect(() => anotherModal.onOpen()).not.toThrow();
  });
});
