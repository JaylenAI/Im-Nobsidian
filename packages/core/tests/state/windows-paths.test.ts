/**
 * Windows 에서 `\` 로 적은 상태 DB 경로 (이슈 #8). 0.9.1 까지의 CLI 는 Windows 에서 볼트 경로를 `relative()`
 * 그대로 적었다 — 이제 목록이 `/` 로 이으므로 그 기록들을 `/` 로 고쳐 적는다.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDB } from "../../src/state/state-db.js";

describe("StateDB.normalizePathSeparators", () => {
  let tempDir: string;
  let db: StateDB;

  const track = (obsidianPath: string, notionPageId: string) =>
    db.upsert({
      obsidianPath,
      notionPageId,
      contentHash: "h",
      localLastModified: "2026-10-01T00:00:00Z",
      syncDirection: "both",
      fileType: "file",
      status: "synced",
    });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-win-"));
    db = StateDB.open(join(tempDir, "state.db"));
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("노트 · 위키링크 · 첨부 · 보존 마커의 경로를 / 로 고쳐 적는다", () => {
    track("00 Me\\Daily\\a.md", "page-a");
    db.upsertWikilink({ obsidianPath: "00 Me\\Daily\\a.md", notionPageId: "page-a", title: "a" });
    db.registerFile({
      localPath: "00 Me\\img.png",
      notionPageId: "page-a",
      fileUploadId: "up-1",
      fileType: "image",
      fileHash: "fh",
      fileSize: 1,
    });
    db.storePreserveMarkers("00 Me\\Daily\\a.md", [
      { id: "m1", type: "unknown", content: "x", position: 0 } as never,
    ]);

    expect(db.normalizePathSeparators()).toEqual({ renamed: 1, dropped: 0 });

    expect(db.getByPath("00 Me/Daily/a.md")?.notionPageId).toBe("page-a");
    expect(db.getByPath("00 Me\\Daily\\a.md")).toBeNull();
    expect(db.resolvePageId("page-a")?.obsidianPath).toBe("00 Me/Daily/a.md");
    expect(db.isFileRegistered("00 Me/img.png")).toBe(true);
    expect(db.getPreserveMarkers("00 Me/Daily/a.md")).toHaveLength(1);
  });

  it("같은 노트를 / 로도 추적하면 \\ 쪽 기록(또 올린 사본)의 추적을 놓는다", () => {
    track("00 Me/a.md", "page-original");
    track("00 Me\\a.md", "page-copy");

    expect(db.normalizePathSeparators()).toEqual({ renamed: 0, dropped: 1 });

    expect(db.getByPath("00 Me/a.md")?.notionPageId).toBe("page-original");
    expect(db.getByNotionId("page-copy")).toBeNull();
  });

  it("고칠 것이 없으면 아무것도 바꾸지 않는다", () => {
    track("notes/a.md", "page-a");
    expect(db.normalizePathSeparators()).toEqual({ renamed: 0, dropped: 0 });
    expect(db.getAll()).toHaveLength(1);
  });

  // 여는 순간 고쳐 적는 것은 Windows 에서만이다 — 다른 OS 에서는 \ 가 이름의 글자다. Windows CI 가 앞쪽을 본다.
  it("Windows 에서 열면 고쳐 적고, 다른 OS 에서는 그대로 둔다", () => {
    track("00 Me\\a.md", "page-a");
    db.close();
    db = StateDB.open(join(tempDir, "state.db"));
    const expected = process.platform === "win32" ? "00 Me/a.md" : "00 Me\\a.md";
    expect(db.getByNotionId("page-a")?.obsidianPath).toBe(expected);
  });
});
