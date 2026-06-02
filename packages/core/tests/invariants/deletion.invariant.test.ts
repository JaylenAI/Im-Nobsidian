/**
 * I10 — 삭제 전파 불변식.
 *
 * (1) deleteSync=true: 로컬 삭제 → Notion archive 전파(deleted==1),
 *     실제 page.archived==true, 재-push 멱등(deleted==0),
 *     이후 pull 에서 silent resurrection 0(archive 된 페이지가 다시 로컬로
 *     되살아나지 않음).
 * (2) deleteSync=false: 로컬 삭제해도 Notion 은 보존(deleted==0, archived==false),
 *     레코드는 pending 으로만 표시 — 파괴적 전파 금지.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "@notionhq/client";

import {
  SKIP,
  rawNotion,
  createIsolatedRoot,
  createTmpVault,
  makeOrchestrator,
  snapshotVault,
  isArchived,
  archivePages,
  cleanupVault,
  sleep,
} from "./harness.js";
import type { StateDB } from "../../src/state/state-db.js";

describe.skipIf(SKIP)("I10 삭제 전파 불변식", () => {
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

  it("deleteSync=true: 로컬 삭제 → archive 전파 + 멱등 + resurrection 0", async () => {
    const root = await createIsolatedRoot(raw, "del-on");
    createdPageIds.push(root);
    const vault = await createTmpVault();
    const { orchestrator, stateDb, vaultFs } = makeOrchestrator(vault, root, {
      deleteSync: true,
    });

    await vaultFs.writeFile("keep.md", "# 유지\n\n남는 문서\n");
    await vaultFs.writeFile("remove.md", "# 삭제대상\n\n지워질 문서\n");

    const push1 = await orchestrator.push();
    trackPages(stateDb);
    expect(push1.created).toBe(2);

    const removedPageId = stateDb.getByPath("remove.md")?.notionPageId ?? null;
    expect(removedPageId).not.toBeNull();

    // pull 의 orphan 삭제 감지가 동작하려면 last_pull_at 메타가 필요
    await sleep(2000);
    await orchestrator.pull();

    // 로컬에서 1개 삭제 → push 로 archive 전파
    await vaultFs.deleteFile("remove.md");
    const pushDel = await orchestrator.push();
    expect(pushDel.deleted).toBe(1);
    expect(pushDel.created).toBe(0);
    expect(pushDel.failed).toHaveLength(0);

    // 실제 Notion 에서 archive 됐는지 확인
    await sleep(1500);
    expect(await isArchived(raw, removedPageId!)).toBe(true);

    // 재-push 멱등 — 이미 삭제된 레코드라 다시 deleted 발생하지 않음
    const pushDel2 = await orchestrator.push();
    expect(pushDel2.deleted).toBe(0);
    expect(pushDel2.created).toBe(0);

    // resurrection 방지: archive 된 페이지는 pull 로 되살아나면 안 됨
    await sleep(2500);
    const pullAfter = await orchestrator.pull();
    expect(pullAfter.created, "silent resurrection 발생").toBe(0);

    const snap = await snapshotVault(vault);
    expect(snap.has("remove.md"), "삭제 파일이 resurrection 됨").toBe(false);
    expect(snap.has("keep.md")).toBe(true);

    await cleanupVault(vault, stateDb);
  });

  it("deleteSync=false: 로컬 삭제해도 Notion 보존(파괴적 전파 금지)", async () => {
    const root = await createIsolatedRoot(raw, "del-off");
    createdPageIds.push(root);
    const vault = await createTmpVault();
    const { orchestrator, stateDb, vaultFs } = makeOrchestrator(vault, root, {
      deleteSync: false,
    });

    await vaultFs.writeFile("safe.md", "# 안전\n\n삭제돼도 Notion 은 보존\n");
    const push1 = await orchestrator.push();
    trackPages(stateDb);
    expect(push1.created).toBe(1);

    const pageId = stateDb.getByPath("safe.md")?.notionPageId ?? null;
    expect(pageId).not.toBeNull();

    await vaultFs.deleteFile("safe.md");
    const pushDel = await orchestrator.push();
    expect(pushDel.deleted).toBe(0);
    expect(pushDel.failed).toHaveLength(0);

    // Notion 페이지는 그대로 살아있어야 함
    await sleep(1500);
    expect(await isArchived(raw, pageId!)).toBe(false);

    // 레코드는 pending 으로만 표시 (삭제 아님)
    const rec = stateDb.getByNotionId(pageId!);
    expect(rec).not.toBeNull();
    expect(rec!.status).toBe("pending");

    await cleanupVault(vault, stateDb);
  });
});
