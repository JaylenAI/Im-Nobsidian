/**
 * 링크 글자 안의 대괄호 — Notion 은 `[[1주] - 제목](url)` 을 링크로 읽지 못하고 주소에만 자동 링크를 건다.
 *
 * 실측(2026-10-23, `pages.create({ markdown })` → `retrieveMarkdown` · 블록 rich text):
 * - `[[1주] - 제목](https://example.com/9)` → `\[\[1주\] - 제목\]([https://example.com/9](https://example.com/9))`
 * - `[\[1주\] - 제목](https://example.com/9)` → 링크 하나(글자 `[1주] - 제목`)
 * 실데이터 E2E 에서 9 줄이 받은 볼트에서 `[[1주] - 제목]([url](url))` 로 바뀌었다.
 */
import { describe, expect, it } from "vitest";
import { escapeLinkTextBrackets } from "../../src/converter/literal-escapes.js";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";

describe("링크 글자의 대괄호 — push", () => {
  it.each([
    ["[[1주] - 제목](https://example.com/9)", "[\\[1주\\] - 제목](https://example.com/9)"],
    ["앞 [a [b] c](https://x.io) 뒤", "앞 [a \\[b\\] c](https://x.io) 뒤"],
    ["- [[A] 9.  B](https://x.io/@a/b)", "- [\\[A\\] 9.  B](https://x.io/@a/b)"],
    ["![캡션 [1]](img.png)", "![캡션 \\[1\\]](img.png)"],
    ["> [x [y]](u) 와 [p [q]](v)", "> [x \\[y\\]](u) 와 [p \\[q\\]](v)"],
  ])("%s", (vault, sent) => {
    expect(escapeLinkTextBrackets(vault)).toBe(sent);
  });

  it.each([
    ["대괄호 없는 링크", "[이름](https://example.com)"],
    ["이미 escape 한 글자", "[\\[1주\\] - 제목](https://example.com/9)"],
    ["위키링크 뒤의 괄호", "[[노트]](설명)"],
    ["배지 — 링크 속 이미지", "[![빌드](https://img.io/b.svg)](https://ci.io)"],
    ["각주", "[본문[^1]](https://x.io)"],
    ["링크 아닌 대괄호", "[[1주] - 제목] (https://x.io)"],
    ["짝이 안 맞아 링크가 아닌 글", "[반만 \\[a] b](u)"],
    ["인라인 코드", "`[[a] b](u)`"],
    ["코드 펜스", "```\n[[a] b](u)\n```"],
    ["작업 목록", "- [ ] 할 일 (내일)"],
  ])("%s 는 그대로", (_name, text) => {
    expect(escapeLinkTextBrackets(text)).toBe(text);
  });
});

describe("링크 글자의 대괄호 — 왕복", () => {
  it.each([
    "[[1주] - 제목](https://example.com/9)",
    "앞 [a [b] c](https://x.io) 뒤",
    "- [[A] 9.  B](https://x.io/@a/b)",
  ])("Notion 이 돌려준 escape 를 받기가 풀어 노트가 그대로다 — %s", (vault) => {
    const sent = obsidianToNotionEnhanced(vault);
    expect(sent).toBe(escapeLinkTextBrackets(vault));
    // Notion 은 escape 한 링크 글자를 그대로 돌려준다(탐침).
    expect(notionEnhancedToObsidian(sent)).toBe(vault);
  });
});
