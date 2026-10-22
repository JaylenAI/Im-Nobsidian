/**
 * 동기화 블록 참조를 본문 대신 블록으로 붙인다 — 2026-10-22 실데이터 E2E.
 *
 * 참조를 Markdown API 로 보내면 Notion 이 다른 페이지에 있는 원본의 자식을 보낸 내용으로 다시 만들고,
 * 빈 참조는 원본을 비운다(실측). 본문에는 자리표시 문단만 보내고 참조는 블록 API 로 붙인다.
 */
import { describe, it, expect, vi } from "vitest";
import { deferredSyncedRefMarker } from "../../src/constants/markers.js";
import { deferSyncedReferences, fillSyncedReferences } from "../../src/sync/deferred-synced-ref.js";

const URL =
  "https://app.notion.com/p/11111111111141118111111111111111#22222222222242228222222222222222";
const SOURCE = "22222222-2222-4222-8222-222222222222";
const ref = (indent: string, body: string) =>
  `${indent}<synced_block_reference url="${URL}">\n${body}\n${indent}</synced_block_reference>`;

describe("deferSyncedReferences — 참조를 자리표시 문단으로", () => {
  it("참조 안의 글을 보내지 않고 자리표시와 원본 블록 id 를 남긴다", () => {
    const out = deferSyncedReferences(`Intro\n${ref("", "\tShared ![x](y)")}\nAfter`);

    expect(out.nfm).toBe(`Intro\n${deferredSyncedRefMarker(0)}\nAfter`);
    expect(out.refs).toEqual([{ token: deferredSyncedRefMarker(0), sourceBlockId: SOURCE }]);
    expect(out.removed).toContain("Shared ![x](y)");
  });

  it("컨테이너 안의 참조는 그 깊이에 자리표시를 둔다", () => {
    const nfm = `<callout>\n\tLead\n${ref("\t", "\t\tInner")}\n</callout>`;

    expect(deferSyncedReferences(nfm).nfm).toBe(
      `<callout>\n\tLead\n\t${deferredSyncedRefMarker(0)}\n</callout>`,
    );
  });

  it("빈 참조 · 스스로 닫는 참조도 보내지 않는다 — 빈 참조는 원본을 비운다", () => {
    const nfm = `<synced_block_reference url="${URL}">\n</synced_block_reference>\n<synced_block_reference url="${URL}"/>`;
    const out = deferSyncedReferences(nfm);

    expect(out.nfm).toBe(`${deferredSyncedRefMarker(0)}\n${deferredSyncedRefMarker(1)}`);
    expect(out.refs.map((r) => r.sourceBlockId)).toEqual([SOURCE, SOURCE]);
  });

  it("원본 블록 id 가 없는 참조는 붙일 수 없어 뺀다", () => {
    const nfm = `A\n<synced_block_reference url="https://app.notion.com/p/x">\n\tT\n</synced_block_reference>\nB`;
    const out = deferSyncedReferences(nfm);

    expect(out.nfm).toBe("A\n\nB");
    expect(out.refs).toEqual([]);
  });

  it("이 페이지의 원본 동기화 블록은 그대로 보낸다", () => {
    const nfm = `<synced_block url="${URL}">\n\tMine\n</synced_block>`;

    expect(deferSyncedReferences(nfm)).toEqual({ nfm, refs: [], removed: "" });
  });
});

describe("fillSyncedReferences — 자리표시 뒤에 참조를 붙인다", () => {
  const para = (id: string, text: string) => ({
    id,
    type: "paragraph",
    has_children: false,
    paragraph: { rich_text: [{ plain_text: text }] },
  });
  const client = (tree: Record<string, unknown[]>) => ({
    fetchAllChildren: vi.fn(async (id: string) => (tree[id] ?? []) as never),
    appendChildren: vi.fn(async () => ["new"]),
    deleteBlock: vi.fn(async () => undefined),
  });
  const token = deferredSyncedRefMarker(0);

  it("컨테이너 안의 자리표시는 그 컨테이너에 붙이고 자리표시를 지운다", async () => {
    const c = client({
      page: [para("p1", "Intro"), { id: "co", type: "callout", has_children: true, callout: {} }],
      co: [para("ph", ` ${token} `)],
    });

    expect(await fillSyncedReferences(c, "page", [{ token, sourceBlockId: SOURCE }])).toBe(true);
    expect(c.appendChildren).toHaveBeenCalledWith(
      "co",
      [
        {
          type: "synced_block",
          synced_block: { synced_from: { type: "block_id", block_id: SOURCE } },
        },
      ],
      { after: "ph" },
    );
    expect(c.deleteBlock).toHaveBeenCalledWith("ph");
  });

  it("다른 페이지 안은 찾지 않고, 다 찾지 못하면 던진다", async () => {
    const c = client({
      page: [{ id: "cp", type: "child_page", has_children: true, child_page: {} }],
      cp: [para("ph", token)],
    });

    await expect(
      fillSyncedReferences(c, "page", [{ token, sourceBlockId: SOURCE }]),
    ).rejects.toThrow("동기화 블록 참조 1개를 Notion 에 붙이지 못함");
    expect(c.appendChildren).not.toHaveBeenCalled();
  });

  it("붙일 참조가 없으면 블록을 읽지 않는다", async () => {
    const c = client({});

    expect(await fillSyncedReferences(c, "page", [])).toBe(false);
    expect(c.fetchAllChildren).not.toHaveBeenCalled();
  });
});
