/**
 * 감지가 빠뜨린 자식 페이지를 받은 본문으로 채운다.
 *
 * 결함(2026-10-22 실데이터 E2E): 1,492 페이지를 만든 직후 빈 볼트로 받으면 순회가 시간 상한을 넘어
 * search 로 보충하는데, search 가 갓 만든 페이지 일부를 돌려주지 않았다 — 1,614 가운데 40 이 빠진 채
 * 실패 0 으로 끝났다. 다음 실행도 증분이라 그 페이지들의 수정 시각이 조회 창 밖이면 다시 보이지 않는다.
 *
 * 받은 부모의 본문에는 자식 페이지 태그(`<page url=…>`)가 실린다 — 감지가 놓친 자식을 추가 요청
 * 없이 알 수 있다.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { DiscoveryTooLargeError } from "../../src/notion/client.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import {
  createMockVaultFs,
  createMockStateDb,
  createMockNotionClient,
  createConfig,
} from "../helpers/mock-orchestrator.js";

const ROOT = "root-page-id";
const PARENT = "11111111111111111111111111111111";
const CHILD = "22222222222222222222222222222222";
const GRANDCHILD = "33333333333333333333333333333333";
const TRASHED = "44444444444444444444444444444444";

function pg(id: string, parent = ROOT, extra: Record<string, unknown> = {}) {
  return {
    id,
    last_edited_time: "2026-01-01T00:00:00.000Z",
    parent: { type: "page_id", page_id: parent },
    archived: false,
    in_trash: false,
    properties: {},
    ...extra,
  } as never;
}

const compact = (id: string) => id.replace(/-/g, "");
const tag = (id: string, title: string) =>
  `<page url="https://www.notion.so/${id}">${title}</page>`;

describe("감지가 빠뜨린 자식 페이지 — 받은 본문의 자식 태그로 채운다", () => {
  let vaultFs: ReturnType<typeof createMockVaultFs>;
  let stateDb: ReturnType<typeof createMockStateDb>;
  let notion: ReturnType<typeof createMockNotionClient>;
  const pages = new Map<string, unknown>();
  const bodies = new Map<string, string>();

  beforeEach(() => {
    vaultFs = createMockVaultFs();
    stateDb = createMockStateDb();
    notion = createMockNotionClient();
    pages.clear();
    bodies.clear();
    notion.getPage.mockImplementation(async (id: string) => pages.get(compact(id)) ?? pg(id));
    notion.getPageMarkdown.mockImplementation(async (id: string) => ({
      markdown: bodies.get(compact(id)) ?? "",
      truncated: false,
      unknown_block_ids: [],
    }));
  });

  const orchestrator = () =>
    new SyncOrchestrator(createConfig(), stateDb as never, notion as never, vaultFs as never);

  it("search 가 돌려주지 않은 자식을 부모 본문에서 찾아 받는다 — 여러 층까지", async () => {
    pages.set(PARENT, pg(PARENT));
    pages.set(CHILD, pg(CHILD, PARENT));
    pages.set(GRANDCHILD, pg(GRANDCHILD, CHILD));
    bodies.set(PARENT, `글\n${tag(CHILD, "자식")}`);
    bodies.set(CHILD, `${tag(GRANDCHILD, "손자")}`);
    notion.getChildPagesRecursive.mockRejectedValue(new DiscoveryTooLargeError(90_001, []));
    notion.getPagesUnderRootViaSearch.mockResolvedValue([pg(PARENT)] as never);

    const result = await orchestrator().pull();

    // 수정 전: 부모 1 만 받고 실패 0 으로 끝났다.
    expect(result.created).toBe(3);
    expect(result.failed).toEqual([]);
  });

  it("이미 감지한 자식 · 추적 중인 자식은 두 번 받지 않는다", async () => {
    pages.set(PARENT, pg(PARENT));
    pages.set(CHILD, pg(CHILD, PARENT));
    bodies.set(PARENT, tag(CHILD, "자식"));
    notion.getChildPagesRecursive.mockResolvedValue([pg(PARENT), pg(CHILD, PARENT)] as never);

    const result = await orchestrator().pull();

    expect(result.created).toBe(2);
  });

  it("휴지통의 자식 · 다른 부모로 옮겨진 페이지는 받지 않는다", async () => {
    pages.set(PARENT, pg(PARENT));
    pages.set(TRASHED, pg(TRASHED, PARENT, { in_trash: true }));
    pages.set(CHILD, pg(CHILD, "55555555555555555555555555555555"));
    bodies.set(PARENT, `${tag(TRASHED, "버림")}\n${tag(CHILD, "옮김")}`);
    notion.getChildPagesRecursive.mockResolvedValue([pg(PARENT)] as never);

    const result = await orchestrator().pull();

    expect(result.created).toBe(1);
  });

  it("DB 모드는 행의 하위 페이지를 받지 않는다 — 예전과 같다", async () => {
    pages.set(PARENT, pg(PARENT));
    pages.set(CHILD, pg(CHILD, PARENT));
    bodies.set(PARENT, tag(CHILD, "자식"));
    notion.queryAllDatabasePages = (async () => [pg(PARENT)]) as never;

    const result = await new SyncOrchestrator(
      createConfig({
        notion: { ...DEFAULT_CONFIG.notion, rootPageId: "", databaseId: "db-1" },
        sync: { ...DEFAULT_CONFIG.sync },
      } as never),
      stateDb as never,
      notion as never,
      vaultFs as never,
    ).pull();

    expect(notion.getPage).not.toHaveBeenCalledWith(CHILD);
    expect(result.created).toBeLessThanOrEqual(1);
  });
});
