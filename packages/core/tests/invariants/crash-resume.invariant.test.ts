/**
 * I12 — 크래시 복구(중단된 push 재개) 불변식.
 *
 * push 가 "페이지 생성은 적용됐는데 로컬 매핑 기록 전에 중단(Window A)"되거나
 * "생성 자체가 적용되기 전에 중단"된 두 경우 모두, 다음 push 시작 시
 * recoverInterruptedPushOps 가 pending_operations(WAL) 를 보고 조정해야 한다.
 *
 * 임계값(실제 Notion 관찰, 거짓 종료 방지):
 *  - 생성 적용 후 중단: 부모에서 제목으로 고아 페이지를 찾아 입양 → 재push.created == 0,
 *    동일 제목 child_page == 1(중복 페이지 0), 매핑은 기존 페이지 id 그대로.
 *  - 생성 미적용 중단: 자리표시 제거 후 정상 경로로 재생성 → 정확히 1건 생성(중복 0).
 *
 * 두 경우 모두 "재개가 페이지를 2배로 만들지 않는다"를 수치로 검증한다.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "@notionhq/client";

import {
  SKIP,
  rawNotion,
  createIsolatedRoot,
  createTmpVault,
  makeOrchestrator,
  archivePages,
  cleanupVault,
  sleep,
} from "./harness.js";
import type { StateDB } from "../../src/state/state-db.js";

// 부모 페이지의 직속 child_page 중 제목이 일치하는 개수.
async function countChildPagesByTitle(
  raw: Client,
  parentId: string,
  title: string,
): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  do {
    const res = await raw.blocks.children.list({
      block_id: parentId,
      page_size: 100,
      start_cursor: cursor,
    });
    for (const b of res.results as Array<{ type: string; child_page?: { title?: string } }>) {
      if (b.type === "child_page" && b.child_page?.title === title) count++;
    }
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return count;
}

// 부모의 전체 직속 child_page 개수.
async function countAllChildPages(raw: Client, parentId: string): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  do {
    const res = await raw.blocks.children.list({
      block_id: parentId,
      page_size: 100,
      start_cursor: cursor,
    });
    for (const b of res.results as Array<{ type: string }>) {
      if (b.type === "child_page") count++;
    }
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return count;
}

describe.skipIf(SKIP)("I12 크래시 복구 불변식", () => {
  let raw: Client;
  const createdPageIds: string[] = [];

  beforeAll(() => {
    raw = rawNotion();
  });

  afterAll(async () => {
    await archivePages(raw, createdPageIds);
  });

  function trackPages(stateDb: StateDB): void {
    for (const rec of stateDb.getAll()) {
      if (rec.notionPageId) createdPageIds.push(rec.notionPageId);
    }
  }

  it("Window A(생성 적용 후 중단) — 고아 페이지 입양, 중복 페이지 0", async () => {
    const root = await createIsolatedRoot(raw, "i12-adopt");
    createdPageIds.push(root);
    const vault = await createTmpVault();
    const { orchestrator, stateDb, vaultFs } = makeOrchestrator(vault, root);

    await vaultFs.writeFile("note.md", "# 크래시 노트\n\n본문 한 줄.\n");

    const push1 = await orchestrator.push();
    trackPages(stateDb);
    expect(push1.failed).toHaveLength(0);
    expect(push1.created).toBe(1);

    const rec1 = stateDb.getByPath("note.md")!;
    const pageId = rec1.notionPageId!;
    expect(pageId).toBeTruthy();
    await sleep(1500);

    // 실제 Notion 에 생성된 페이지의 제목을 그대로 읽는다(추정 금지).
    const created = (await raw.pages.retrieve({ page_id: pageId })) as {
      properties?: { title?: { title?: Array<{ plain_text?: string }> } };
    };
    const title = created.properties?.title?.title?.[0]?.plain_text ?? "";
    expect(title, "생성 페이지 제목 추출").not.toBe("");
    expect(await countChildPagesByTitle(raw, root, title)).toBe(1);

    // 크래시 시뮬: 매핑 기록 전 중단을 재현 — 기존 매핑 제거 후 자리표시(null) + WAL op 만 남긴다.
    stateDb.delete(rec1.id);
    const placeholder = stateDb.upsert({
      obsidianPath: "note.md",
      notionPageId: null,
      notionParentId: root,
      contentHash: "",
      localLastModified: new Date().toISOString(),
      syncDirection: "both",
      fileType: "file",
      status: "pending",
    });
    stateDb.recordPendingOperation({
      syncStateId: placeholder.id,
      operation: "create",
      direction: "push",
      payload: JSON.stringify({ path: "note.md", parentId: root, title }),
    });

    // 재개: recoverInterruptedPushOps 가 부모에서 제목으로 고아 페이지를 입양해야 한다.
    const push2 = await orchestrator.push();
    expect(push2.failed).toHaveLength(0);
    expect(push2.created, "재개가 중복 페이지를 생성").toBe(0);

    const adopted = stateDb.getByPath("note.md")?.notionPageId;
    expect(adopted, "기존 페이지를 그대로 입양").toBe(pageId);
    await sleep(1500);
    expect(await countChildPagesByTitle(raw, root, title), "동일 제목 페이지 중복").toBe(1);

    await cleanupVault(vault, stateDb);
  });

  it("생성 미적용 중단 — 자리표시 제거 후 정확히 1건 재생성(중복 0)", async () => {
    const root = await createIsolatedRoot(raw, "i12-recreate");
    createdPageIds.push(root);
    const vault = await createTmpVault();
    const { orchestrator, stateDb, vaultFs } = makeOrchestrator(vault, root);

    await vaultFs.writeFile("ghost.md", "# 유령 노트\n\n생성 전 중단 케이스.\n");

    const before = await countAllChildPages(raw, root);

    // 크래시 시뮬: 생성 요청이 적용되기 전에 중단 — Notion 엔 페이지가 없고 자리표시 + op 만 존재.
    const placeholder = stateDb.upsert({
      obsidianPath: "ghost.md",
      notionPageId: null,
      notionParentId: root,
      contentHash: "",
      localLastModified: new Date().toISOString(),
      syncDirection: "both",
      fileType: "file",
      status: "pending",
    });
    stateDb.recordPendingOperation({
      syncStateId: placeholder.id,
      operation: "create",
      direction: "push",
      payload: JSON.stringify({ path: "ghost.md", parentId: root, title: "유령 노트" }),
    });

    // 재개: 고아 페이지가 없으므로 자리표시 제거 → 정상 경로로 정확히 1건 생성.
    const push = await orchestrator.push();
    trackPages(stateDb);
    expect(push.failed).toHaveLength(0);
    expect(push.created, "정확히 1건 생성").toBe(1);

    await sleep(1500);
    const after = await countAllChildPages(raw, root);
    expect(after - before, "child_page 가 정확히 1개만 증가(중복 0)").toBe(1);

    // 무변경 재sync: 추가 생성 0(멱등).
    const sync = await orchestrator.sync();
    expect(sync.push.created, "무변경 재sync 생성").toBe(0);

    await cleanupVault(vault, stateDb);
  });
});
