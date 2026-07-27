/**
 * D-DELETE-NORESTORE 회귀 잠금 — 로컬에서 지워진 추적 파일의 복원 (R0).
 *
 * 결함:
 *  원격 변경 감지(detectRemoteChanges / detectRemoteChangesIncremental)는 "Notion 에서
 *  바뀐 것"만 큐에 올린다. 볼트에서 파일이 삭제된 경우는 Notion 쪽 last_edited 가 그대로라
 *  어느 경로로도 잡히지 않아, 재pull 은 물론 `--force` 로도 되살아나지 않았다.
 *  실측(실볼트 4개 삭제): 증분 pull 0/4 복원, --force pull 0/4 복원 — 둘 다 `no changes`.
 *  deleteSync 가 꺼져 있으면 push 도 원격을 지우지 않으므로, 사용자에게 남는 복구 수단은
 *  볼트 전체 초기화 + 재pull(실측 60분) 뿐이었다.
 *
 * 두 겹의 원인이 있었고 둘 다 막아야 한다:
 *  (A) 탐지 부재 — 사라진 파일이 애초에 방문되지 않음 → detectMissingLocalFiles 로 차집합 스캔.
 *  (B) 해소 오판 — 방문되더라도 localContent "" 의 해시가 어긋나 '로컬 수정' 으로 읽혀
 *      manual 은 conflict, local-first 는 skip 으로 빠짐 → resolvePullConflict 의 localExists.
 *      (B) 는 conflict-detector.test.ts 가 별도로 잠근다.
 *
 * 가드 유효성: 각 테스트는 수정 전 동작(복원 0건 / restored 미보고)에서 실패한다.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import type { Config } from "../../src/types/config.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { computeHash } from "../../src/utils/hash.js";
import {
  createMockVaultFs,
  createMockStateDb,
  createMockNotionClient,
  createConfig,
} from "../helpers/mock-orchestrator.js";

type MutableRecord = {
  id: number;
  obsidianPath: string;
  notionPageId: string;
  notionParentId: string | null;
  contentHash: string;
  notionLastEdited: string;
  localLastModified: string;
  syncDirection: string;
  fileType: string;
  status: string;
  localMtime: string | null;
  localFileSize: number | null;
  baseSnapshot: Buffer | null;
  updatedAt: string;
};

function makeRecord(overrides?: Partial<MutableRecord>): MutableRecord {
  return {
    id: 1,
    obsidianPath: "notes/gone.md",
    notionPageId: "page-gone",
    notionParentId: "root-page-id",
    contentHash: computeHash("ORIGINAL BODY"),
    notionLastEdited: "2026-05-01T00:00:00.000Z",
    localLastModified: "2026-05-01T00:00:00.000Z",
    syncDirection: "both",
    fileType: "file",
    status: "synced",
    localMtime: "2026-05-01T00:00:00.000Z",
    localFileSize: 13,
    baseSnapshot: Buffer.from("ORIGINAL BODY", "utf-8"),
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("삭제된 로컬 파일 복원 (D-DELETE-NORESTORE)", () => {
  let vaultFs: ReturnType<typeof createMockVaultFs>;
  let stateDb: ReturnType<typeof createMockStateDb>;
  let notion: ReturnType<typeof createMockNotionClient>;

  beforeEach(() => {
    vaultFs = createMockVaultFs();
    stateDb = createMockStateDb();
    notion = createMockNotionClient();
  });

  function makeOrchestrator(config?: Config): SyncOrchestrator {
    return new SyncOrchestrator(
      config ?? createConfig({ sync: { ...DEFAULT_CONFIG.sync, deleteSync: false } }),
      stateDb as never,
      notion as never,
      vaultFs as never,
    );
  }

  /** 원격은 멀쩡한데 로컬 파일만 사라진 상황을 만든다. */
  function stageMissingFile(record: MutableRecord): void {
    stateDb.getMeta.mockImplementation((k: string) =>
      k === "last_pull_at" ? "2026-05-01T00:00:00.000Z" : null,
    );
    stateDb.getAll.mockReturnValue([record]);
    stateDb.getByNotionId.mockImplementation((id: string) =>
      id === record.notionPageId ? record : null,
    );
    // 볼트 워크 결과가 비어 있다 = 추적 중인 파일이 디스크에 없다.
    vaultFs.listMarkdownFileStats.mockResolvedValue([]);
    vaultFs.readFile.mockRejectedValue(new Error("ENOENT"));
    vaultFs.exists.mockResolvedValue(false);
    // Notion 은 아무 변화 없음 — 증분·전체 스캔 모두 0건을 보고한다.
    notion.searchRecentPages.mockResolvedValue([]);
    notion.getChildPagesRecursive.mockResolvedValue([]);
    notion.getPage.mockResolvedValue({
      id: record.notionPageId,
      last_edited_time: record.notionLastEdited,
      parent: { type: "page_id", page_id: "root-page-id" },
      properties: { title: { type: "title", title: [{ plain_text: "Gone Note" }] } },
    });
  }

  it("원격 변경이 0건이어도 사라진 파일을 되살린다", async () => {
    const rec = makeRecord();
    stageMissingFile(rec);

    const result = await makeOrchestrator().pull();

    // 수정 전: 큐가 비어 emptyResult 로 조기 반환 → writeFile 미호출, restored 0.
    expect(vaultFs.writeFile).toHaveBeenCalledWith("notes/gone.md", expect.any(String));
    expect(result.restored).toBe(1);
    // 복원은 updated 에 섞지 않는다 — 파일이 없어졌었다는 사실이 요약에서 사라지면 안 된다.
    expect(result.updated).toBe(0);
  });

  it("local-first 전략에서도 복원한다 (사라진 파일에는 지킬 로컬 편집이 없다)", async () => {
    const rec = makeRecord();
    stageMissingFile(rec);

    const result = await makeOrchestrator(
      createConfig({
        sync: { ...DEFAULT_CONFIG.sync, deleteSync: false, conflictStrategy: "local-first" },
      }),
    ).pull();

    // 수정 전: localContent "" 가 '로컬 수정' 으로 읽혀 skip → 삭제가 영구히 굳었다.
    expect(result.restored).toBe(1);
    expect(vaultFs.writeFile).toHaveBeenCalledWith("notes/gone.md", expect.any(String));
  });

  it("manual 전략에서도 충돌이 아니라 복원이다", async () => {
    const rec = makeRecord();
    stageMissingFile(rec);

    const result = await makeOrchestrator(
      createConfig({
        sync: { ...DEFAULT_CONFIG.sync, deleteSync: false, conflictStrategy: "manual" },
      }),
    ).pull();

    expect(result.conflicts).toHaveLength(0);
    expect(result.restored).toBe(1);
  });

  it("디스크에 살아 있는 파일은 복원 대상이 아니다(불필요한 재기록 없음)", async () => {
    const rec = makeRecord();
    stageMissingFile(rec);
    // 파일이 실재한다 → 차집합에서 빠져야 한다.
    vaultFs.listMarkdownFileStats.mockResolvedValue([
      { path: "notes/gone.md", mtime: "2026-05-01T00:00:00.000Z", size: 13 },
    ]);

    const result = await makeOrchestrator().pull();

    expect(result.restored).toBe(0);
    expect(vaultFs.writeFile).not.toHaveBeenCalled();
    expect(notion.getPage).not.toHaveBeenCalled();
  });

  it("--path 범위 밖의 사라진 파일은 건드리지 않는다", async () => {
    const rec = makeRecord({ obsidianPath: "other/gone.md" });
    stageMissingFile(rec);

    const result = await makeOrchestrator().pull({ paths: ["notes"] });

    expect(result.restored).toBe(0);
    expect(vaultFs.writeFile).not.toHaveBeenCalled();
  });

  it("db-row 는 여기서 복원하지 않는다 (database-syncer 가 매 pull 마다 처리)", async () => {
    // 행 전용 frontmatter 없이 본문만 쓰는 잘못된 경로로 새는 것을 막는 가드.
    const rec = makeRecord({ fileType: "db-row" });
    stageMissingFile(rec);

    const result = await makeOrchestrator().pull();

    expect(result.restored).toBe(0);
    expect(vaultFs.writeFile).not.toHaveBeenCalled();
  });

  it("deleteSync ON 이면 복원하지 않는다 (로컬 삭제 = 원격에도 지우라는 의사 표시)", async () => {
    // sync() 는 pull → push 순서다. 여기서 되살리면 뒤이은 push 가 지울 대상을 잃어
    // 사용자의 삭제 의도가 통째로 무효화된다.
    const rec = makeRecord();
    stageMissingFile(rec);

    const result = await makeOrchestrator(
      createConfig({ sync: { ...DEFAULT_CONFIG.sync, deleteSync: true } }),
    ).pull();

    expect(result.restored).toBe(0);
    expect(vaultFs.writeFile).not.toHaveBeenCalledWith("notes/gone.md", expect.any(String));
  });

  it("folder-only 레코드는 파일 부재가 정상이므로 복원 대상이 아니다", async () => {
    const rec = makeRecord({ fileType: "folder-only", obsidianPath: "notes/폴더" });
    stageMissingFile(rec);

    const result = await makeOrchestrator().pull();

    expect(result.restored).toBe(0);
    expect(vaultFs.writeFile).not.toHaveBeenCalled();
  });

  it("원격도 휴지통이면 빈 껍데기를 만들지 않는다", async () => {
    const rec = makeRecord();
    stageMissingFile(rec);
    notion.getPage.mockResolvedValue({
      id: rec.notionPageId,
      last_edited_time: rec.notionLastEdited,
      in_trash: true,
      archived: true,
      parent: { type: "page_id", page_id: "root-page-id" },
      properties: { title: { type: "title", title: [{ plain_text: "Gone Note" }] } },
    });

    const result = await makeOrchestrator().pull();

    expect(result.restored).toBe(0);
    expect(result.failed).toHaveLength(0);
    expect(vaultFs.writeFile).not.toHaveBeenCalled();
  });

  it("로컬 이름변경은 복원하지 않는다 (원본+사본 이중화 방지)", async () => {
    const rec = makeRecord({ localFileSize: 13 });
    stageMissingFile(rec);
    // 사용자가 Obsidian 에서 이름만 바꿨다 — 내용은 그대로다.
    vaultFs.listMarkdownFileStats.mockResolvedValue([
      { path: "notes/renamed.md", mtime: "2026-05-02T00:00:00.000Z", size: 13 },
    ]);
    vaultFs.readFile.mockImplementation(async (p: string) => {
      if (p === "notes/renamed.md") return "ORIGINAL BODY";
      throw new Error("ENOENT");
    });

    const result = await makeOrchestrator().pull();

    expect(result.restored).toBe(0);
    expect(vaultFs.writeFile).not.toHaveBeenCalledWith("notes/gone.md", expect.any(String));
  });

  it("크기만 같고 내용이 다른 미추적 파일은 이름변경이 아니다 → 복원한다", async () => {
    const rec = makeRecord({ localFileSize: 13 });
    stageMissingFile(rec);
    vaultFs.listMarkdownFileStats.mockResolvedValue([
      { path: "notes/unrelated.md", mtime: "2026-05-02T00:00:00.000Z", size: 13 },
    ]);
    vaultFs.readFile.mockImplementation(async (p: string) => {
      if (p === "notes/unrelated.md") return "DIFFERENT!!!"; // 같은 크기, 다른 내용
      throw new Error("ENOENT");
    });

    const result = await makeOrchestrator().pull();

    expect(result.restored).toBe(1);
  });

  it("localFileSize 가 없는 구버전 레코드도 이름변경을 알아본다", async () => {
    // 크기 버킷은 후보를 좁히는 최적화일 뿐이다. 값이 없다고 대조를 포기하면
    // 이름만 바꾼 파일이 원본 이름으로 되살아나 사본이 둘 생긴다.
    const rec = makeRecord({ localFileSize: null });
    stageMissingFile(rec);
    vaultFs.listMarkdownFileStats.mockResolvedValue([
      { path: "notes/renamed.md", mtime: "2026-05-02T00:00:00.000Z", size: 13 },
    ]);
    vaultFs.readFile.mockImplementation(async (p: string) => {
      if (p === "notes/renamed.md") return "ORIGINAL BODY";
      throw new Error("ENOENT");
    });

    const result = await makeOrchestrator().pull();

    expect(result.restored).toBe(0);
    expect(vaultFs.writeFile).not.toHaveBeenCalledWith("notes/gone.md", expect.any(String));
  });

  it("dry-run 은 복원 예정 건수를 미리 보고한다", async () => {
    const rec = makeRecord();
    stageMissingFile(rec);

    const result = await makeOrchestrator().pull({ dryRun: true });

    expect(result.restored).toBe(1);
    expect(vaultFs.writeFile).not.toHaveBeenCalled();
  });

  it("원격 변경으로 이미 큐에 오른 페이지는 중복 처리하지 않는다", async () => {
    const rec = makeRecord();
    stageMissingFile(rec);
    // 같은 페이지가 원격에서도 수정됨 → filtered 에 이미 존재.
    notion.searchRecentPages.mockResolvedValue([
      { id: rec.notionPageId, last_edited_time: "2026-05-02T00:00:00.000Z" },
    ]);
    notion.getPage.mockResolvedValue({
      id: rec.notionPageId,
      last_edited_time: "2026-05-02T00:00:00.000Z",
      parent: { type: "page_id", page_id: "root-page-id" },
      properties: { title: { type: "title", title: [{ plain_text: "Gone Note" }] } },
    });

    const result = await makeOrchestrator().pull();

    // 한 번만 기록되고, 원격 변경 경로로 처리됐으므로 updated 로 집계된다.
    const writes = (
      vaultFs.writeFile as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.filter((c) => c[0] === "notes/gone.md");
    expect(writes).toHaveLength(1);
    expect(result.restored).toBe(0);
    expect(result.updated).toBe(1);
  });
});
