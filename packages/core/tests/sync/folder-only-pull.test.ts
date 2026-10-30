/**
 * 자식 말고 본문이 없는 페이지 — 새 볼트로 받아도 폴더로만 받는다.
 *
 * push 가 폴더 노트 없는 폴더로 만든 페이지는 그 볼트에서 폴더 레코드다. 새 볼트로 받으면 자식 태그가 바뀐
 * `[[자식]]` 줄을 본문으로 보고 `X/X.md` 를 써서, 볼트마다 모양이 달랐다(실데이터 재왕복 19 폴더).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const ROOT = "root-page-id";

describe("자식만 있는 페이지는 폴더로만 받는다", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  const orchestrator = () =>
    new SyncOrchestrator(
      createConfig({ notion: { token: "ntn_test_token", rootPageId: ROOT, databases: [] } }),
      db,
      notion.client as never,
      vault.fs(),
    );

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-folder-only-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const notes = () => [...vault.files.keys()].filter((path) => path.endsWith(".md")).sort();

  it("노트를 쓰지 않고 폴더를 추적한다 — 자식은 그 폴더에", async () => {
    const folder = notion.add(ROOT, "빈폴더", "");
    notion.add(folder.id, "안", "안 본문");

    expect((await orchestrator().pull()).failed).toEqual([]);

    expect(notes()).toEqual(["빈폴더/안.md"]);
    expect(db.getByNotionId(folder.id)).toMatchObject({
      obsidianPath: "빈폴더",
      fileType: "folder-only",
    });
    expect(await orchestrator().push()).toMatchObject({ created: 0, updated: 0, failed: [] });
  });

  it("본문이 있으면 예전처럼 폴더 노트", async () => {
    const group = notion.add(ROOT, "묶음", "묶음 본문");
    notion.add(group.id, "안", "안 본문");

    expect((await orchestrator().pull()).failed).toEqual([]);

    expect(notes()).toEqual(["묶음/묶음.md", "묶음/안.md"]);
  });

  it("나중에 본문이 생기면 폴더 노트로 받는다", async () => {
    const folder = notion.add(ROOT, "빈폴더", "");
    notion.add(folder.id, "안", "안 본문");
    await orchestrator().pull();

    notion.edit(folder.id, (page) => (page.body = "이제 본문"));
    expect((await orchestrator().pull()).failed).toEqual([]);

    expect(notes()).toEqual(["빈폴더/빈폴더.md", "빈폴더/안.md"]);
    expect(vault.read("빈폴더/빈폴더.md")).toContain("이제 본문");
  });

  it("dry-run 은 실제 pull 과 같게 센다 — 하위 페이지만 바뀐 폴더 페이지는 고친 것이 아니다", async () => {
    const folder = notion.add(ROOT, "빈폴더", "");
    notion.add(folder.id, "안", "안 본문");
    await orchestrator().pull();

    // 하위 페이지 · DB 를 옮기면 Notion 은 그 페이지의 수정 시각을 바꾼다 — 본문은 그대로.
    notion.edit(folder.id, () => {});
    const preview = await orchestrator().pull({ dryRun: true });
    expect(preview).toMatchObject({ updated: 0, failed: [] });
    expect(await orchestrator().pull()).toMatchObject({ updated: preview.updated, failed: [] });

    notion.edit(folder.id, (page) => (page.body = "이제 본문"));
    const withBody = await orchestrator().pull({ dryRun: true });
    expect(withBody).toMatchObject({ updated: 1, failed: [] });
    expect(await orchestrator().pull()).toMatchObject({ updated: withBody.updated, failed: [] });
  });
});
