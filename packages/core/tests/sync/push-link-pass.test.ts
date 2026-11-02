/**
 * push 뒤 패스가 다시 보낼 노트(N8 · P14) — 위키링크 마커가 지금 풀리나. 제목 · 블록 링크는 마커의 `anchor`(못 푼 까닭)로
 * 고른다 — 없는 제목으로 가는 링크를 push 마다 다시 보내지 않게.
 */
import { describe, it, expect } from "vitest";
import { notesWithResolvableWikilinks } from "../../src/sync/push-link-pass.js";
import type { IStateDB } from "../../src/state/state-db-interface.js";

function stateWith(markers: Record<string, string>[], known: string[]): IStateDB {
  return {
    getAll: () => [{ obsidianPath: "가.md", notionPageId: "p-ga", status: "synced" }],
    getPreserveMarkers: () =>
      markers.map((params) => ({ type: "wikilink", params, startIndex: 0 })),
    resolveWikilink: (text: string) =>
      known.includes(text)
        ? { obsidianPath: `${text}.md`, notionPageId: `p-${text}`, title: text, aliases: [] }
        : null,
  } as unknown as IStateDB;
}

describe("notesWithResolvableWikilinks", () => {
  it("페이지 링크는 대상이 풀리면", () => {
    expect(notesWithResolvableWikilinks(stateWith([{ text: "나" }], ["나"]))).toEqual(["가.md"]);
    expect(notesWithResolvableWikilinks(stateWith([{ text: "나" }], []))).toEqual([]);
  });

  it("anchor=page — 그때 없던 페이지가 지금 있으면 · 자기 링크는 늘", () => {
    expect(
      notesWithResolvableWikilinks(stateWith([{ text: "나#제목", anchor: "page" }], ["나"])),
    ).toEqual(["가.md"]);
    expect(
      notesWithResolvableWikilinks(stateWith([{ text: "나#제목", anchor: "page" }], [])),
    ).toEqual([]);
    expect(
      notesWithResolvableWikilinks(stateWith([{ text: "#제목", anchor: "page" }], [])),
    ).toEqual(["가.md"]);
  });

  it("anchor=block — 대상 노트를 이번 push 가 올렸을 때만 · 자기 링크는 고르지 않는다", () => {
    const marker = [{ text: "나#제목", anchor: "block" }];
    expect(notesWithResolvableWikilinks(stateWith(marker, ["나"]))).toEqual([]);
    expect(notesWithResolvableWikilinks(stateWith(marker, ["나"]), new Set(["나.md"]))).toEqual([
      "가.md",
    ]);
    expect(
      notesWithResolvableWikilinks(
        stateWith([{ text: "#제목", anchor: "block" }], []),
        new Set(["가.md"]),
      ),
    ).toEqual([]);
  });

  it("까닭 없는 옛 마커는 페이지가 있으면 한 번 다시 보낸다", () => {
    expect(notesWithResolvableWikilinks(stateWith([{ text: "나#제목" }], ["나"]))).toEqual([
      "가.md",
    ]);
    expect(notesWithResolvableWikilinks(stateWith([{ text: "나#제목" }], []))).toEqual([]);
  });
});
