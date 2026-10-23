/**
 * 글 `*` 가 든 기울임 — Notion 은 `*…\*…*` 의 `\*` 에서 기울임을 닫는다(2026-10-23 탐침: `*기울 \* 임*` →
 * 기울임 `기울 \` + 글 ` 임*`). 같은 기울임을 `_…_` 로 보내면 `기울 * 임` 이 그대로 기울임이 된다. 굵게
 * (`**굵 \* 게**`)는 문제가 없다.
 */
import { describe, it, expect } from "vitest";
import { obsidianToNotionEnhanced } from "../../src/converter/enhanced-md-converter.js";

describe("글 `*` 가 든 기울임 — `_` 로 감싸 보낸다", () => {
  it.each([
    ["*기울 \\* 임* 끝", "_기울 \\* 임_ 끝"],
    ["앞 (*a \\* b*) 뒤", "앞 (_a \\* b_) 뒤"],
    ["- *x \\*y* 와 *z*", "- _x \\*y_ 와 *z*"],
  ])("%s", (note, sent) => {
    expect(obsidianToNotionEnhanced(note)).toBe(sent);
  });

  it.each([
    ["글 `*` 없는 기울임", "*기울임* 끝"],
    ["굵게는 Notion 이 바르게 읽는다", "**굵 \\* 게** 끝"],
    ["글자에 붙은 기울임 — `_` 는 낱말 안에서 기울임이 아니다", "가*기울 \\* 임*나"],
    ["`_` 가 든 기울임", "*a_b \\* c* 끝"],
    ["기울임 밖의 글 `*`", "곱 2 \\* 3"],
    ["인라인 코드", "`*a \\* b*` 끝"],
  ])("%s — 그대로", (_name, note) => {
    expect(obsidianToNotionEnhanced(note)).toBe(note);
  });
});
