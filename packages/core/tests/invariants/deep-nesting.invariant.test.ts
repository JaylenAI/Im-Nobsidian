/**
 * I11 — Notion API 구조 제약 무손실 불변식.
 *
 * Notion API 의 두 하드 제약을 넘는 구조를 push 했을 때 무손실인지 검증한다:
 *   (1) 요청당 children 100개 상한 — 100개를 넘는 형제 블록이 잘리지 않는다.
 *   (2) 요청당 중첩 2단계 상한 — 2단계를 넘는 깊은 중첩이 평탄화/유실되지 않는다.
 *
 * 기본 push 경로(preferMarkdownApi=true)는 Notion 네이티브 Markdown API 가 배치/중첩을
 * 서버측 처리한다. 본 테스트는 그 무손실성을 실측으로 못박는다(거짓종료방지: 카운트 기반,
 * 임계값은 실제 왕복 관찰값으로 고정).
 *
 * push → 수렴(fixpoint) → 수렴 본문에서 블록 수·중첩 깊이를 카운트로 단언한다.
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

// 130개 형제 블록(>100) — 100블록 배치 상한을 넘긴다. 각 항목은 고유 마커를 가져
// 누락 시 카운트로 즉시 드러난다.
const N_SIBLINGS = 130;
function manySiblings(): string {
  const lines: string[] = [];
  for (let i = 1; i <= N_SIBLINGS; i++) lines.push(`- 항목-${i}-고유마커`);
  return lines.join("\n");
}

// 6단계 깊이 중첩 리스트 — 2단계 상한을 넘긴다.
const DEEP_LEVELS = 6;
function deepNest(): string {
  const lines: string[] = [];
  for (let d = 0; d < DEEP_LEVELS; d++) {
    lines.push(`${"  ".repeat(d)}- 깊이${d + 1}단계`);
  }
  return lines.join("\n");
}

const BIG_NOTE = `---
title: Deep Nesting And Bulk Blocks
status: active
---

# 대량 형제 블록 (>100)

${manySiblings()}

# 깊은 중첩 (>2단계)

${deepNest()}

마지막 문단.
`;

describe.skipIf(SKIP)("I11 구조 제약 무손실 불변식", () => {
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

  it(`형제 ${N_SIBLINGS}개(>100) + ${DEEP_LEVELS}단계 중첩: push 무손실 + 왕복 수렴`, async () => {
    const root = await createIsolatedRoot(raw, "deep-nesting");
    createdPageIds.push(root);
    const vault = await createTmpVault();
    const { orchestrator, stateDb, vaultFs } = makeOrchestrator(vault, root);

    await vaultFs.writeFile("big.md", BIG_NOTE);

    const push1 = await orchestrator.push();
    trackPages(stateDb);
    expect(push1.failed, JSON.stringify(push1.failed)).toHaveLength(0);
    expect(push1.created).toBe(1);

    // 수렴 루프 — 볼트가 변하지 않을 때까지(진행성 손실 없음).
    await sleep(2500);
    const MAX = 4;
    let converged = false;
    let last = "";
    let prev = await snapshotVault(vault);
    for (let i = 0; i < MAX; i++) {
      const r = await orchestrator.sync();
      const cur = await snapshotVault(vault);
      const d = diffSnapshots(prev, cur);
      last = `iter#${i + 1} add=${d.added.length} chg=${d.changed.length} rm=${d.removed.length} push(c=${r.push.created},u=${r.push.updated})`;
      if (
        d.added.length === 0 &&
        d.changed.length === 0 &&
        d.removed.length === 0 &&
        r.push.created === 0 &&
        r.push.updated === 0
      ) {
        converged = true;
        break;
      }
      prev = cur;
      await sleep(1500);
    }
    expect(converged, `왕복 fixpoint 미수렴 — 마지막: ${last}`).toBe(true);

    // 수렴 본문 — 가장 큰 .md 가 대상 노트.
    const snap = await snapshotVault(vault);
    const body = [...snap.values()].sort((a, b) => b.length - a.length)[0] ?? "";

    // (1) 100블록 상한 무손실 — 130개 마커가 모두 생존(잘림 0).
    const markers = (body.match(/항목-\d+-고유마커/g) ?? []).length;
    expect(markers, `형제 블록 누락(잘림) — ${markers}/${N_SIBLINGS}`).toBe(N_SIBLINGS);

    // (2) 2단계 상한 무손실 — 깊은 중첩이 평탄화되지 않고 살아있다.
    //     최소한 3단계 이상 들여쓰기(>2단계)가 본문에 존재해야 한다.
    const deepIndent = /^\s{4,}- /m.test(body);
    expect(deepIndent, "깊은 중첩 평탄화됨(>2단계 들여쓰기 소실)").toBe(true);
    // 각 깊이 라벨 생존 카운트(평탄화돼도 텍스트는 남지만, 들여쓰기 소실은 위에서 잡는다).
    const depthLabels = (body.match(/깊이\d+단계/g) ?? []).length;
    expect(depthLabels, `깊이 라벨 누락 — ${depthLabels}/${DEEP_LEVELS}`).toBe(DEEP_LEVELS);

    await cleanupVault(vault, stateDb);
  });
});
