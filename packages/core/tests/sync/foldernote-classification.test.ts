/**
 * 폴더노트 분류 회귀 잠금 — "폴더노트 본문분리" 결함(릴리스 블로커) 재발 방지.
 *
 * 결함: 자식 페이지가 callout·column·toggle 같은 컨테이너 블록 안에 중첩돼 있으면,
 * pullCreate 의 얕은 판정(최상위 블록 첫 페이지에서 child_page 만 검사)이 자식을 놓쳐
 * 폴더노트를 file 로 오분류한다. 그 결과 본문이 폴더 밖 최상위로 기록되고
 * resolveUniqueFilePath 충돌로 'X.md'(빈) + 'X (1).md'(본문) 처럼 쪼개졌다.
 *
 * 수정: 발견 단계에서 전 페이지의 부모를 해소하며 만든 _childParentIds 집합으로
 * 폴더 여부를 신뢰성 있게 판정(컨테이너 중첩·child_database 포함).
 *
 * 본 테스트는 실제 결함 구조(부모는 본문 보유 + 자식은 callout 안에 중첩)를 mock 으로
 * 재현하고, 본문이 폴더 안 폴더노트로 기록되며 최상위 분리가 0 임을 단언한다.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  PageObjectResponse,
  BlockObjectResponse,
} from "@notionhq/client/build/src/api-endpoints.js";

import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { NotionClient } from "../../src/notion/client.js";
import { NodeVaultFS } from "../../src/sync/node-vault-fs.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { Config } from "../../src/types/config.js";

const ROOT = "11111111111111111111111111111111";
const HUB = "22222222222222222222222222222222"; // 폴더노트(본문 + 자식)
const LEAF = "33333333333333333333333333333333"; // 자식 — callout 안에 중첩
const CALLOUT = "44444444444444444444444444444444"; // HUB 본문 안의 callout 블록

function page(id: string, title: string, parent: PageObjectResponse["parent"]): PageObjectResponse {
  return {
    object: "page",
    id,
    last_edited_time: "2026-05-01T00:00:00.000Z",
    created_time: "2026-05-01T00:00:00.000Z",
    archived: false,
    in_trash: false,
    parent,
    properties: { title: { type: "title", title: [{ plain_text: title }] } },
  } as unknown as PageObjectResponse;
}

const HUB_PAGE = page(HUB, "Hub", {
  type: "page_id",
  page_id: ROOT,
} as PageObjectResponse["parent"]);
// 핵심: LEAF 의 parent 는 페이지가 아니라 callout 블록(block_id). 즉 HUB 의 최상위 블록
// 목록에는 child_page 가 없고, child_page 는 callout 안에 중첩돼 있다.
const LEAF_PAGE = page(LEAF, "Leaf", {
  type: "block_id",
  block_id: CALLOUT,
} as PageObjectResponse["parent"]);

describe("폴더노트 분류 — 컨테이너 중첩 자식 (본문분리 회귀 잠금)", () => {
  let tmpDir: string | null = null;
  let stateDb: StateDB | null = null;

  afterEach(async () => {
    if (stateDb) stateDb.close();
    stateDb = null;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
    vi.restoreAllMocks();
  });

  it("callout 안에 중첩된 자식을 가진 본문 페이지는 폴더노트로 분류되고 본문이 폴더 안에 기록된다", async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "im-foldernote-"));
    const vaultFs = new NodeVaultFS(tmpDir);
    await vaultFs.ensureFolder(".im-nobsidian");
    stateDb = StateDB.open(join(tmpDir, ".im-nobsidian", "sync.db"));

    const client = new NotionClient({ token: "offline-test" });

    // 네트워크 메서드만 stub — extractTitle/extractParentId 등 순수 로직은 실제 사용.
    // 발견은 root 서브트리 순회 → 순회 결과의 각 페이지 부모를 해소하며 _childParentIds 구성
    // (LEAF 의 block_id 부모는 getBlock 으로 HUB 까지 거슬러 올라가 폴더 판정에 반영된다).
    vi.spyOn(client, "getChildPagesRecursive").mockResolvedValue([HUB_PAGE, LEAF_PAGE]);
    vi.spyOn(client, "getPage").mockImplementation(async (id: string) => {
      if (id === HUB) return HUB_PAGE;
      if (id === LEAF) return LEAF_PAGE;
      throw new Error(`unexpected getPage ${id}`);
    });
    // callout 블록의 부모는 HUB 페이지 → resolveBlockToPageId 가 HUB 로 거슬러 올라간다.
    vi.spyOn(client, "getBlock").mockImplementation(async (id: string) => {
      if (id === CALLOUT) {
        return {
          id: CALLOUT,
          parent: { type: "page_id", page_id: HUB },
        } as unknown as BlockObjectResponse;
      }
      throw new Error(`unexpected getBlock ${id}`);
    });
    vi.spyOn(client, "getPageMarkdown").mockImplementation(async (id: string) => {
      if (id === HUB) return { markdown: "# Hub\n\nWelcome to the hub body.\n" } as never;
      if (id === LEAF) return { markdown: "# Leaf\n\nLeaf body.\n" } as never;
      throw new Error(`unexpected getPageMarkdown ${id}`);
    });
    // 폴백 경로(집합에 없는 페이지)용 — 빈 자식.
    vi.spyOn(client, "fetchAllChildrenDeep").mockResolvedValue([]);
    // pull 말미 child_database 자동발견 경로(네트워크) 차단 — 본 시나리오엔 DB 없음.
    vi.spyOn(client, "getChildDatabaseIds").mockResolvedValue([]);

    const config: Config = {
      ...DEFAULT_CONFIG,
      notion: { ...DEFAULT_CONFIG.notion, rootPageId: ROOT, token: "offline-test" },
    };
    const orchestrator = new SyncOrchestrator(config, stateDb, client, vaultFs);

    const result = await orchestrator.pull();

    // 1) 오류 없이 두 페이지가 생성됐는가.
    expect(result.failed, JSON.stringify(result.failed)).toHaveLength(0);
    expect(result.created).toBe(2);

    // 2) HUB 는 폴더노트 — 본문이 폴더 '안'(Hub/Hub.md)에 기록된다.
    const hubRec = stateDb.getByNotionId(HUB);
    expect(hubRec, "HUB 레코드").not.toBeNull();
    expect(hubRec!.fileType).toBe("folder-note");
    expect(hubRec!.obsidianPath).toBe("Hub/Hub.md");
    const hubBody = await readFile(join(tmpDir, "Hub", "Hub.md"), "utf-8");
    expect(hubBody).toContain("Welcome to the hub body");

    // 3) LEAF 는 파일 — 같은 폴더 안에.
    const leafRec = stateDb.getByNotionId(LEAF);
    expect(leafRec, "LEAF 레코드").not.toBeNull();
    expect(leafRec!.fileType).toBe("file");
    expect(leafRec!.obsidianPath).toBe("Hub/Leaf.md");

    // 4) 본문분리 결함의 직접 단언: 최상위에 Hub 본문이 새어 나오거나 충돌 접미사가 없어야 한다.
    expect(existsSync(join(tmpDir, "Hub.md")), "최상위 Hub.md 누출").toBe(false);
    expect(existsSync(join(tmpDir, "Hub (1).md")), "충돌 접미사 분리").toBe(false);
    expect(existsSync(join(tmpDir, "Hub (1) (1).md"))).toBe(false);
  });
});
