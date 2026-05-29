/**
 * I5 — 멱등성 불변식.
 *
 * (1) push 멱등: 변경 없는 재-push 는 created/updated/deleted 가 모두 0.
 * (2) churn 격리: 한 파일 1글자 수정 → 정확히 그 1개만 updated, 나머지 0.
 * (3) 비자명 fixpoint: push 후 sync 를 반복하면 유한 횟수 안에 수렴
 *     (마지막 sync 의 push/pull create·update 가 0).
 *
 * 모두 실제 Notion 왕복 기반 카운트 단언 — `.toContain` 미사용.
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

describe.skipIf(SKIP)("I5 멱등성 불변식", () => {
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

  it("push 멱등 + churn 격리: 재-push 0, 1글자 수정 시 정확히 1건만 updated", async () => {
    const root = await createIsolatedRoot(raw, "idem-push");
    createdPageIds.push(root);
    const vault = await createTmpVault();
    const { orchestrator, stateDb, vaultFs } = makeOrchestrator(vault, root);

    await vaultFs.writeFile("note-a.md", "# Note A\n\nalpha 본문\n");
    await vaultFs.writeFile("note-b.md", "# Note B\n\nbeta 본문\n");
    await vaultFs.writeFile("note-c.md", "# Note C\n\ngamma 본문\n");

    // 1차 push — 3개 생성
    const push1 = await orchestrator.push();
    trackPages(stateDb);
    expect(push1.failed).toHaveLength(0);
    expect(push1.created).toBe(3);
    expect(push1.updated).toBe(0);
    expect(push1.deleted).toBe(0);

    // 2차 push — 변경 없음 → 완전 멱등
    const push2 = await orchestrator.push();
    expect(push2.created).toBe(0);
    expect(push2.updated).toBe(0);
    expect(push2.deleted).toBe(0);
    expect(push2.failed).toHaveLength(0);

    // 한 파일만 1글자 수정 → 정확히 1건 updated, 나머지 churn 0
    await vaultFs.writeFile("note-a.md", "# Note A\n\nalpha 본문!\n");
    const push3 = await orchestrator.push();
    expect(push3.updated).toBe(1);
    expect(push3.created).toBe(0);
    expect(push3.deleted).toBe(0);
    expect(push3.failed).toHaveLength(0);

    // 재안정 — 다시 변경 없음
    const push4 = await orchestrator.push();
    expect(push4.created).toBe(0);
    expect(push4.updated).toBe(0);
    expect(push4.deleted).toBe(0);

    await cleanupVault(vault, stateDb);
  });

  it("비자명 fixpoint: push 후 sync 반복이 유한 횟수 안에 수렴(create·update 0)", async () => {
    const root = await createIsolatedRoot(raw, "idem-fixpoint");
    createdPageIds.push(root);
    const vault = await createTmpVault();
    const { orchestrator, stateDb, vaultFs } = makeOrchestrator(vault, root);

    await vaultFs.writeFile("fp-1.md", "# FP One\n\n첫 단락\n\n- 항목1\n- 항목2\n");
    await vaultFs.writeFile("fp-2.md", "# FP Two\n\n> 인용\n\n**굵게** 그리고 *기울임*\n");

    const push1 = await orchestrator.push();
    trackPages(stateDb);
    expect(push1.created).toBe(2);
    expect(push1.failed).toHaveLength(0);

    // Notion eventual consistency 대비 — 약간 대기 후 수렴 루프
    await sleep(2500);

    const MAX = 4;
    let converged = false;
    let lastSummary = "";
    for (let i = 0; i < MAX; i++) {
      const result = await orchestrator.sync();
      lastSummary =
        `iter#${i + 1} pull(c=${result.pull.created},u=${result.pull.updated}) ` +
        `push(c=${result.push.created},u=${result.push.updated})`;
      if (
        result.pull.created === 0 &&
        result.pull.updated === 0 &&
        result.push.created === 0 &&
        result.push.updated === 0
      ) {
        converged = true;
        break;
      }
      await sleep(1500);
    }

    expect(converged, `fixpoint 미수렴 — 마지막: ${lastSummary}`).toBe(true);

    await cleanupVault(vault, stateDb);
  });
});
