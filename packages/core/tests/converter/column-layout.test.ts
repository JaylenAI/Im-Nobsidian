/**
 * 컬럼 경계 읽기 (#74) — pull 이 펼친 Notion 컬럼의 줄마다 몇 번째 열인지.
 * 마커 모양은 실볼트(E2E 2026-10-23) 그대로다.
 */
import { describe, expect, it } from "vitest";
import { columnLabel, readColumnLayout } from "../../src/converter/column-layout.js";

const NOTE = [
  "머리 문단", // 0
  "%%im-nobsidian:column-list:start%%", // 1
  "%%im-nobsidian:column:ratio=18.75%%", // 2
  "", // 3
  "왼쪽 글", // 4
  "<br>", // 5
  "%%im-nobsidian:column:ratio=81.25%%", // 6
  "오른쪽 글", // 7
  "%%im-nobsidian:column-list:end%%", // 8
  "꼬리 문단", // 9
];

describe("readColumnLayout", () => {
  it("열 구분 마커부터 다음 구분 · 끝 마커 전까지가 그 열이다", () => {
    const places = readColumnLayout(NOTE);
    expect(places[0]).toBeUndefined();
    expect(places[1]).toBeUndefined();
    expect(places[2]).toEqual({ group: 0, index: 0, count: 2, ratio: 18.75, head: true });
    expect(places[4]).toEqual({ group: 0, index: 0, count: 2, ratio: 18.75, head: false });
    expect(places[5]!.index).toBe(0);
    expect(places[6]).toEqual({ group: 0, index: 1, count: 2, ratio: 81.25, head: true });
    expect(places[7]!.index).toBe(1);
    expect(places[8]).toBeUndefined();
    expect(places[9]).toBeUndefined();
  });

  it("비율 없는 구분 마커 · 묶음 여럿 · 닫히지 않은 묶음", () => {
    const places = readColumnLayout([
      "%%im-nobsidian:column-list:start%%",
      "%%im-nobsidian:column%%",
      "가",
      "%%im-nobsidian:column%%",
      "나",
      "%%im-nobsidian:column%%",
      "다",
      "%%im-nobsidian:column-list:end%%",
      "%%im-nobsidian:column-list:start%%",
      "%%im-nobsidian:column:ratio=50%%",
      "라",
    ]);
    expect(places[2]).toEqual({ group: 0, index: 0, count: 3, head: false });
    expect(places[6]).toEqual({ group: 0, index: 2, count: 3, head: false });
    expect(places[10]).toEqual({ group: 1, index: 0, count: 1, ratio: 50, head: false });
  });

  it("코드 블록 안의 마커 모양 글은 마커가 아니다", () => {
    const places = readColumnLayout([
      "```md",
      "%%im-nobsidian:column-list:start%%",
      "%%im-nobsidian:column%%",
      "```",
      "밖",
    ]);
    expect(places.every((p) => p === undefined)).toBe(true);
  });

  it("문장 속 마커는 경계가 아니다 — 마커만 있는 줄이어야 한다", () => {
    const places = readColumnLayout([
      "%%im-nobsidian:column-list:start%%",
      "글 %%im-nobsidian:column%%",
      "%%im-nobsidian:column-list:end%%",
    ]);
    expect(places.every((p) => p === undefined)).toBe(true);
  });
});

describe("columnLabel", () => {
  it("열 번호와 너비", () => {
    expect(columnLabel({ group: 0, index: 1, count: 3, ratio: 50, head: true })).toBe(
      "열 2/3 · 50%",
    );
    expect(columnLabel({ group: 0, index: 0, count: 2, ratio: 18.75, head: true })).toBe(
      "열 1/2 · 18.75%",
    );
    expect(columnLabel({ group: 0, index: 0, count: 2, head: true })).toBe("열 1/2");
  });
});
