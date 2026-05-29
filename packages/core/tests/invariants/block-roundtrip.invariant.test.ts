/**
 * I2·I3 — 블록 라운드트립 불변식.
 *
 * writable 블록 타입을 모두 담은 노트를 실제 Notion 으로 push 한 뒤 sync 를 반복하여:
 *  (I2) 라운드트립 안정성 — 유한 횟수 안에 fixpoint 로 수렴(볼트 스냅샷 deep-equal 무변동 +
 *       push create·update == 0). 진행성 손실(매 왕복마다 조금씩 깎임)이 있으면 수렴하지 않는다.
 *  (I3) 블록 무손실 — 수렴된 볼트 본문에 각 블록 타입이 구조 카운트로 살아있다(드롭되면 0/false 가
 *       되어 실패). 헤딩·코드(언어)·테이블·콜아웃·3단 중첩 리스트·작업목록·수식(블록/인라인)·
 *       인라인 서식·구분선·링크.
 *
 * 카운트/구조 기반 단언(`.toContain` 미사용) — 손실을 수치로 검증한다. 임계값은 실제 Notion
 * 왕복을 관찰해 실측한 값으로 고정(거짓종료방지).
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
import { TOC_MARKER, BREADCRUMB_MARKER } from "../../src/constants/markers.js";

const RICH_NOTE = `---
title: Rich Block Taxonomy
status: active
tags:
  - block
  - roundtrip
---

${BREADCRUMB_MARKER}

# 헤딩 1

${TOC_MARKER}

본문 문단에 **굵게**, *기울임*, \`인라인코드\`, ~~취소선~~ 포함.

## 헤딩 2

- 최상위 항목
  - 2단계
    - 3단계
- 또 다른 최상위

1. 첫째
2. 둘째

- [ ] 할 일
- [x] 완료된 일

> [!warning] 주의 콜아웃
> 콜아웃 본문 라인

> 일반 인용문

### 헤딩 3

\`\`\`typescript
const x: number = 1;
\`\`\`

$$
E = mc^2
$$

인라인 수식 $a^2 + b^2 = c^2$ 도 포함.

| 이름 | 값 |
| --- | --- |
| A | 1 |
| B | 2 |

[링크](https://example.com)

---

마지막 문단.
`;

describe.skipIf(SKIP)("I2·I3 블록 라운드트립 불변식", () => {
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

  it("리치 블록 노트: 왕복 fixpoint 수렴(I2) + 블록 무손실(I3)", async () => {
    const root = await createIsolatedRoot(raw, "block-roundtrip");
    createdPageIds.push(root);
    const vault = await createTmpVault();
    const { orchestrator, stateDb, vaultFs } = makeOrchestrator(vault, root);

    await vaultFs.writeFile("rich.md", RICH_NOTE);

    const push1 = await orchestrator.push();
    trackPages(stateDb);
    expect(push1.created).toBe(1);
    expect(push1.failed).toHaveLength(0);

    // Notion eventual consistency 대비 후 수렴 루프 — 매 sync 마다 볼트가 변하지 않을 때까지.
    await sleep(2500);

    const MAX = 4;
    let converged = false;
    let last = "";
    let prev = await snapshotVault(vault);
    for (let i = 0; i < MAX; i++) {
      const r = await orchestrator.sync();
      const cur = await snapshotVault(vault);
      const d = diffSnapshots(prev, cur);
      last =
        `iter#${i + 1} add=${d.added.length} chg=${d.changed.length} rm=${d.removed.length} ` +
        `push(c=${r.push.created},u=${r.push.updated})`;
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

    // (I2) 라운드트립이 fixpoint 로 수렴 — 진행성 손실 없음.
    expect(converged, `라운드트립 fixpoint 미수렴 — 마지막: ${last}`).toBe(true);

    // (I3) 수렴된 본문에서 각 블록 타입 생존 확인 — 가장 큰 .md 가 리치 노트.
    const snap = await snapshotVault(vault);
    const body = [...snap.values()].sort((a, b) => b.length - a.length)[0] ?? "";

    const headings = (body.match(/^#{1,3} /gm) ?? []).length;
    const codeFences = (body.match(/^```/gm) ?? []).length;
    const tablePipeRows = (body.match(/^\|.*\|$/gm) ?? []).length;
    const callouts = (body.match(/^> \[!/gm) ?? []).length;
    const taskUnchecked = (body.match(/^- \[ \]/gm) ?? []).length;
    const taskChecked = (body.match(/^- \[x\]/gim) ?? []).length;
    // 구분선(frontmatter 의 --- 제외): 첫 frontmatter 블록을 떼어낸 뒤 검사.
    const bodyNoFm = body.replace(/^---[\s\S]*?\n---\n/, "");
    const inlineMathBody = bodyNoFm.replace(/\$\$[\s\S]*?\$\$/g, "");

    expect(headings, "헤딩 손실").toBe(3);
    expect(codeFences, "코드블록(펜스) 손실").toBeGreaterThanOrEqual(2);
    expect(tablePipeRows, "테이블 행 손실").toBeGreaterThanOrEqual(4);
    expect(callouts, "콜아웃 손실").toBeGreaterThanOrEqual(1);
    expect(taskUnchecked, "미완료 작업목록 손실").toBeGreaterThanOrEqual(1);
    expect(taskChecked, "완료 작업목록 손실").toBeGreaterThanOrEqual(1);
    expect(/^\s{2}[-*0-9] /m.test(body) || /^\s{2}\d+\. /m.test(body), "2단 중첩 손실").toBe(true);
    expect(/^\s{4,}[-*] /m.test(body), "3단 중첩 손실(평탄화됨)").toBe(true);
    expect(body.includes("$$"), "수식 블록 손실").toBe(true);
    expect(/\$[^$\n]+\$/.test(inlineMathBody), "인라인 수식 손실").toBe(true);
    expect(body.includes("**"), "굵게 손실").toBe(true);
    expect(/(^|[^*])\*[^*\n]+\*/.test(body), "기울임 손실").toBe(true);
    expect(body.includes("~~"), "취소선 손실").toBe(true);
    expect(/`[^`\n]+`/.test(body), "인라인코드 손실").toBe(true);
    expect(/^---\s*$/m.test(bodyNoFm), "구분선 손실").toBe(true);
    expect(/\[[^\]]+\]\(https?:/.test(body), "링크 손실").toBe(true);
    // breadcrumb·table_of_contents 는 마크다운 표현이 없어 보존 마커로 왕복한다.
    // 마커가 사라지면 push 에서 일반 문단으로 새거나(toc) 통째 소실(breadcrumb)된 것.
    expect(body.includes(BREADCRUMB_MARKER), "breadcrumb 블록 손실").toBe(true);
    expect(body.includes(TOC_MARKER), "목차(toc) 블록 손실").toBe(true);

    await cleanupVault(vault, stateDb);
  });
});
