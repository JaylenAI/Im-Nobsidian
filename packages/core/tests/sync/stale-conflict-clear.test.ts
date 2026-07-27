import { describe, it, expect, beforeEach } from "vitest";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { computeHash } from "../../src/utils/hash.js";
import type { Conflict, SyncRecord } from "../../src/types/sync.js";
import {
  createMockVaultFs,
  createMockStateDb,
  createMockNotionClient,
  createConfig,
} from "../helpers/mock-orchestrator.js";

/**
 * R4 D-STALE-CONFLICT 회귀 잠금.
 *
 * push 는 `conflict` 상태의 레코드를 통째로 건너뛴다. 그런데 충돌 표시를 지우는 경로는
 * `nobsi resolve` 하나뿐이라, 사용자가 편집기에서 손으로 양쪽을 맞춰 놓으면 그 파일은
 * 영원히 `conflict` 로 남는다 — 이후 모든 편집이 **아무 오류 없이** Notion 에 안 올라간다.
 * 조용한 정체라 사용자가 알아챌 방법이 없어서, 양쪽이 이미 같아진 항목은 자동으로
 * 걷어낸다. 다만 "같다"의 판정을 느슨하게 하면 진짜 충돌을 삼키므로 경계를 못 박는다.
 */
describe("SyncOrchestrator.clearStaleConflicts", () => {
  let orchestrator: SyncOrchestrator;
  let mockStateDb: ReturnType<typeof createMockStateDb>;

  beforeEach(() => {
    mockStateDb = createMockStateDb();
    orchestrator = new SyncOrchestrator(
      createConfig(),
      mockStateDb as never,
      createMockNotionClient() as never,
      createMockVaultFs(),
    );
  });

  function makeRecord(overrides?: Partial<SyncRecord>): SyncRecord {
    return {
      id: "rec-1",
      obsidianPath: "Notes/a.md",
      notionPageId: "page-1",
      notionParentId: "root-page-id",
      contentHash: "old-hash",
      notionLastEdited: "2026-01-01T00:00:00.000Z",
      localLastModified: "2026-01-01T00:00:00.000Z",
      syncDirection: "both",
      fileType: "markdown",
      status: "conflict",
      baseSnapshot: null,
      localMtime: null,
      localFileSize: null,
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  function makeConflict(
    local: string,
    remote: string,
    overrides?: { record?: Partial<SyncRecord>; lastEdited?: string },
  ): Conflict {
    const record = makeRecord(overrides?.record);
    return {
      syncRecord: record,
      localChange: { path: record.obsidianPath, type: "modified", hash: computeHash(local) },
      remoteChange: {
        pageId: record.notionPageId ?? "",
        type: "modified",
        lastEdited: overrides?.lastEdited ?? "2026-02-02T00:00:00.000Z",
        previousEdited: null,
      },
      baseContent: null,
      localContent: local,
      remoteContent: remote,
    };
  }

  it("양쪽이 바이트 동일하면 충돌 표시를 걷어내고 synced 로 되돌린다", () => {
    const content = "# 같음\n\n본문\n";
    const cleared = orchestrator.clearStaleConflicts([makeConflict(content, content)]);

    expect(cleared).toEqual(["Notes/a.md"]);
    expect(mockStateDb.updateStatus).toHaveBeenCalledWith("rec-1", "synced");
    // 해시·스냅샷을 현재 내용으로 맞춰 둬야 다음 감지가 이 파일을 다시 수정으로 보지 않는다.
    expect(mockStateDb.updateHash).toHaveBeenCalledWith(
      "rec-1",
      computeHash(content),
      Buffer.from(content, "utf-8"),
    );
  });

  it("원격 시각을 함께 정렬한다 — 낡은 기준점은 다음 pull 을 재충돌시킨다", () => {
    const content = "동일";
    orchestrator.clearStaleConflicts([
      makeConflict(content, content, { lastEdited: "2026-03-03T00:00:00.000Z" }),
    ]);

    expect(mockStateDb.setNotionLastEdited).toHaveBeenCalledWith(
      "rec-1",
      "2026-03-03T00:00:00.000Z",
    );
  });

  it("내용이 다르면 손대지 않는다 — 진짜 충돌을 삼키면 안 된다", () => {
    const cleared = orchestrator.clearStaleConflicts([makeConflict("로컬 편집", "원격 편집")]);

    expect(cleared).toEqual([]);
    expect(mockStateDb.updateStatus).not.toHaveBeenCalled();
    expect(mockStateDb.updateHash).not.toHaveBeenCalled();
  });

  it("양쪽 다 비었으면 건너뛴다 — '같다'가 아니라 '둘 다 사라졌다'이므로 삭제 전파의 몫", () => {
    const cleared = orchestrator.clearStaleConflicts([makeConflict("", "")]);

    expect(cleared).toEqual([]);
    expect(mockStateDb.updateStatus).not.toHaveBeenCalled();
  });

  it("한쪽만 비면 충돌로 남긴다 (삭제 vs 편집)", () => {
    expect(orchestrator.clearStaleConflicts([makeConflict("", "원격 본문")])).toEqual([]);
    expect(orchestrator.clearStaleConflicts([makeConflict("로컬 본문", "")])).toEqual([]);
    expect(mockStateDb.updateStatus).not.toHaveBeenCalled();
  });

  it("섞여 들어와도 해소된 것만 골라 낸다", () => {
    const same = "수렴함";
    const cleared = orchestrator.clearStaleConflicts([
      makeConflict("로컬", "원격", { record: { id: "rec-a", obsidianPath: "A.md" } }),
      makeConflict(same, same, { record: { id: "rec-b", obsidianPath: "B.md" } }),
    ]);

    expect(cleared).toEqual(["B.md"]);
    expect(mockStateDb.updateStatus).toHaveBeenCalledTimes(1);
    expect(mockStateDb.updateStatus).toHaveBeenCalledWith("rec-b", "synced");
  });
});
