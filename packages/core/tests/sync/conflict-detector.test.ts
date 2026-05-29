import { describe, it, expect } from "vitest";
import { resolvePullConflict } from "../../src/sync/conflict-detector.js";
import type { RemoteChange, SyncRecord } from "../../src/types/sync.js";
import { computeHash } from "../../src/utils/hash.js";

function createRecord(overrides?: Partial<SyncRecord>): SyncRecord {
  return {
    id: "rec-1",
    obsidianPath: "notes/page.md",
    notionPageId: "page-1",
    notionParentId: "db-1",
    contentHash: "synced-hash",
    notionLastEdited: "2026-05-16T00:00:00.000Z",
    localLastModified: "2026-05-16T00:00:00.000Z",
    syncDirection: "both",
    fileType: "db-row",
    status: "synced",
    baseSnapshot: Buffer.from("BASE", "utf-8"),
    localMtime: null,
    localFileSize: null,
    version: 1,
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
    ...overrides,
  };
}

const remoteChange: RemoteChange = {
  pageId: "page-1",
  type: "modified",
  lastEdited: "2026-05-16T02:00:00.000Z",
  previousEdited: "2026-05-16T00:00:00.000Z",
};

describe("resolvePullConflict", () => {
  it("로컬 미수정(해시 일치)이면 전략과 무관하게 write", () => {
    const localContent = "LOCAL";
    const record = createRecord({ contentHash: computeHash(localContent) });

    for (const strategy of ["manual", "local-first", "remote-first", "duplicate"] as const) {
      const result = resolvePullConflict({
        record,
        localContent,
        remoteContent: "REMOTE",
        remoteChange,
        strategy,
      });
      expect(result.action).toBe("write");
      expect(result.conflict).toBeUndefined();
    }
  });

  it("로컬 수정 + remote-first → write (로컬 덮어쓰기)", () => {
    const result = resolvePullConflict({
      record: createRecord({ contentHash: "synced-hash" }),
      localContent: "LOCALLY EDITED",
      remoteContent: "REMOTE",
      remoteChange,
      strategy: "remote-first",
    });
    expect(result.action).toBe("write");
  });

  it("로컬 수정 + local-first → skip (로컬 보존)", () => {
    const result = resolvePullConflict({
      record: createRecord({ contentHash: "synced-hash" }),
      localContent: "LOCALLY EDITED",
      remoteContent: "REMOTE",
      remoteChange,
      strategy: "local-first",
    });
    expect(result.action).toBe("skip");
    expect(result.conflict).toBeUndefined();
  });

  it("로컬 수정 + manual → conflict (충돌 객체 구성)", () => {
    const record = createRecord({ contentHash: "synced-hash" });
    const result = resolvePullConflict({
      record,
      localContent: "LOCALLY EDITED",
      remoteContent: "REMOTE CHANGED",
      remoteChange,
      strategy: "manual",
    });

    expect(result.action).toBe("conflict");
    expect(result.conflict).toBeDefined();
    expect(result.conflict!.syncRecord).toBe(record);
    expect(result.conflict!.localContent).toBe("LOCALLY EDITED");
    expect(result.conflict!.remoteContent).toBe("REMOTE CHANGED");
    expect(result.conflict!.baseContent).toBe("BASE");
    expect(result.conflict!.remoteChange).toBe(remoteChange);
    expect(result.conflict!.localChange).toEqual({
      path: "notes/page.md",
      type: "modified",
      currentHash: result.localHash,
      previousHash: "synced-hash",
    });
  });

  it("로컬 수정 + duplicate → conflict", () => {
    const result = resolvePullConflict({
      record: createRecord({ contentHash: "synced-hash" }),
      localContent: "LOCALLY EDITED",
      remoteContent: "REMOTE",
      remoteChange,
      strategy: "duplicate",
    });
    expect(result.action).toBe("conflict");
  });

  it("baseSnapshot 이 없으면 baseContent 는 null", () => {
    const result = resolvePullConflict({
      record: createRecord({ contentHash: "synced-hash", baseSnapshot: null }),
      localContent: "LOCALLY EDITED",
      remoteContent: "REMOTE",
      remoteChange,
      strategy: "manual",
    });
    expect(result.action).toBe("conflict");
    expect(result.conflict!.baseContent).toBeNull();
  });

  // --- 거짓 충돌 방지 (Phase 3) ---

  it("로컬 수정 + 리모트 내용이 base 와 동일 → manual 이어도 충돌 아님(로컬 보존 skip)", () => {
    // 리모트는 last_edited 만 갱신된 가짜 변경. 로컬만 실제로 바뀜.
    const result = resolvePullConflict({
      record: createRecord({ contentHash: "synced-hash", baseSnapshot: Buffer.from("BASE") }),
      localContent: "LOCALLY EDITED",
      remoteContent: "BASE",
      remoteChange,
      strategy: "manual",
    });
    expect(result.action).toBe("skip");
    expect(result.conflict).toBeUndefined();
  });

  it("로컬·리모트 내용이 이미 동일 → 충돌 아님(write 로 정리)", () => {
    const result = resolvePullConflict({
      record: createRecord({ contentHash: "synced-hash", baseSnapshot: Buffer.from("BASE") }),
      localContent: "CONVERGED",
      remoteContent: "CONVERGED",
      remoteChange,
      strategy: "duplicate",
    });
    expect(result.action).toBe("write");
    expect(result.conflict).toBeUndefined();
  });

  it("base 가 없고 리모트가 로컬과 다르면 여전히 충돌(보수적 동작 유지)", () => {
    const result = resolvePullConflict({
      record: createRecord({ contentHash: "synced-hash", baseSnapshot: null }),
      localContent: "LOCALLY EDITED",
      remoteContent: "REMOTE DIFFERENT",
      remoteChange,
      strategy: "manual",
    });
    expect(result.action).toBe("conflict");
  });
});
