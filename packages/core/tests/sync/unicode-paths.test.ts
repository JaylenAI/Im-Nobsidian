/**
 * P9 — macOS 의 NFD 한글 이름. Finder 가 만든 이름은 NFD 로 디스크에 남는다. Obsidian 은 그 파일을 NFC 경로로 보인다
 * (2026-10-31 실측, 1.12.4). CLI 도 같게 — 볼트 경로 · 제목 · 링크는 NFC, 읽고 쓰기는 디스크 이름으로.
 *
 * 실제 임시 폴더(NodeVaultFS) · 실제 StateDB · 메모리 Notion 으로 돌린다. Linux 의 파일 시스템은 두 꼴을 다른 이름으로
 * 보므로 디스크 이름을 따라가지 않으면 NFD 파일 옆에 NFC 파일이 새로 생긴다 — macOS 보다 엄한 시험이다.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { NodeVaultFS } from "../../src/sync/node-vault-fs.js";
import { NFC_PATHS_META_KEY } from "../../src/sync/nfc-paths.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { sanitizeFileName } from "../../src/utils/sanitize.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { memoryNotion } from "../helpers/memory-sync.js";

const ROOT = "root-page-id";
const nfd = (text: string) => text.normalize("NFD");

describe("NFD 이름 (P9)", () => {
  let vaultDir: string;
  let stateDir: string;
  let db: StateDB;
  let notion: ReturnType<typeof memoryNotion>;

  beforeEach(async () => {
    vaultDir = await mkdtemp(join(tmpdir(), "im-nobsidian-nfd-vault-"));
    stateDir = await mkdtemp(join(tmpdir(), "im-nobsidian-nfd-state-"));
    db = StateDB.open(join(stateDir, "state.db"));
    notion = memoryNotion();
    // Finder 가 만든 것처럼 — 폴더와 노트 이름이 NFD
    await mkdir(join(vaultDir, nfd("회의")));
    await writeFile(join(vaultDir, nfd("회의"), nfd("주간 회의.md")), "주간 본문\n");
    await writeFile(join(vaultDir, "링크.md"), "[[주간 회의]] 를 본다\n");
  });

  afterEach(async () => {
    db.close();
    await rm(vaultDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  const orchestrator = () =>
    new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: ROOT, databases: [] },
        sync: { ...DEFAULT_CONFIG.sync, fullReconcileInterval: 0 },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      new NodeVaultFS(vaultDir),
    );
  const pages = () => [...notion.pages.values()].filter((page) => !page.archived);
  const diskNames = async () =>
    (await readdir(vaultDir, { recursive: true })).map((name) => String(name)).sort();

  it("NFC 경로로 보이고 제목 · 링크도 NFC — 디스크 이름은 그대로", async () => {
    const vault = new NodeVaultFS(vaultDir);
    expect((await vault.listMarkdownFileStats()).map((f) => f.path).sort()).toEqual([
      "링크.md",
      "회의/주간 회의.md",
    ]);
    expect(await vault.readFile("회의/주간 회의.md")).toBe("주간 본문\n");

    const result = await orchestrator().push();
    expect(result).toMatchObject({ failed: [] });
    expect(
      pages()
        .map((page) => page.title)
        .sort(),
    ).toEqual(["링크", "주간 회의", "회의"]);
    for (const page of pages()) expect(page.title).toBe(page.title.normalize("NFC"));
    const target = db.getByPath("회의/주간 회의.md")!.notionPageId!;
    const link = pages().find((page) => page.title === "링크")!;
    expect(link.body).toContain(target.replace(/-/g, ""));

    // 디스크에는 새 이름이 생기지 않았다
    expect(await diskNames()).toEqual(["링크.md", nfd("회의"), nfd("회의/주간 회의.md")].sort());
    expect(await orchestrator().push()).toMatchObject({ created: 0, updated: 0, deleted: 0 });
  });

  it("고친 내용은 NFD 이름의 파일에 쓰고 · 그 폴더에 받는 새 노트는 그 폴더에 둔다", async () => {
    await orchestrator().push();
    const target = db.getByPath("회의/주간 회의.md")!.notionPageId!;
    const page = notion.edit(target, (p) => {
      p.body = "Notion 에서 고친 본문";
    });
    notion.add(page.parent, "새 노트", "새 본문");

    const result = await orchestrator().pull({ force: true });
    expect(result).toMatchObject({ failed: [] });
    expect(await readFile(join(vaultDir, nfd("회의"), nfd("주간 회의.md")), "utf-8")).toContain(
      "Notion 에서 고친 본문",
    );
    const names = await diskNames();
    expect(names).not.toContain("회의");
    expect(names).toContain(join(nfd("회의"), "새 노트.md"));
  });

  it("예전 CLI 가 적은 NFD 경로 기록을 NFC 로 옮겨 적는다 — 지우거나 새로 만들지 않는다", async () => {
    await orchestrator().push();
    const before = pages().length;
    // 예전 CLI 처럼 — 기록의 경로가 디스크 이름(NFD)
    db.transaction(() => {
      for (const record of db.getAll()) db.updatePath(record.id, nfd(record.obsidianPath));
    });
    db.setMeta(NFC_PATHS_META_KEY, "");

    const status = await orchestrator().status();
    expect(status.localChanges ?? []).toEqual([]);
    expect(
      db
        .getAll()
        .map((record) => record.obsidianPath)
        .sort(),
    ).toEqual(["링크.md", "회의", "회의/주간 회의.md"]);
    expect(await orchestrator().push()).toMatchObject({ created: 0, deleted: 0, failed: [] });
    expect(pages()).toHaveLength(before);
  });
});

describe("sanitizeFileName — NFD 제목", () => {
  it("NFC 이름이 된다", () => {
    expect(sanitizeFileName(nfd("회의록"))).toBe("회의록");
  });
});
