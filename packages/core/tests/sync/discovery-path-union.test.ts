/**
 * R12-A 회귀 잠금 — 디스커버리 두 경로를 **경합시키지 않고 합집합**으로 쓴다.
 *
 * 결함: 페이지 모드 디스커버리에는 경로가 둘이다.
 *   ① 직접 순회 getChildPagesRecursive — 시간 예산(90s) 초과 시 DiscoveryTooLargeError
 *   ② search 폴백 getPagesUnderRootViaSearch — ① 이 던지면 갈아탄다
 * ① 이 그때까지 찾은 결과를 **버리고** 던졌기 때문에, 어느 경로의 결과를 쓰는지를
 * 벽시계가 정했다. 두 경로는 같은 집합을 내지 않는다 — search 는 워크스페이스 색인에
 * 의존하고 순회는 마감에 걸린다. 실제로 같은 볼트 clean-slate 실행에서 첫 pull 은
 * 폴백(search)으로, 재 pull 은 순회로 돌았고 페이지 수가 회차마다 흔들렸다.
 *
 * 이걸 기존 게이트가 못 본 이유도 R11 과 같다: 두 번째 실행이 더 **적게** 찾아도
 * created/updated 는 0 이라 `repull churn 0` 이다. 멱등성은 완결성을 말해주지 않는다.
 *
 * 그리고 deleteSync 가 켜져 있으면 유실로 끝나지 않는다 — 이번 열거에 안 잡힌 추적
 * 페이지는 orphan 으로 판정되어 **삭제**된다(orchestrator detectRemoteChanges).
 * 한 경로가 만든 파일을 다른 경로가 지우는 R11-A 의 진동이 페이지 쪽에 그대로 있었다.
 *
 * 가드 유효성: 아래 테스트들은 수정 전 동작(부분 결과 폐기 → search 결과만 사용)에서
 * 실패하도록 단언한다.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { DiscoveryTooLargeError } from "../../src/notion/client.js";
import type { Config } from "../../src/types/config.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import {
  createMockVaultFs,
  createMockStateDb,
  createMockNotionClient,
  createConfig,
} from "../helpers/mock-orchestrator.js";

const ROOT = "root-page-id";

function pg(id: string, parent = ROOT) {
  return {
    id,
    last_edited_time: "2026-01-01T00:00:00.000Z",
    parent: { type: "page_id", page_id: parent },
    archived: false,
    in_trash: false,
    properties: {},
  } as never;
}

describe("R12-A — 디스커버리 경로 합집합", () => {
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

  /** 순회가 `partial` 를 찾고 마감 초과, search 는 `viaSearch` 를 낸다. */
  function arrangeSplitDiscovery(partial: string[], viaSearch: string[]): void {
    notion.getChildPagesRecursive.mockRejectedValue(
      new DiscoveryTooLargeError(90_001, partial.map((id) => pg(id)) as never),
    );
    notion.getPagesUnderRootViaSearch.mockResolvedValue(viaSearch.map((id) => pg(id)) as never);
  }

  it("순회 부분 결과와 search 결과를 합쳐 어느 쪽에서만 보인 페이지도 잃지 않는다", async () => {
    // bfs-only 는 search 색인에 아직 안 잡힌 페이지, search-only 는 마감 뒤 가지의 페이지.
    arrangeSplitDiscovery(["bfs-only", "both"], ["both", "search-only"]);

    const result = await makeOrchestrator(createConfig()).pull();

    // 수정 전에는 search 결과만 써서 bfs-only 가 통째로 빠졌다(created 2).
    expect(result.created).toBe(3);
  });

  it("합집합은 중복을 남기지 않는다 — 같은 페이지를 두 번 만들지 않는다", async () => {
    arrangeSplitDiscovery(["dup-a", "dup-b"], ["dup-a", "dup-b"]);

    const result = await makeOrchestrator(createConfig()).pull();

    expect(result.created).toBe(2);
  });

  it("deleteSync ON: 순회에서만 보인 추적 페이지를 고아로 오판해 지우지 않는다", async () => {
    const tracked = {
      id: 1,
      obsidianPath: "bfs-only.md",
      notionPageId: "bfs-only",
      notionParentId: ROOT,
      contentHash: "h",
      notionLastEdited: "2026-01-01T00:00:00.000Z",
      localLastModified: "2026-01-01T00:00:00.000Z",
      syncDirection: "both",
      fileType: "page",
      localMtime: null,
      localFileSize: null,
      baseSnapshot: null,
    };
    stateDb.getMeta.mockImplementation((k: string) =>
      k === "last_pull_at" ? "2026-05-01T00:00:00.000Z" : null,
    );
    stateDb.getAll.mockReturnValue([tracked]);
    stateDb.getByNotionId.mockImplementation((id: string) => (id === "bfs-only" ? tracked : null));
    // search 는 이 페이지를 못 봤다(색인 지연·부모 해소 실패 등).
    arrangeSplitDiscovery(["bfs-only"], []);

    const result = await makeOrchestrator(
      createConfig({ sync: { ...DEFAULT_CONFIG.sync, deleteSync: true } }),
    ).pull();

    // 수정 전: 순회 결과가 버려져 "원격에 없음" → deleted 1 + 파일 삭제(파괴적 진동).
    expect(result.deleted).toBe(0);
    expect(vaultFs.deleteFile).not.toHaveBeenCalled();
  });

  it("마감 초과가 아닌 오류는 삼키지 않고 그대로 전파한다", async () => {
    notion.getChildPagesRecursive.mockRejectedValue(new Error("401 unauthorized"));

    await expect(makeOrchestrator(createConfig()).pull()).rejects.toThrow("401 unauthorized");
    expect(notion.getPagesUnderRootViaSearch).not.toHaveBeenCalled();
  });

  it("순회가 예산 안에 끝나면 search 를 부르지 않는다(폴백 비용 미발생)", async () => {
    notion.getChildPagesRecursive.mockResolvedValue([pg("a"), pg("b")] as never);

    const result = await makeOrchestrator(createConfig()).pull();

    expect(notion.getPagesUnderRootViaSearch).not.toHaveBeenCalled();
    expect(result.created).toBe(2);
  });
});
