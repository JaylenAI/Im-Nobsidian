/**
 * pull 경로 충돌 회귀 잠금 — 동명 페이지가 서로의 파일을 덮어쓰지 않는다.
 *
 * 결함: `resolveUniqueFilePath` 가 `(1)`, `(2)` … 순번을 99 까지만 훑고, 고갈되면
 * **원본 경로를 그대로 반환**했다. 그 경로에 이미 있던 노트는 조용히 덮어써져 사라진다.
 * 순번은 그때의 볼트 상태로 정해지므로 페이지끼리 접미사가 뒤바뀔 수도 있었다
 * (pull 마다 파일이 갈아엎히는 churn).
 *
 * 수정: DB 행과 같은 규칙(`pagePathCandidates`)으로 통일 — 자연 이름 → 페이지 ID 조각
 * 8/16/32. ID 는 불변이라 항상 같은 페이지가 같은 경로로 수렴하고, 32 글자는 전역
 * 유일이라 후보가 고갈되지 않는다.
 *
 * 앵커: 앞 8 글자가 같은 실제 충돌 ID 형태를 그대로 쓴다(노션 ID 는 생성 시각 기반이라
 * 앞자리가 비랜덤 — 같은 부모의 동명 페이지끼리 8 글자 prefix 공유가 흔하다).
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
// 셋 다 제목이 "노트". A/B/C 는 앞 8 글자가 같고, B 와 C 는 앞 16 글자까지 같다.
const A = "c6313b18d38283e79fba81a4a844db5e";
const B = "c6313b18d38283d8a302812e473fc6e9";
const C = "c6313b18d38283d8b111c222d333e444";

function page(id: string): PageObjectResponse {
  return {
    object: "page",
    id,
    last_edited_time: "2026-05-01T00:00:00.000Z",
    created_time: "2026-05-01T00:00:00.000Z",
    archived: false,
    in_trash: false,
    parent: { type: "page_id", page_id: ROOT },
    properties: { title: { type: "title", title: [{ plain_text: "노트" }] } },
  } as unknown as PageObjectResponse;
}

const PAGES = new Map([
  [A, page(A)],
  [B, page(B)],
  [C, page(C)],
]);

describe("pull 경로 충돌 — 동명 페이지 (덮어쓰기·churn 회귀 잠금)", () => {
  let tmpDir: string | null = null;
  let stateDb: StateDB | null = null;

  afterEach(async () => {
    if (stateDb) stateDb.close();
    stateDb = null;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
    vi.restoreAllMocks();
  });

  async function pullOnce() {
    tmpDir = await mkdtemp(join(tmpdir(), "im-pullcollision-"));
    const vaultFs = new NodeVaultFS(tmpDir);
    await vaultFs.ensureFolder(".im-nobsidian");
    stateDb = StateDB.open(join(tmpDir, ".im-nobsidian", "sync.db"));

    const client = new NotionClient({ token: "offline-test" });
    vi.spyOn(client, "getChildPagesRecursive").mockResolvedValue([...PAGES.values()]);
    vi.spyOn(client, "getPage").mockImplementation(async (id: string) => {
      const found = PAGES.get(id);
      if (!found) throw new Error(`unexpected getPage ${id}`);
      return found;
    });
    // 본문을 페이지마다 다르게 준다 — 덮어쓰기가 나면 내용 단언에서 바로 드러난다.
    vi.spyOn(client, "getPageMarkdown").mockImplementation(
      async (id: string) => ({ markdown: `본문 ${id}\n` }) as never,
    );
    vi.spyOn(client, "fetchAllChildrenDeep").mockResolvedValue([]);
    vi.spyOn(client, "getChildDatabaseIds").mockResolvedValue([]);

    const config: Config = {
      ...DEFAULT_CONFIG,
      notion: { ...DEFAULT_CONFIG.notion, rootPageId: ROOT, token: "offline-test" },
    };
    const result = await new SyncOrchestrator(config, stateDb, client, vaultFs).pull();
    return { result, dir: tmpDir, db: stateDb };
  }

  it("동명 세 페이지가 서로 다른 파일로 기록되고 본문이 모두 보존된다", async () => {
    const { result, dir, db } = await pullOnce();

    expect(result.failed, JSON.stringify(result.failed)).toHaveLength(0);
    expect(result.created).toBe(3);

    const paths = [A, B, C].map((id) => db.getByNotionId(id)?.obsidianPath);
    expect(paths.every((p) => typeof p === "string")).toBe(true);
    // 덮어쓰기의 직접 단언 — 세 경로가 모두 달라야 한다.
    expect(new Set(paths).size).toBe(3);

    for (const id of [A, B, C]) {
      const body = await readFile(join(dir, db.getByNotionId(id)!.obsidianPath), "utf-8");
      expect(body, `${id} 본문`).toContain(`본문 ${id}`);
    }
  });

  it("접미사가 순번이 아니라 페이지 ID 조각이고, prefix 가 겹치면 넓어진다", async () => {
    const { db } = await pullOnce();
    const paths = [A, B, C].map((id) => db.getByNotionId(id)!.obsidianPath);

    // 하나는 자연 이름, 나머지는 각자의 ID 조각. 순번 접미사는 하나도 없어야 한다.
    expect(paths).toContain("노트.md");
    for (const p of paths) expect(p, `순번 접미사 잔존: ${p}`).not.toMatch(/ \(\d+\)\.md$/);

    // B·C 는 앞 8 글자가 같으므로 뒤에 배정된 쪽이 16 글자로 넓어져야 충돌이 풀린다.
    const suffixed = paths.filter((p) => p !== "노트.md").sort();
    expect(suffixed).toEqual(["노트 (c6313b18).md", "노트 (c6313b18d38283d8).md"]);
  });

  it("같은 볼트를 다시 pull 해도 경로가 그대로다 (churn 0)", async () => {
    const { db } = await pullOnce();
    const before = [A, B, C].map((id) => db.getByNotionId(id)!.obsidianPath);

    const config: Config = {
      ...DEFAULT_CONFIG,
      notion: { ...DEFAULT_CONFIG.notion, rootPageId: ROOT, token: "offline-test" },
    };
    const client = new NotionClient({ token: "offline-test" });
    vi.spyOn(client, "getChildPagesRecursive").mockResolvedValue([...PAGES.values()]);
    vi.spyOn(client, "getPage").mockImplementation(async (id: string) => PAGES.get(id)!);
    vi.spyOn(client, "getPageMarkdown").mockImplementation(
      async (id: string) => ({ markdown: `본문 ${id}\n` }) as never,
    );
    vi.spyOn(client, "fetchAllChildrenDeep").mockResolvedValue([]);
    vi.spyOn(client, "getChildDatabaseIds").mockResolvedValue([]);
    // 2회차는 증분 경로로 들어간다 — 세 페이지를 모두 "최근 편집"으로 올려
    // 재평가시켜야 경로 재산정이 실제로 일어나는지 본다(네트워크 호출도 함께 차단).
    vi.spyOn(client, "searchRecentPages").mockResolvedValue(
      [...PAGES.keys()].map((id) => ({ id, last_edited_time: "2026-05-01T00:00:00.000Z" })),
    );

    await new SyncOrchestrator(config, db, client, new NodeVaultFS(tmpDir!)).pull();

    expect([A, B, C].map((id) => db.getByNotionId(id)!.obsidianPath)).toEqual(before);
  });
});
