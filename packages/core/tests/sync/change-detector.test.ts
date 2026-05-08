import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ChangeDetector } from "../../src/sync/change-detector.js";
import { StateDB } from "../../src/state/state-db.js";
import { computeHash } from "../../src/utils/hash.js";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { FileInfo } from "../../src/sync/change-detector.js";

describe("ChangeDetector", () => {
  let db: StateDB;
  let detector: ChangeDetector;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "obsinotion-cd-"));
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
      contentHash: computeHash(existing),
      localLastModified: "2026-05-08T09:00:00Z",
      syncDirection: "both",
      fileType: "file",
      status: "synced",
    });
    db.upsert({
      obsidianPath: "to-delete.md",
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
});
