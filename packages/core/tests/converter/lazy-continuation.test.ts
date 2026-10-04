/**
 * 콜아웃 · 토글 안에서 앞 블록 문단에 이어 붙는 글 줄 — 목록 항목 · 안쪽 인용 바로 뒤의 글.
 *
 * Notion 에서는 따로 선 블록인데 Obsidian 이 앞 문단에 이어지는 줄로 읽어 목록 항목 · 안쪽 인용
 * 안에 그렸다(2026-10-04 실측).
 */
import { describe, it, expect } from "vitest";
import { separateLazyContinuations } from "../../src/converter/lazy-continuation.js";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";

const T = "\t";
const lines = (...l: string[]) => l.join("\n");
/** 콜아웃 머리 줄 뒤에 본문 줄을 붙인다. */
const callout = (...body: string[]) => lines("> [!tip] 제목", ...body);

describe("pull — 이어 붙는 글 앞에 빈 인용 줄", () => {
  it("콜아웃 안 목록 항목 뒤 글", () => {
    expect(separateLazyContinuations(callout("> - 항목 1", "> - 항목 2", "> 글"))).toBe(
      callout("> - 항목 1", "> - 항목 2", ">", "> 글"),
    );
  });

  it("번호 목록 · 할 일 · 목록 자식 문단 뒤 글", () => {
    expect(separateLazyContinuations(callout("> 1. 하나", "> 글"))).toBe(
      callout("> 1. 하나", ">", "> 글"),
    );
    expect(separateLazyContinuations(callout("> - [ ] 할 일", "> 글"))).toBe(
      callout("> - [ ] 할 일", ">", "> 글"),
    );
    expect(separateLazyContinuations(callout("> - 항목", ">   자식 문단", "> 글"))).toBe(
      callout("> - 항목", ">   자식 문단", ">", "> 글"),
    );
  });

  it("안쪽 인용 · 안쪽 콜아웃 뒤 글 — 들여쓴 글도", () => {
    expect(separateLazyContinuations(callout("> > 안쪽 인용", "> 글"))).toBe(
      callout("> > 안쪽 인용", ">", "> 글"),
    );
    expect(separateLazyContinuations(callout("> > [!note] 안쪽 콜아웃", "> 글"))).toBe(
      callout("> > [!note] 안쪽 콜아웃", ">", "> 글"),
    );
    expect(separateLazyContinuations(callout("> - 항목", ">   > 자식 인용", ">   자식 글"))).toBe(
      callout("> - 항목", ">   > 자식 인용", ">", ">   자식 글"),
    );
  });

  it("토글 · 목록 안 콜아웃(`\\t> `)은 그 접두로", () => {
    expect(separateLazyContinuations(lines("> [!toggle]- 토글", "> - 항목", "> 글"))).toBe(
      lines("> [!toggle]- 토글", "> - 항목", ">", "> 글"),
    );
    expect(
      separateLazyContinuations(lines("- 바깥", `${T}> [!tip] 제목`, `${T}> - 항목`, `${T}> 글`)),
    ).toBe(lines("- 바깥", `${T}> [!tip] 제목`, `${T}> - 항목`, `${T}>`, `${T}> 글`));
  });
});

describe("pull — 그대로 두는 줄", () => {
  it("문단을 끊는 줄 · 각 변환이 띄우는 줄 · 보존 마커", () => {
    for (const next of ["### 제목", "---", "> 안쪽 인용", "| a |", "<br>", "%%im-nobsidian:x%%"]) {
      const content = callout("> - 항목", `> ${next}`);
      expect(separateLazyContinuations(content)).toBe(content);
    }
  });

  it("목록을 잇는 항목 · 항목에 들여쓴 자식", () => {
    const content = callout("> - 항목 1", ">   자식", "> - 항목 2", ">     - 중첩");
    expect(separateLazyContinuations(content)).toBe(content);
  });

  it("앞 줄이 문단이 아니면 — 제목 · 표 · 빈 블록 · 빈 인용 줄 뒤", () => {
    for (const previous of [">   ### 제목", ">   | a |", ">   <br>", ">"]) {
      const content = callout("> - 항목", previous, "> 글");
      expect(separateLazyContinuations(content)).toBe(content);
    }
  });

  it("콜아웃 · 토글이 아닌 인용 — 빈 인용 줄은 Notion 에서 빈 인용 블록이 된다", () => {
    const quote = lines("> 인용", "> - 목록처럼 보이는 인용 글", "> 다음 인용");
    expect(separateLazyContinuations(quote)).toBe(quote);
    const nested = callout("> > - 목록처럼 보이는 안쪽 인용 글", "> > 다음 안쪽 인용");
    expect(separateLazyContinuations(nested)).toBe(nested);
  });

  it("같은 인용의 글 뒤 · 인용 밖 · 코드 안", () => {
    const same = callout("> 글 1", "> 글 2");
    expect(separateLazyContinuations(same)).toBe(same);
    const top = lines("- 항목", "글", "- 항목", "    - 중첩", "    글");
    expect(separateLazyContinuations(top)).toBe(top);
    const code = callout("> ```md", "> - 항목", "> 글", "> ```");
    expect(separateLazyContinuations(code)).toBe(code);
  });
});

describe("변환 전체 왕복", () => {
  it("콜아웃 안 목록 · 안쪽 인용 뒤 문단이 따로 선 블록으로 돌아간다", () => {
    const raw = lines(
      '<callout icon="💡">',
      `${T}제목`,
      `${T}- 항목`,
      `${T}${T}자식 문단`,
      `${T}뒤 문단`,
      `${T}> 안쪽 인용`,
      `${T}인용 뒤 문단`,
      "</callout>",
    );
    const pulled = notionEnhancedToObsidian(raw);
    expect(pulled).toBe(
      lines(
        "> [!tip] 제목",
        "> - 항목",
        ">   자식 문단",
        ">",
        "> 뒤 문단",
        "> > 안쪽 인용",
        ">",
        "> 인용 뒤 문단",
      ),
    );
    const pushed = obsidianToNotionEnhanced(pulled);
    // 빈 인용 줄은 콜아웃 본문의 빈 줄이 되고, Notion 은 빈 줄을 버린다(실측)
    expect(pushed.split("\n").filter((l) => l.trim() !== "")).toEqual(raw.split("\n"));
    expect(notionEnhancedToObsidian(pushed)).toBe(pulled);
  });

  it("인용 블록이 이어진 자리는 그대로 — 빈 인용 줄을 보내면 빈 인용 블록이 생긴다", () => {
    const raw = lines("> 인용", "> - 목록처럼 보이는 인용 글", "> 다음 인용");
    const pulled = notionEnhancedToObsidian(raw);
    expect(pulled).not.toMatch(/^>$/m);
    expect(obsidianToNotionEnhanced(pulled)).toBe(raw);
  });
});
