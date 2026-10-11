import { describe, it, expect } from "vitest";
import {
  blockPrefixLength,
  splitTableCells,
  toVisibleText,
  TABLE_LINE_RE,
  TABLE_SEPARATOR_RE,
} from "../../src/design/visible-text.js";

describe("toVisibleText — 원문 조각이 그려졌을 때 보이는 글", () => {
  it.each([
    ["**굵게** *기울임* ~~취소~~ ==강조==", "굵게 기울임 취소 강조"],
    ["_밑줄 강조_ 와 snake_case", "밑줄 강조 와 snake_case"],
    ["[[폴더/노트]] · [[노트|별칭]] · [[노트#제목]]", "노트 · 별칭 · 노트 > 제목"],
    ["[링크](https://example.com) 와 ![[그림.png]] ![alt](a.png)", "링크 와  "],
    // 그려진 코드의 글은 찾는 글에서 빠진다 — 코드 앞뒤 글이 이어져야 찾는다
    ["앞 `코드 **그대로**` 끝", "앞  끝"],
    ["<u>밑줄</u> &amp; \\*별\\*", "밑줄 & *별*"],
    ["글 %%주석%% 뒤[^1]", "글  뒤"],
  ])("%s → %s", (source, visible) => {
    expect(toVisibleText(source)).toBe(visible);
  });
});

describe("blockPrefixLength — 줄 머리의 블록 문법", () => {
  it.each([
    ["## 제목", 3],
    ["- [ ] 할 일", 6],
    ["1. 번호", 3],
    ["> > 인용 안 인용", 4],
    ["> [!note]- 콜아웃", 11],
    ["그냥 글", 0],
  ])("%s → %i", (line, length) => {
    expect(blockPrefixLength(line)).toBe(length);
  });
});

describe("표 줄", () => {
  it("이스케이프한 파이프와 코드 안의 파이프는 칸을 나누지 않는다", () => {
    expect(splitTableCells("| a \\| b | `c|d` | e |")).toEqual([
      "",
      " a \\| b ",
      " `c|d` ",
      " e ",
      "",
    ]);
  });

  it("구분 줄 · 인용 안의 표 줄을 알아본다", () => {
    expect(TABLE_SEPARATOR_RE.test("| --- | :-: |")).toBe(true);
    expect(TABLE_SEPARATOR_RE.test("> |---|---|")).toBe(true);
    expect(TABLE_SEPARATOR_RE.test("| a | b |")).toBe(false);
    expect(TABLE_LINE_RE.test("> | a |")).toBe(true);
    expect(TABLE_LINE_RE.test("a | b")).toBe(false);
  });
});
