/**
 * F-06 — 콜아웃 종류 ↔ Notion 아이콘 표가 넷이던 결함.
 *
 * 표 둘이 `abstract` · `example` 의 아이콘을 거꾸로 적어 블록 경로로 받은 `abstract` 가 `example` 로
 * 돌아왔고, 별칭(`faq` · `tldr` …)은 어느 표에도 없어 아이콘 없이 올라가 `[!note]` 로 돌아왔다
 * (2026-10-04 실측). 이제 표는 `callout-types.ts` 하나이고, 모든 경로가 그것을 읽는다.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_CALLOUT_TYPE,
  calloutIconOf,
  calloutIcons,
  calloutTypeOf,
} from "../../src/converter/callout-types.js";
import { CalloutTransformer } from "../../src/converter/pre-processors/callout.js";
import { CalloutRestorer } from "../../src/converter/post-processors/callout-restorer.js";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";

/** Obsidian 이 같은 모양으로 그리는 이름 — https://help.obsidian.md/callouts */
const ALIASES: Array<[alias: string, type: string]> = [
  ["summary", "abstract"],
  ["tldr", "abstract"],
  ["hint", "tip"],
  ["important", "tip"],
  ["check", "success"],
  ["done", "success"],
  ["help", "question"],
  ["faq", "question"],
  ["caution", "warning"],
  ["attention", "warning"],
  ["fail", "failure"],
  ["missing", "failure"],
  ["error", "danger"],
  ["cite", "quote"],
];

describe("콜아웃 종류 표", () => {
  it("종류마다 아이콘이 하나고, 아이콘은 그 종류로 돌아온다", () => {
    const icons = calloutIcons();
    expect(new Set(icons.map(([icon]) => icon)).size).toBe(icons.length);
    for (const [icon, type] of icons) {
      expect(calloutIconOf(type)).toBe(icon);
      expect(calloutTypeOf(icon)).toBe(type);
    }
  });

  it.each(ALIASES)("별칭 %s 는 %s 의 아이콘으로 — 받으면 첫 이름", (alias, type) => {
    expect(calloutIconOf(alias)).toBe(calloutIconOf(type));
    expect(calloutTypeOf(calloutIconOf(alias)!)).toBe(type);
  });

  it("종류는 대소문자를 가리지 않는다 — Obsidian 처럼", () => {
    expect(calloutIconOf("FAQ")).toBe(calloutIconOf("question"));
    expect(calloutIconOf("Warning")).toBe(calloutIconOf("warning"));
  });

  it("표에 없는 종류는 아이콘이 없고, 표에 없는 아이콘은 기본 종류다", () => {
    expect(calloutIconOf("custom")).toBeUndefined();
    expect(calloutTypeOf("\u{1F389}")).toBe(DEFAULT_CALLOUT_TYPE);
  });
});

describe("모든 경로가 같은 표를 읽는다", () => {
  const PUSH_BLOCK = { direction: "push", path: "block-api", filePath: "a.md" } as const;
  const PULL = { direction: "pull", path: "markdown-api", filePath: "a.md" } as const;

  it.each([
    ["abstract", "\u{1F4CC}"],
    ["example", "\u{1F4CB}"],
    ["faq", "\u{2753}"],
  ])("블록 경로 push — [!%s] 는 %s", (type, icon) => {
    const content = new CalloutTransformer().process({
      content: `> [!${type}] 제목`,
      metadata: {},
      context: PUSH_BLOCK,
    }).content;
    // 둘째 줄은 종류 · 접힘을 싣는 마커다.
    expect(content.split("\n")[0]).toBe(`> ${icon} **제목**`);
  });

  it("블록 경로 pull — 📌 는 abstract, 📋 는 example", () => {
    const restore = (content: string) =>
      new CalloutRestorer().process({ content, metadata: {}, context: PULL }).content;
    expect(restore("> \u{1F4CC} **요약**")).toBe("> [!abstract] 요약");
    expect(restore("> \u{1F4CB} **예시**")).toBe("> [!example] 예시");
  });

  it.each([
    ["faq", "\u{2753}", "question"],
    ["TLDR", "\u{1F4CC}", "abstract"],
    ["todo", "\u{2611}\u{FE0F}", "todo"],
  ])("Markdown 경로 — [!%s] 는 %s 로 올라가 [!%s] 로 돌아온다", (type, icon, back) => {
    const sent = obsidianToNotionEnhanced(`> [!${type}] 제목\n> 본문`);
    expect(sent).toBe(`<callout icon="${icon}">\n\t제목\n\t본문\n</callout>`);
    expect(notionEnhancedToObsidian(sent)).toBe(`> [!${back}] 제목\n> 본문`);
  });
});
