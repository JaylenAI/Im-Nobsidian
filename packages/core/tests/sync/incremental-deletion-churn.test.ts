/**
 * 증분 삭제 전파(I10) + content_hash 멱등(I5) 회귀 잠금.
 *
 * 결함(rank4/rank5):
 *  - I10: 증분 변경 감지(detectRemoteChangesIncremental)는 searchRecentPages 만 쓰는데
 *    이 API 는 in_trash/archived 페이지를 반환하지 않아 **삭제를 절대 감지하지 못한다**.
 *    그런데 호출부가 deleteSync 가 켜진 경우에도 이 fast-path 를 타 원격 삭제가 로컬에
 *    전파되지 않았다(고아 잔존·resurrection 위험).
 *  - I5: pullUpdate 는 원격 last_edited 가 바뀌면 변환 결과가 디스크와 바이트 동일해도
 *    파일을 재기록 + updated 집계 → mtime 흔들림과 거짓 churn. push 측도 블록만 바뀌면
 *    new Date()(로컬 시각)를 notionLastEdited 로 저장해 다음 pull 이 가짜 modified 로 오인.
 *
 * 수정:
 *  - I10: deleteSync 가 켜지면 증분 fast-path 를 쓰지 않고 전체 스캔으로 우회 → 사라진
 *    추적 페이지를 삭제로 전파.
 *  - I5: pullUpdate 가 remoteContent===localContent 면 파일을 건드리지 않고 메타만 정렬
 *    (unchanged) → updated 0. pushUpdate 는 Notion 권위 last_edited 를 저장.
 *
 * 가드 유효성: 각 테스트는 수정 전 동작(증분이 삭제 누락 / 동일 콘텐츠 재기록 / 로컬시각
 * 저장)에서 실패하도록 단언한다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
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
};

describe("증분 삭제 전파 + content_hash 멱등 (I10·I5)", () => {
  let vaultFs: ReturnType<typeof createMockVaultFs>;
  let stateDb: ReturnType<typeof createMockStateDb>;
  let notion: ReturnType<typeof createMockNotionClient>;

  beforeEach(() => {
    vaultFs = createMockVaultFs();
    stateDb = createMockStateDb();
    notion = createMockNotionClient();
  });

  function makeOrchestrator(config: Config): SyncOrchestrator {
    return new SyncOrchestrator(config, stateDb as never, notion as never, vaultFs as never);
  }

  // ── I10: 증분/전체 스캔 라우팅 + 삭제 전파 ──────────────────────────────────

  it("deleteSync OFF: 증분 fast-path(searchRecentPages) 를 탄다", async () => {
    stateDb.getMeta.mockImplementation((k: string) =>
      k === "last_pull_at" ? "2026-05-01T00:00:00.000Z" : null,
    );
    stateDb.getAll.mockReturnValue([{ notionPageId: "p1", obsidianPath: "a.md" }]);

    const orch = makeOrchestrator(
      createConfig({ sync: { ...DEFAULT_CONFIG.sync, deleteSync: false } }),
    );
    await orch.pull();

    expect(notion.searchRecentPages).toHaveBeenCalled();
  });

  it("deleteSync ON: 증분을 우회해 전체 스캔(서브트리 순회)으로 삭제를 전파한다", async () => {
    const gone: MutableRecord = {
      id: 1,
      obsidianPath: "gone.md",
      notionPageId: "gone-page",
      notionParentId: "root-page-id",
      contentHash: "h",
      notionLastEdited: "2026-05-01T00:00:00.000Z",
      localLastModified: "2026-05-01T00:00:00.000Z",
      syncDirection: "both",
      fileType: "page",
      localMtime: null,
      localFileSize: null,
      baseSnapshot: null,
    };
    stateDb.getMeta.mockImplementation((k: string) =>
      k === "last_pull_at" ? "2026-05-01T00:00:00.000Z" : null,
    );
    stateDb.getAll.mockReturnValue([gone]);
    stateDb.getByNotionId.mockImplementation((id: string) => (id === "gone-page" ? gone : null));
    // 원격에 더 이상 존재하지 않음(in_trash/archived → 서브트리 순회 결과에서 사라짐).
    notion.getChildPagesRecursive.mockResolvedValue([]);

    const orch = makeOrchestrator(
      createConfig({ sync: { ...DEFAULT_CONFIG.sync, deleteSync: true } }),
    );
    const result = await orch.pull();

    // 증분이 아니라 전체 스캔(서브트리 순회)으로 라우팅됐고, 사라진 페이지가 삭제로 전파됐다.
    expect(notion.searchRecentPages).not.toHaveBeenCalled();
    expect(notion.getChildPagesRecursive).toHaveBeenCalled();
    expect(result.deleted).toBe(1);
    expect(vaultFs.deleteFile).toHaveBeenCalledWith("gone.md");
  });

  // ── I5: pullUpdate content_hash 멱등(동일 콘텐츠 재기록·집계 0) ───────────────

  it("동일 콘텐츠로 수렴한 가짜 modified 는 파일을 재기록하지 않고 updated 0", async () => {
    const rec: MutableRecord = {
      id: 1,
      obsidianPath: "note.md",
      notionPageId: "page-id-123",
      notionParentId: "root-page-id",
      contentHash: computeHash("LOCAL-OLD"),
      notionLastEdited: "2026-05-01T00:00:00.000Z",
      localLastModified: "2026-05-01T00:00:00.000Z",
      syncDirection: "both",
      fileType: "page",
      localMtime: "2026-05-01T00:00:00.000Z",
      localFileSize: 9,
      baseSnapshot: null,
    };
    stateDb.getMeta.mockImplementation((k: string) =>
      k === "last_pull_at" ? "2026-05-01T00:00:00.000Z" : null,
    );
    stateDb.getAll.mockReturnValue([rec]);
    stateDb.getByNotionId.mockImplementation((id: string) => (id === "page-id-123" ? rec : null));
    // upsert 결과를 레코드에 반영해 두 번째 pull 이 갱신된 상태를 본다.
    stateDb.upsert.mockImplementation((r: Partial<MutableRecord>) => {
      Object.assign(rec, r);
      return { id: 1 };
    });
    notion.getPage.mockResolvedValue({
      id: "page-id-123",
      last_edited_time: "2026-05-02T00:00:00.000Z",
      parent: { type: "page_id", page_id: "root-page-id" },
      properties: { title: { type: "title", title: [{ plain_text: "Test Page" }] } },
    });

    const config = createConfig({ sync: { ...DEFAULT_CONFIG.sync, deleteSync: false } });

    // ── pull #1: 로컬과 다른 내용 → 정상 write. 파이프라인 산출물을 캡처한다. ──
    vaultFs.readFile.mockResolvedValue("LOCAL-OLD");
    notion.searchRecentPages.mockResolvedValue([
      { id: "page-id-123", last_edited_time: "2026-05-02T00:00:00.000Z" },
    ]);
    const orch1 = makeOrchestrator(config);
    const r1 = await orch1.pull();
    expect(r1.updated).toBe(1);
    const writeCall = (vaultFs.writeFile as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === "note.md",
    );
    expect(writeCall).toBeDefined();
    const pulledContent = writeCall![1] as string;

    // ── pull #2: 디스크가 방금 pull 된 내용과 동일, Notion last_edited 만 또 바뀜(가짜) ──
    (vaultFs.writeFile as ReturnType<typeof vi.fn>).mockClear();
    vaultFs.readFile.mockResolvedValue(pulledContent);
    notion.getPage.mockResolvedValue({
      id: "page-id-123",
      last_edited_time: "2026-05-03T00:00:00.000Z",
      parent: { type: "page_id", page_id: "root-page-id" },
      properties: { title: { type: "title", title: [{ plain_text: "Test Page" }] } },
    });
    notion.searchRecentPages.mockResolvedValue([
      { id: "page-id-123", last_edited_time: "2026-05-03T00:00:00.000Z" },
    ]);
    const orch2 = makeOrchestrator(config);
    const r2 = await orch2.pull();

    // 콘텐츠가 동일하므로 재기록·집계 0 — false-churn 차단.
    expect(r2.updated).toBe(0);
    expect(vaultFs.writeFile).not.toHaveBeenCalledWith("note.md", expect.any(String));
    // 그래도 notionLastEdited 는 최신 원격값으로 정렬돼 재감지를 멈춘다.
    expect(rec.notionLastEdited).toBe("2026-05-03T00:00:00.000Z");
  });

  // ── I5: pushUpdate 가 Notion 권위 last_edited 를 저장(로컬 시각 금지) ──────────

  it("블록만 push 해도 notionLastEdited 는 Notion 권위값(getPage)으로 저장된다", async () => {
    const rec: MutableRecord = {
      id: 7,
      obsidianPath: "body.md",
      notionPageId: "page-id-123",
      notionParentId: "root-page-id",
      contentHash: computeHash("# Old\n"),
      notionLastEdited: "2026-05-01T00:00:00.000Z",
      localLastModified: "2026-05-01T00:00:00.000Z",
      syncDirection: "both",
      fileType: "page",
      localMtime: "2020-01-01T00:00:00.000Z",
      localFileSize: 6,
      baseSnapshot: Buffer.from("# Old\n", "utf-8"),
    };
    stateDb.getByPath.mockImplementation((p: string) => (p === "body.md" ? rec : null));
    vaultFs.listMarkdownFileStats.mockResolvedValue([
      { path: "body.md", mtime: "2026-05-09T00:00:00.000Z", size: 40 },
    ]);
    vaultFs.readFile.mockResolvedValue("# New body\n\nchanged content");
    vaultFs.getFileStat.mockResolvedValue({ mtime: "2026-05-09T00:00:00.000Z", size: 40 });
    // 블록만 바뀌고 속성 갱신은 없음(페이지 모드) → getPage 권위값 경로를 탄다.
    notion.getPage.mockResolvedValue({
      id: "page-id-123",
      last_edited_time: "2026-05-09T12:34:56.000Z",
      parent: { type: "page_id", page_id: "root-page-id" },
      properties: { title: { type: "title", title: [{ plain_text: "Test Page" }] } },
    });

    const orch = makeOrchestrator(
      createConfig({ sync: { ...DEFAULT_CONFIG.sync, deleteSync: false } }),
    );
    await orch.push();

    // updatePageProperties(속성 갱신)는 호출되지 않고, 저장된 last_edited 는 getPage 권위값.
    expect(notion.updatePageProperties).not.toHaveBeenCalled();
    expect(stateDb.setNotionLastEdited).toHaveBeenCalledWith(7, "2026-05-09T12:34:56.000Z");
  });
});
