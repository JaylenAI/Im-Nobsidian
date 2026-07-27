/**
 * I14 — 빈 칼럼 보존 불변식 (D-EMPTY-COLUMN).
 *
 * Notion 의 다단 레이아웃에서 **내용이 없는 칼럼**은 여백을 만드는 실제 구성요소다.
 * 예전 변환기는 "내용이 없다"는 이유로 pull·push 양쪽에서 빈 칼럼을 걷어냈고, 그 결과
 * 3열 레이아웃이 왕복 한 번에 2열로 좁혀졌다 — 렌더링 차이가 아니라 **사용자의 Notion
 * 레이아웃 자체가 파괴**되는 손실이다.
 *
 * 오프라인 테스트(design-fidelity-roundtrip)는 문자열 왕복만 본다. 여기서는 실제 Notion 이
 * 빈 `<column>` 을 받아 주는지까지 포함해 블록 트리 수준으로 확인한다:
 *  (a) pull  — 3열(가운데 빔)이 마커 3개로 내려온다
 *  (b) push  — 되올린 뒤에도 Notion 블록 트리의 column 이 여전히 3개다
 *  (c) 수렴  — 다시 sync 해도 열 개수가 움직이지 않는다
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

/** 가운데가 빈 3열 레이아웃 — Notion 쪽 원본. */
const THREE_COL_WITH_HOLE = `<columns>
<column>
왼쪽 칼럼 본문
</column>
<column>
</column>
<column>
오른쪽 칼럼 본문
</column>
</columns>`;

const COLUMN_MARKER = "%%im-nobsidian:column%%";

describe.skipIf(SKIP)("I14 빈 칼럼 보존 불변식", () => {
  let raw: Client;
  const createdPageIds: string[] = [];

  beforeAll(() => {
    raw = rawNotion();
  });

  afterAll(async () => {
    await archivePages(raw, createdPageIds);
  });

  /** 페이지의 첫 column_list 아래 column 블록 개수. 레이아웃이 좁혀지면 줄어든다. */
  async function countColumns(pageId: string): Promise<number> {
    const children = await raw.blocks.children.list({ block_id: pageId, page_size: 100 });
    const list = children.results.find(
      (b) => "type" in b && (b as { type: string }).type === "column_list",
    );
    if (!list) return 0;
    const cols = await raw.blocks.children.list({ block_id: list.id, page_size: 100 });
    return cols.results.filter((c) => "type" in c && (c as { type: string }).type === "column")
      .length;
  }

  it("3열(가운데 빔) 레이아웃이 왕복해도 3열로 남는다", async () => {
    const root = await createIsolatedRoot(raw, "empty-column");
    createdPageIds.push(root);

    const page = await raw.pages.create({
      parent: { page_id: root },
      properties: { title: { title: [{ text: { content: "빈 칼럼 레이아웃" } }] } },
      markdown: THREE_COL_WITH_HOLE,
    } as never);
    createdPageIds.push(page.id);

    // 전제: Notion 이 빈 칼럼을 실제로 받아 준다(안 받아 주면 보존 자체가 불가능).
    expect(await countColumns(page.id), "Notion 이 빈 칼럼을 거부함 — 전제 붕괴").toBe(3);

    const vault = await createTmpVault();
    const { orchestrator, stateDb, vaultFs } = makeOrchestrator(vault, root);

    await sleep(2500);
    const pull1 = await orchestrator.pull();
    expect(pull1.failed).toHaveLength(0);

    // (a) pull — 칼럼마다 마커 1개. 빈 칼럼이 걷혀 나가면 2개로 줄어든다.
    const files = await vaultFs.listMarkdownFiles();
    const target = files.find((f) => f.path.includes("빈 칼럼 레이아웃"))?.path;
    expect(target, `pull 된 노트를 못 찾음: ${files.map((f) => f.path).join(", ")}`).toBeDefined();
    const pulled = await vaultFs.readFile(target!);
    const markers = (pulled.match(new RegExp(COLUMN_MARKER, "g")) ?? []).length;
    expect(markers, "빈 칼럼이 pull 에서 사라짐 — 마커 수 부족").toBe(3);

    // (b) push — 로컬 편집을 하나 얹어 되올린 뒤 Notion 블록 트리를 다시 센다.
    await vaultFs.writeFile(target!, `${pulled.trimEnd()}\n\n왕복 확인용 문단.\n`);
    const push1 = await orchestrator.push();
    expect(push1.failed).toHaveLength(0);
    await sleep(2500);

    expect(await countColumns(page.id), "push 가 사용자 Notion 레이아웃을 좁힘").toBe(3);

    // (c) 수렴 — 한 번 더 왕복해도 열 개수는 그대로.
    await orchestrator.sync();
    await sleep(2000);
    expect(await countColumns(page.id), "재동기화에서 열 개수가 흔들림").toBe(3);

    await cleanupVault(vault, stateDb);
  });
});
