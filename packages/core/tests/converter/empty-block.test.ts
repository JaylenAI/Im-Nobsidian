/**
 * Notion 빈 블록(`<empty-block/>`) ↔ 볼트 `<br>` 줄.
 *
 * 예전 pull 은 빈 블록을 빈 줄로 바꿔 Obsidian 에 간격이 보이지 않았고, push 때 Notion 이 빈 줄을
 * 버려 빈 블록이 사라졌다. 목록 자식 빈 블록은 pull 에서부터 사라졌다(2026-10-04 실측).
 */
import { describe, it, expect } from "vitest";
import { breaksToEmptyBlocks, emptyBlocksToBreaks } from "../../src/converter/empty-block.js";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";

const T = "\t";
const lines = (...l: string[]) => l.join("\n");

describe("pull — 빈 블록을 <br> 줄로", () => {
  it("맨 바깥 빈 블록 — 간격은 BlockSpacer 가 띄운다", () => {
    expect(emptyBlocksToBreaks(lines("앞", "<empty-block/>", "<empty-block/>", "뒤"))).toBe(
      lines("앞", "<br>", "<br>", "뒤"),
    );
  });

  it("인용 안 빈 블록은 앞뒤를 빈 인용 줄로 띄운다 — 붙으면 뒤 줄이 HTML 로 보인다", () => {
    expect(emptyBlocksToBreaks(lines("> ## 제목", "> <empty-block/>", "> **본문**"))).toBe(
      lines("> ## 제목", ">", "> <br>", ">", "> **본문**"),
    );
  });

  it("이어진 빈 블록 사이에 빈 인용 줄을 겹쳐 넣지 않는다", () => {
    expect(emptyBlocksToBreaks(lines("> 앞", "> <empty-block/>", "> <empty-block/>", "> 뒤"))).toBe(
      lines("> 앞", ">", "> <br>", ">", "> <br>", ">", "> 뒤"),
    );
  });

  it("중첩 인용은 그 깊이의 빈 인용 줄로", () => {
    expect(emptyBlocksToBreaks(lines("> > 앞", "> > <empty-block/>", "> > 뒤"))).toBe(
      lines("> > 앞", "> >", "> > <br>", "> >", "> > 뒤"),
    );
  });

  it("인용이 끝나는 자리에는 뒤 빈 인용 줄을 붙이지 않는다", () => {
    expect(emptyBlocksToBreaks(lines("> 앞", "> <empty-block/>", "밖"))).toBe(
      lines("> 앞", ">", "> <br>", "밖"),
    );
  });

  it("목록 · 칼럼 안 콜아웃(`\\t> `)의 빈 블록", () => {
    expect(emptyBlocksToBreaks(lines(`${T}> 앞`, `${T}> <empty-block/>`, `${T}> 뒤`))).toBe(
      lines(`${T}> 앞`, `${T}>`, `${T}> <br>`, `${T}>`, `${T}> 뒤`),
    );
  });

  it("목록 자식 빈 블록은 들여쓰기를 지킨다", () => {
    expect(emptyBlocksToBreaks(lines("- 항목", `${T}<empty-block/>`, `${T}자식 문단`))).toBe(
      lines("- 항목", `${T}<br>`, `${T}자식 문단`),
    );
    expect(
      emptyBlocksToBreaks(lines("> - 항목", `> ${T}<empty-block/>`, `> ${T}<empty-block/>`)),
    ).toBe(lines("> - 항목", `> ${T}<br>`, `> ${T}<br>`));
  });

  it("문단 아래 들여쓴 빈 블록은 들여쓰기를 뗀다 — 들여쓴 코드블록이 된다", () => {
    expect(emptyBlocksToBreaks(lines("문단", `${T}<empty-block/>`))).toBe(lines("문단", "<br>"));
  });

  it("코드블록 안의 토큰은 코드다", () => {
    const code = lines("```html", "<empty-block/>", "```");
    expect(emptyBlocksToBreaks(code)).toBe(code);
  });
});

describe("push — <br> 줄을 빈 블록으로", () => {
  it("<br> · <br/> · <br /> 만 있는 줄", () => {
    expect(breaksToEmptyBlocks(lines("<br>", "<br/>", "<br />  "))).toBe(
      lines("<empty-block/>", "<empty-block/>", "<empty-block/>"),
    );
  });

  it("접두(인용 · 목록 들여쓰기)는 그대로 둔다", () => {
    expect(breaksToEmptyBlocks(lines("> <br>", "    <br>", `> ${T}<br>`))).toBe(
      lines("> <empty-block/>", "    <empty-block/>", `> ${T}<empty-block/>`),
    );
  });

  it("글 안의 <br> · 표 칸의 <br> · 코드는 그대로", () => {
    const keep = lines("글<br>", "| a<br>b |", "`<br>`", "```", "<br>", "```");
    expect(breaksToEmptyBlocks(keep)).toBe(keep);
  });
});

describe("변환 전체 왕복", () => {
  it("콜아웃 안 빈 블록이 탭 들여쓴 <empty-block/> 로 돌아간다", () => {
    const raw = lines(
      '<callout icon="💡">',
      `${T}첫 줄`,
      `${T}<empty-block/>`,
      `${T}끝 줄`,
      "</callout>",
    );
    const pushed = obsidianToNotionEnhanced(notionEnhancedToObsidian(raw));
    // 빈 인용 줄은 콜아웃 본문의 빈 줄이 되고, Notion 은 빈 줄을 버린다(실측)
    expect(pushed.split("\n").filter((l) => l.trim() !== "")).toEqual(raw.split("\n"));
  });

  it("목록 자식 빈 블록이 남는다", () => {
    const raw = lines("- 항목", `${T}<empty-block/>`, `${T}자식 문단`);
    const pushed = obsidianToNotionEnhanced(notionEnhancedToObsidian(raw));
    expect(pushed).toBe(raw);
  });
});
