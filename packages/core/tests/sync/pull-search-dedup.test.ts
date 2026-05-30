/**
 * 검색 페이지네이션 중복 회귀 잠금 — "고아 + folder-note 위치오류 + push churn" 결함 재발 방지.
 *
 * 결함: 대형 워크스페이스에서 Notion search API 는 페이지네이션 사이 인덱스 재정렬로 같은
 * 페이지를 두 번 이상 반환한다. searchAllPages/detectRemoteChanges 가 page_id 로 디듀프하지
 * 않으면 한 페이지가 created 변경으로 2건 새고, 거대한 변경 목록의 멀리 떨어진 두 위치에서
 * pullCreate 가 2회 실행된다. 1회차는 클린 경로('X.md')에 기록·등록하고, 2회차는
 * resolveUniqueFilePath 충돌로 'X (1).md' 에 기록하며 page_id 키 upsert 가 DB 를 '(1)' 로
 * 재지정 → 클린 파일이 sync_state 에 없는 고아가 된다. 그 고아는 push 가 신규 로컬 파일로
 * 오인해 Notion 에 중복 페이지를 만들고(churn), folder-note 의 클린 이름을 고아가 선점해
 * '<folder>/<basename> (1).md' 위치오류를 만든다.
 *
 * 수정: (1) searchAllPages 가 id 로 디듀프 (2) detectRemoteChanges 가 원격 목록을 id 로
 * 디듀프(페이지·DB 양 모드 차단점) (3) pullCreate 가 기록↔등록 사이에 throw 가능한 원격
 * 호출을 두지 않음(원자적 등록).
 *
 * 본 테스트는 search 가 같은 페이지를 중복 반환하는 구조를 mock 으로 재현하고, pull 이
 * 페이지를 정확히 1회 생성하며 고아·충돌접미사·중복 레코드가 0 임을 단언한다.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
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
const HUB = "22222222222222222222222222222222"; // 폴더노트(본문 + 자식) — 검색에 중복 등장
const LEAF = "33333333333333333333333333333333"; // HUB 의 자식 페이지

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
const LEAF_PAGE = page(LEAF, "Leaf", {
  type: "page_id",
  page_id: HUB,
} as PageObjectResponse["parent"]);

describe("검색 중복 디듀프 — 고아/위치오류/churn 회귀 잠금", () => {
  let tmpDir: string | null = null;
  let stateDb: StateDB | null = null;

  afterEach(async () => {
    if (stateDb) stateDb.close();
    stateDb = null;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
    vi.restoreAllMocks();
  });

  async function setup(searchResults: PageObjectResponse[]): Promise<{
    orchestrator: SyncOrchestrator;
    vault: string;
    db: StateDB;
  }> {
    tmpDir = await mkdtemp(join(tmpdir(), "im-search-dedup-"));
    const vaultFs = new NodeVaultFS(tmpDir);
    await vaultFs.ensureFolder(".im-nobsidian");
    stateDb = StateDB.open(join(tmpDir, ".im-nobsidian", "sync.db"));

    const client = new NotionClient({ token: "offline-test" });
    vi.spyOn(client, "searchAllPages").mockResolvedValue(searchResults);
    vi.spyOn(client, "getPage").mockImplementation(async (id: string) => {
      if (id === HUB) return HUB_PAGE;
      if (id === LEAF) return LEAF_PAGE;
      throw new Error(`unexpected getPage ${id}`);
    });
    vi.spyOn(client, "getPageMarkdown").mockImplementation(async (id: string) => {
      if (id === HUB) return { markdown: "# Hub\n\nHub body.\n" } as never;
      if (id === LEAF) return { markdown: "# Leaf\n\nLeaf body.\n" } as never;
      throw new Error(`unexpected getPageMarkdown ${id}`);
    });
    // HUB 는 자식(LEAF)을 가지므로 폴더노트로 분류돼야 한다.
    vi.spyOn(client, "fetchAllChildrenDeep").mockImplementation(async (id: string) => {
      if (id === HUB) {
        return [{ type: "child_page", id: LEAF }] as never;
      }
      return [] as never;
    });
    vi.spyOn(client, "getChildDatabaseIds").mockResolvedValue([]);
    // 2회차 pull 은 증분 경로(searchRecentPages)를 탄다 — 변경 없음으로 차단(실 API 방지).
    vi.spyOn(client, "searchRecentPages").mockResolvedValue([]);

    const config: Config = {
      ...DEFAULT_CONFIG,
      notion: { ...DEFAULT_CONFIG.notion, rootPageId: ROOT, token: "offline-test" },
    };
    const orchestrator = new SyncOrchestrator(config, stateDb!, client, vaultFs);
    return { orchestrator, vault: tmpDir, db: stateDb! };
  }

  it(
    "search 가 같은 페이지를 중복 반환해도 페이지는 정확히 1회만 생성된다(고아·충돌접미사 0)",
    { timeout: 30000 },
    async () => {
      // HUB 가 검색 결과에 2번 등장(페이지네이션 중복 재현) + LEAF 1번.
      const { orchestrator, vault, db } = await setup([HUB_PAGE, LEAF_PAGE, HUB_PAGE]);

      const result = await orchestrator.pull();

      // 1) 오류 0, 생성은 정확히 2건(HUB·LEAF) — 중복 HUB 가 별도 create 로 새지 않는다.
      expect(result.failed, JSON.stringify(result.failed)).toHaveLength(0);
      expect(result.created).toBe(2);

      // 2) HUB 는 폴더노트 — 클린 경로 'Hub/Hub.md' (충돌접미사 없음).
      const hubRec = db.getByNotionId(HUB);
      expect(hubRec, "HUB 레코드").not.toBeNull();
      expect(hubRec!.fileType).toBe("folder-note");
      expect(hubRec!.obsidianPath).toBe("Hub/Hub.md");

      // 3) LEAF 는 파일 — 같은 폴더 안.
      const leafRec = db.getByNotionId(LEAF);
      expect(leafRec, "LEAF 레코드").not.toBeNull();
      expect(leafRec!.obsidianPath).toBe("Hub/Leaf.md");

      // 4) 충돌접미사 파일(고아)이 디스크에 없어야 한다.
      expect(existsSync(join(vault, "Hub", "Hub (1).md")), "충돌접미사 고아").toBe(false);
      expect(existsSync(join(vault, "Hub (1)")), "(1) 폴더 캐스케이드").toBe(false);
      expect(existsSync(join(vault, "Hub.md")), "최상위 본문 누출").toBe(false);

      // 5) page_id 당 레코드 정확히 1개(중복 매핑 0).
      const all = db.getAll();
      const hubCount = all.filter((r) => r.notionPageId === HUB).length;
      expect(hubCount, "HUB page_id 레코드 수").toBe(1);

      // 6) 고아 0 — 디스크의 모든 .md 가 sync_state 에 등록돼 있다(push churn 의 직접 원인 차단).
      const tracked = new Set(all.map((r) => r.obsidianPath));
      const onDisk: string[] = [];
      const walk = async (d: string): Promise<void> => {
        for (const ent of await readdir(d, { withFileTypes: true })) {
          if (ent.name === ".im-nobsidian") continue;
          const full = join(d, ent.name);
          if (ent.isDirectory()) await walk(full);
          else if (ent.name.endsWith(".md")) onDisk.push(full.slice(vault.length + 1));
        }
      };
      await walk(vault);
      const orphans = onDisk.filter((p) => !tracked.has(p));
      expect(orphans, `고아 파일: ${orphans.join(", ")}`).toHaveLength(0);

      // 7) 재pull 멱등 — 두번째 pull 은 변경 0(이미 추적 중).
      const second = await orchestrator.pull();
      expect(second.created).toBe(0);
      expect(second.updated).toBe(0);
    },
  );
});
