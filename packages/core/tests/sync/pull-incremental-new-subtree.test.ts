/**
 * S-08 — 증분 pull 이 새 하위 트리의 자식을 빠뜨리지 않는다.
 *
 * 실측(2026-09-27, 프로브 볼트): 새로 만든 폴더 노트와 그 자식 페이지(둘 다 같은 시각 생성)가
 * 한 번의 증분 pull 에 함께 잡혔는데 폴더 노트만 받고 자식은 빠졌다. 다음 증분 pull 도
 * 「no changes」 였고 `pull --force` 만 받았다. 증분 감지가 부모가 루트거나 이미 추적 중일
 * 때만 새 페이지를 받아, 같은 실행에서 새로 받는 부모의 자식을 버렸다.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";

import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { NotionClient } from "../../src/notion/client.js";
import { NodeVaultFS } from "../../src/sync/node-vault-fs.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { Config } from "../../src/types/config.js";

const ROOT = "11111111111111111111111111111111";
const OLD = "22222222222222222222222222222222";
const PARENT = "33333333333333333333333333333333";
const CHILD = "44444444444444444444444444444444";
const LEAF = "55555555555555555555555555555555";
const STRAY = "66666666666666666666666666666666";
const ELSEWHERE = "77777777777777777777777777777777";

const EDITED = "2026-09-27T09:47:00.000Z";

function page(id: string, title: string, parentId: string): PageObjectResponse {
  return {
    object: "page",
    id,
    last_edited_time: EDITED,
    created_time: EDITED,
    archived: false,
    in_trash: false,
    parent: { type: "page_id", page_id: parentId },
    properties: { title: { type: "title", title: [{ plain_text: title }] } },
  } as unknown as PageObjectResponse;
}

const PAGES = new Map([
  [OLD, page(OLD, "예전 노트", ROOT)],
  [PARENT, page(PARENT, "새 부모", ROOT)],
  [CHILD, page(CHILD, "새 자식", PARENT)],
  [LEAF, page(LEAF, "손자", CHILD)],
  // 동기화 루트 밖(추적하지 않는 부모 아래)의 새 페이지 — 받으면 안 된다.
  [STRAY, page(STRAY, "딴 곳", ELSEWHERE)],
]);

describe("증분 pull — 새 하위 트리 (S-08)", () => {
  let tmpDir: string | null = null;
  let stateDb: StateDB | null = null;

  afterEach(async () => {
    stateDb?.close();
    stateDb = null;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
    vi.restoreAllMocks();
  });

  function offlineClient(recent: string[]): NotionClient {
    const client = new NotionClient({ token: "offline-test" });
    vi.spyOn(client, "getChildPagesRecursive").mockResolvedValue([PAGES.get(OLD)!]);
    vi.spyOn(client, "searchRecentPages").mockResolvedValue(
      recent.map((id) => ({ id, last_edited_time: EDITED })),
    );
    vi.spyOn(client, "getPage").mockImplementation(async (id: string) => {
      const found = PAGES.get(id.replace(/-/g, ""));
      if (!found) throw new Error(`unexpected getPage ${id}`);
      return found;
    });
    vi.spyOn(client, "getPageMarkdown").mockImplementation(
      async (id: string) => ({ markdown: `본문 ${id.replace(/-/g, "")}\n` }) as never,
    );
    vi.spyOn(client, "fetchAllChildrenDeep").mockResolvedValue([]);
    vi.spyOn(client, "getChildDatabaseIds").mockResolvedValue([]);
    return client;
  }

  async function pull(recent: string[]) {
    const config: Config = {
      ...DEFAULT_CONFIG,
      notion: { ...DEFAULT_CONFIG.notion, rootPageId: ROOT, token: "offline-test" },
    };
    const vaultFs = new NodeVaultFS(tmpDir!);
    return new SyncOrchestrator(config, stateDb!, offlineClient(recent), vaultFs).pull();
  }

  async function freshVault() {
    tmpDir = await mkdtemp(join(tmpdir(), "im-newsubtree-"));
    const vaultFs = new NodeVaultFS(tmpDir);
    await vaultFs.ensureFolder(".im-nobsidian");
    stateDb = StateDB.open(join(tmpDir, ".im-nobsidian", "sync.db"));
    // 1회차 — 전체 스캔으로 예전 노트만 받는다. 이후 pull 은 증분 경로를 탄다.
    const first = await pull([]);
    expect(first.created).toBe(1);
  }

  it("같은 실행에서 새로 받는 부모의 자식 · 손자도 받는다 — 깊은 것부터 와도", async () => {
    await freshVault();

    const result = await pull([LEAF, STRAY, CHILD, PARENT]);

    expect(result.failed, JSON.stringify(result.failed)).toEqual([]);
    expect(result.created).toBe(3);
    const pathOf = (id: string) => stateDb!.getByNotionId(id)?.obsidianPath;
    expect(pathOf(PARENT)).toBe("새 부모/새 부모.md");
    expect(pathOf(CHILD)).toBe("새 부모/새 자식/새 자식.md");
    expect(pathOf(LEAF)).toBe("새 부모/새 자식/손자.md");
    expect(await readFile(join(tmpDir!, "새 부모/새 자식/손자.md"), "utf-8")).toContain(
      `본문 ${LEAF}`,
    );
    expect(pathOf(STRAY)).toBeUndefined();
  });

  it("받은 뒤 다시 증분 pull 하면 아무것도 새로 만들지 않는다", async () => {
    await freshVault();
    await pull([LEAF, CHILD, PARENT]);

    const again = await pull([LEAF, STRAY, CHILD, PARENT]);

    expect(again.created).toBe(0);
    expect(again.failed).toEqual([]);
  });
});
