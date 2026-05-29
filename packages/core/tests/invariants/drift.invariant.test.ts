/**
 * 드리프트 불변식.
 *
 * 동기화가 fixpoint 에 도달한 뒤 한 번 더 전체 sync 를 돌려도 볼트가
 * 비트 단위로 동일해야 한다(파일 추가/삭제/변경 0). 라운드트립 누락이
 * 있으면 매 sync 마다 파일 내용이 흔들리며 added/changed 가 잡힌다.
 *
 * pull → snapshot(S1) → sync → snapshot(S2) → diff == empty.
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
  diffSnapshots,
  archivePages,
  cleanupVault,
  sleep,
} from "./harness.js";
import type { StateDB } from "../../src/state/state-db.js";

describe.skipIf(SKIP)("드리프트 불변식", () => {
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

  it("fixpoint 도달 후 추가 sync 가 볼트를 변형시키지 않는다(drift==empty)", async () => {
    const root = await createIsolatedRoot(raw, "drift");
    createdPageIds.push(root);
    const vault = await createTmpVault();
    const { orchestrator, stateDb, vaultFs } = makeOrchestrator(vault, root);

    await vaultFs.writeFile(
      "drift-doc.md",
      "# 드리프트 문서\n\n첫 단락입니다.\n\n## 소제목\n\n- 가\n- 나\n- 다\n\n> 인용구\n",
    );
    await vaultFs.writeFile("drift-plain.md", "# 단순 문서\n\n본문 한 줄.\n");

    const push1 = await orchestrator.push();
    trackPages(stateDb);
    expect(push1.created).toBe(2);
    expect(push1.failed).toHaveLength(0);

    await sleep(2500);

    // fixpoint 까지 sync 반복 (최대 4회)
    let stabilized = false;
    for (let i = 0; i < 4; i++) {
      const r = await orchestrator.sync();
      if (
        r.pull.created === 0 &&
        r.pull.updated === 0 &&
        r.push.created === 0 &&
        r.push.updated === 0
      ) {
        stabilized = true;
        break;
      }
      await sleep(1500);
    }
    expect(stabilized, "sync 가 fixpoint 에 도달하지 못함").toBe(true);

    // 안정 상태 스냅샷
    const s1 = await snapshotVault(vault);
    expect(s1.size).toBeGreaterThanOrEqual(2);

    // 한 번 더 전체 sync — 볼트가 변하면 안 됨
    await orchestrator.sync();
    const s2 = await snapshotVault(vault);

    const diff = diffSnapshots(s1, s2);
    expect(diff.added, `drift added: ${diff.added.join(", ")}`).toHaveLength(0);
    expect(diff.removed, `drift removed: ${diff.removed.join(", ")}`).toHaveLength(0);
    expect(diff.changed, `drift changed: ${diff.changed.join(", ")}`).toHaveLength(0);

    await cleanupVault(vault, stateDb);
  });
});
