import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChangeDetector } from "../../src/sync/change-detector.js";
import { StateDB } from "../../src/state/state-db.js";
import { computeHash } from "../../src/utils/hash.js";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { FileInfo } from "../../src/sync/change-detector.js";
import { EMPTY_RENAME_HINTS, movePayload, recordRenameHint } from "../../src/sync/local-moves.js";

describe("ChangeDetector", () => {
  let db: StateDB;
  let detector: ChangeDetector;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-cd-"));
    db = StateDB.open(join(tempDir, "test.db"));
    detector = new ChangeDetector(db);
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true });
  });

  it("새 파일 감지", () => {
    const files: FileInfo[] = [
      { path: "new-file.md", content: "# New", mtime: "2026-05-08T10:00:00Z" },
    ];

    const changes = detector.detectLocalChanges(files);

    expect(changes).toHaveLength(1);
    expect(changes[0]!.type).toBe("created");
    expect(changes[0]!.path).toBe("new-file.md");
  });

  it("수정된 파일 감지", () => {
    const originalContent = "# Original";
    db.upsert({
      obsidianPath: "note.md",
      notionPageId: "page-1",
      contentHash: computeHash(originalContent),
      localLastModified: "2026-05-08T09:00:00Z",
      syncDirection: "both",
      fileType: "file",
      status: "synced",
    });

    const files: FileInfo[] = [
      { path: "note.md", content: "# Modified", mtime: "2026-05-08T10:00:00Z" },
    ];

    const changes = detector.detectLocalChanges(files);

    expect(changes).toHaveLength(1);
    expect(changes[0]!.type).toBe("modified");
  });

  it("변경 없는 파일 skip", () => {
    const content = "# Same";
    db.upsert({
      obsidianPath: "note.md",
      notionPageId: "page-2",
      contentHash: computeHash(content),
      localLastModified: "2026-05-08T09:00:00Z",
      syncDirection: "both",
      fileType: "file",
      status: "synced",
    });

    const files: FileInfo[] = [{ path: "note.md", content, mtime: "2026-05-08T09:00:00Z" }];

    const changes = detector.detectLocalChanges(files);
    expect(changes).toHaveLength(0);
  });

  it("삭제된 파일 감지", () => {
    db.upsert({
      obsidianPath: "deleted.md",
      notionPageId: "page-3",
      contentHash: "abc",
      localLastModified: "2026-05-08T09:00:00Z",
      syncDirection: "both",
      fileType: "file",
      status: "synced",
    });

    const changes = detector.detectLocalChanges([]);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.type).toBe("deleted");
    expect(changes[0]!.path).toBe("deleted.md");
  });

  it("이동 감지 (같은 해시의 삭제+생성 → moved)", () => {
    const content = "# Moved File";
    const hash = computeHash(content);

    db.upsert({
      obsidianPath: "old/note.md",
      notionPageId: "page-4",
      contentHash: hash,
      localLastModified: "2026-05-08T09:00:00Z",
      syncDirection: "both",
      fileType: "file",
      status: "synced",
    });

    const files: FileInfo[] = [{ path: "new/note.md", content, mtime: "2026-05-08T10:00:00Z" }];

    const changes = detector.detectLocalChanges(files);

    expect(changes).toHaveLength(1);
    expect(changes[0]!.type).toBe("moved");
    expect(changes[0]!.path).toBe("new/note.md");
    expect(changes[0]!.movedFrom).toBe("old/note.md");
  });

  it("복합 시나리오: 생성 + 수정 + 삭제 동시", () => {
    const existing = "# Existing";
    db.upsert({
      obsidianPath: "existing.md",
      notionPageId: "page-5",
      contentHash: computeHash(existing),
      localLastModified: "2026-05-08T09:00:00Z",
      syncDirection: "both",
      fileType: "file",
      status: "synced",
    });
    db.upsert({
      obsidianPath: "to-delete.md",
      notionPageId: "page-6",
      contentHash: "xxx",
      localLastModified: "2026-05-08T09:00:00Z",
      syncDirection: "both",
      fileType: "file",
      status: "synced",
    });

    const files: FileInfo[] = [
      { path: "existing.md", content: "# Modified", mtime: "2026-05-08T10:00:00Z" },
      { path: "brand-new.md", content: "# New", mtime: "2026-05-08T10:00:00Z" },
    ];

    const changes = detector.detectLocalChanges(files);

    const types = changes.map((c) => c.type).sort();
    expect(types).toEqual(["created", "deleted", "modified"]);
  });

  it("페이지 ID 가 없는 자리표시는 «생성» 이다 — 수정 경로는 보낼 페이지가 없다", async () => {
    // pushCreate 가 생성 요청 전에 남기는 WAL 자리표시. 생성이 모호하게 실패하면 남는다.
    db.upsert({
      obsidianPath: "pending.md",
      notionPageId: null,
      contentHash: "",
      localLastModified: "2026-05-08T09:00:00Z",
      syncDirection: "both",
      fileType: "file",
      status: "pending",
    });

    const slow = detector.detectLocalChanges([
      { path: "pending.md", content: "# 본문", mtime: "2026-05-08T10:00:00Z" },
    ]);
    const fast = await detector.detectLocalChangesFast(
      [{ path: "pending.md", mtime: "2026-05-08T10:00:00Z", size: 10 }],
      async () => "# 본문",
    );

    expect(slow.map((c) => c.type)).toEqual(["created"]);
    expect(fast.map((c) => c.type)).toEqual(["created"]);
  });

  describe("옮긴 노트 (S-11)", () => {
    const T0 = "2026-05-08T09:00:00Z";

    function track(path: string, content: string, pageId: string) {
      return db.upsert({
        obsidianPath: path,
        notionPageId: pageId,
        contentHash: computeHash(content),
        localLastModified: T0,
        syncDirection: "both",
        fileType: "file",
        status: "synced",
        localMtime: T0,
        localFileSize: content.length,
      });
    }

    it("힌트가 있으면 이름과 내용을 함께 바꿔도 moved — 입양할 레코드를 돌려준다", () => {
      const record = track("a.md", "# 원래", "page-a");
      const hints = recordRenameHint(EMPTY_RENAME_HINTS, "a.md", "b.md", "file");

      const scan = detector.scanLocalChanges([{ path: "b.md", content: "# 고침", mtime: T0 }], {
        hints,
      });

      expect(scan.changes).toEqual([
        {
          path: "b.md",
          type: "moved",
          currentHash: computeHash("# 고침"),
          previousHash: computeHash("# 원래"),
          movedFrom: "a.md",
        },
      ]);
      expect(scan.adoptions).toEqual([{ record, to: "b.md", origin: "a.md" }]);
    });

    it("힌트가 없고 내용이 다르면 예전처럼 생성 + 삭제", () => {
      track("a.md", "# 원래", "page-a");
      const changes = detector.detectLocalChanges([{ path: "b.md", content: "# 고침", mtime: T0 }]);
      expect(changes.map((c) => [c.type, c.path])).toEqual([
        ["created", "b.md"],
        ["deleted", "a.md"],
      ]);
    });

    it("입양해 둔 이동은 파일 크기 · 수정 시각이 같아도 moved 로 남는다", async () => {
      const record = track("a.md", "# 본문", "page-a");
      db.updatePath(record.id, "b.md");
      db.recordPendingOperation({
        syncStateId: record.id,
        operation: "move",
        direction: "push",
        payload: movePayload("a.md"),
      });

      const scan = await detector.scanLocalChangesFast(
        [{ path: "b.md", mtime: T0, size: "# 본문".length }],
        async () => "# 본문",
      );

      expect(scan.changes.map((c) => [c.type, c.path, c.movedFrom])).toEqual([
        ["moved", "b.md", "a.md"],
      ]);
      expect(scan.adoptions).toEqual([]);
    });

    it("입양해 둔 이동을 원래 자리로 되돌리면 옮긴 것이 아니다 — 내용만 본다", async () => {
      const record = track("a.md", "# 본문", "page-a");
      db.updatePath(record.id, "b.md");
      db.recordPendingOperation({
        syncStateId: record.id,
        operation: "move",
        direction: "push",
        payload: movePayload("a.md"),
      });

      const same = await detector.scanLocalChangesFast(
        [{ path: "a.md", mtime: T0, size: 7 }],
        async () => "# 본문",
      );
      expect(same.changes).toEqual([]);
      expect(same.adoptions.map((a) => [a.record.obsidianPath, a.to, a.origin])).toEqual([
        ["b.md", "a.md", "a.md"],
      ]);

      const edited = await detector.scanLocalChangesFast(
        [{ path: "a.md", mtime: T0, size: 7 }],
        async () => "# 고친 본문",
      );
      expect(edited.changes.map((c) => [c.type, c.path])).toEqual([["modified", "a.md"]]);
    });
  });
});
