import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@notionhq/client";
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

const TOKEN = process.env["NOTION_TOKEN"]!;
const ROOT_PAGE_ID = process.env["NOTION_ROOT_PAGE_ID"]!;
const SKIP = !TOKEN || !ROOT_PAGE_ID;

// Notion last_edited_time은 분 단위 정밀도 — 같은 분 내 수정은 감지 불가
// 테스트에서는 DB의 notionLastEdited를 1시간 전으로 설정해 실제 시나리오를 시뮬레이션

describe.skipIf(SKIP)("Pull Engine 통합 테스트", { timeout: 60000 }, () => {
  let rawClient: Client;
  let notionClient: NotionClient;
  const createdPageIds: string[] = [];

  beforeAll(() => {
    rawClient = new Client({ auth: TOKEN });
    notionClient = new NotionClient({ token: TOKEN });
  });

  afterAll(async () => {
    for (const pageId of createdPageIds) {
      try {
        await rawClient.pages.update({ page_id: pageId, archived: true });
      } catch {
        /* ignore */
      }
    }
  });

  function createOrchestrator(tmpDir: string): {
    orchestrator: SyncOrchestrator;
    stateDb: StateDB;
    vaultFs: NodeVaultFS;
  } {
    const dbPath = join(tmpDir, ".obsinotion", "sync.db");
    const vaultFs = new NodeVaultFS(tmpDir);
    const stateDb = StateDB.open(dbPath);

    const config: Config = {
      ...DEFAULT_CONFIG,
      notion: { ...DEFAULT_CONFIG.notion, rootPageId: ROOT_PAGE_ID, token: TOKEN },
    };

    const orchestrator = new SyncOrchestrator(config, stateDb, notionClient, vaultFs);
    return { orchestrator, stateDb, vaultFs };
  }

  it("새 페이지 Pull → 로컬 파일 생성", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "obsinotion-pull-"));
    const localVaultFs = new NodeVaultFS(tmpDir);
    await localVaultFs.ensureFolder(".obsinotion");
    const { orchestrator, stateDb } = createOrchestrator(tmpDir);

    const page = (await rawClient.pages.create({
      parent: { page_id: ROOT_PAGE_ID },
      properties: {
        title: { title: [{ text: { content: "PullTest 새문서" } }] },
      },
      children: [
        {
          object: "block",
          type: "heading_1",
          heading_1: { rich_text: [{ type: "text", text: { content: "제목" } }] },
        },
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content: "Pull로 생성된 문서입니다." } }],
          },
        },
        {
          object: "block",
          type: "bulleted_list_item",
          bulleted_list_item: { rich_text: [{ type: "text", text: { content: "리스트 항목" } }] },
        },
      ],
    })) as PageObjectResponse;
    createdPageIds.push(page.id);

    await new Promise((r) => setTimeout(r, 2000));

    const result = await orchestrator.pull();

    expect(result.created).toBeGreaterThanOrEqual(1);

    const targetPath = result.writtenPaths.find((p) => p.includes("PullTest"));
    expect(targetPath).toBeDefined();

    const content = await readFile(join(tmpDir, targetPath!), "utf-8");
    expect(content).toContain("제목");
    expect(content).toContain("Pull로 생성된 문서");
    expect(content).toContain("리스트 항목");

    const record = stateDb.getByNotionId(page.id);
    expect(record).not.toBeNull();
    expect(record!.status).toBe("synced");

    stateDb.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("수정된 페이지 Pull → 로컬 파일 업데이트", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "obsinotion-pull-"));
    const localVaultFs = new NodeVaultFS(tmpDir);
    await localVaultFs.ensureFolder(".obsinotion");
    const { orchestrator, stateDb } = createOrchestrator(tmpDir);

    const page = (await rawClient.pages.create({
      parent: { page_id: ROOT_PAGE_ID },
      properties: {
        title: { title: [{ text: { content: "PullTest 업데이트" } }] },
      },
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: "원본 내용" } }] },
        },
      ],
    })) as PageObjectResponse;
    createdPageIds.push(page.id);

    await new Promise((r) => setTimeout(r, 2000));

    const firstPull = await orchestrator.pull();
    expect(firstPull.created).toBeGreaterThanOrEqual(1);

    const blocks = await rawClient.blocks.children.list({ block_id: page.id });
    for (const block of blocks.results) {
      await rawClient.blocks.delete({ block_id: block.id });
    }
    await rawClient.blocks.children.append({
      block_id: page.id,
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: "수정된 내용입니다" } }] },
        },
      ] as never,
    });

    // Notion last_edited_time은 분 단위 — DB의 타임스탬프를 과거로 설정해 변경 감지 유도
    const record = stateDb.getByNotionId(page.id);
    expect(record).not.toBeNull();
    stateDb.upsert({
      obsidianPath: record!.obsidianPath,
      notionPageId: record!.notionPageId,
      notionParentId: record!.notionParentId,
      contentHash: record!.contentHash,
      notionLastEdited: "2020-01-01T00:00:00.000Z",
      localLastModified: record!.localLastModified,
      syncDirection: record!.syncDirection,
      fileType: record!.fileType,
      status: record!.status,
      baseSnapshot: record!.baseSnapshot,
    });

    const secondPull = await orchestrator.pull();
    expect(secondPull.updated).toBeGreaterThanOrEqual(1);

    const updatedRecord = stateDb.getByNotionId(page.id);
    expect(updatedRecord).not.toBeNull();

    const content = await readFile(join(tmpDir, updatedRecord!.obsidianPath), "utf-8");
    expect(content).toContain("수정된 내용");
    expect(content).not.toContain("원본 내용");

    stateDb.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("로컬+원격 동시 수정 → 충돌 감지", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "obsinotion-pull-"));
    const localVaultFs = new NodeVaultFS(tmpDir);
    await localVaultFs.ensureFolder(".obsinotion");
    const { orchestrator, stateDb, vaultFs } = createOrchestrator(tmpDir);

    const page = (await rawClient.pages.create({
      parent: { page_id: ROOT_PAGE_ID },
      properties: {
        title: { title: [{ text: { content: "PullTest 충돌" } }] },
      },
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: "기본 내용" } }] },
        },
      ],
    })) as PageObjectResponse;
    createdPageIds.push(page.id);

    await new Promise((r) => setTimeout(r, 2000));
    await orchestrator.pull();

    const record = stateDb.getByNotionId(page.id);
    expect(record).not.toBeNull();

    await vaultFs.writeFile(record!.obsidianPath, "# 로컬에서 수정한 내용\n\n로컬 변경");

    const existingBlocks = await rawClient.blocks.children.list({ block_id: page.id });
    for (const block of existingBlocks.results) {
      await rawClient.blocks.delete({ block_id: block.id });
    }
    await rawClient.blocks.children.append({
      block_id: page.id,
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: "원격에서 수정한 내용" } }] },
        },
      ] as never,
    });

    // 타임스탬프를 과거로 설정해 변경 감지 유도
    stateDb.upsert({
      obsidianPath: record!.obsidianPath,
      notionPageId: record!.notionPageId,
      notionParentId: record!.notionParentId,
      contentHash: record!.contentHash,
      notionLastEdited: "2020-01-01T00:00:00.000Z",
      localLastModified: record!.localLastModified,
      syncDirection: record!.syncDirection,
      fileType: record!.fileType,
      status: record!.status,
      baseSnapshot: record!.baseSnapshot,
    });

    const result = await orchestrator.pull();
    expect(result.conflicts.length).toBeGreaterThanOrEqual(1);

    const conflict = result.conflicts.find((c) => c.syncRecord.notionPageId === page.id);
    expect(conflict).toBeDefined();
    expect(conflict!.localContent).toContain("로컬에서 수정한 내용");
    expect(conflict!.remoteContent).toContain("원격에서 수정한 내용");

    const updatedRecord = stateDb.getByNotionId(page.id);
    expect(updatedRecord!.status).toBe("conflict");

    stateDb.close();
    await rm(tmpDir, { recursive: true, force: true });
  });
});
