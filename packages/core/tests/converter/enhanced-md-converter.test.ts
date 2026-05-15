import { describe, it, expect } from "vitest";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";

describe("notionEnhancedToObsidian", () => {
  it("<mention-page> → [[wikilink]]", () => {
    const input = 'See <mention-page id="abc-123">My Note</mention-page> for details';
    expect(notionEnhancedToObsidian(input)).toBe("See [[My Note]] for details");
  });

  it("<mention-user> → @name", () => {
    const input = '<mention-user id="user-1">John</mention-user>';
    expect(notionEnhancedToObsidian(input)).toBe("@John");
  });

  it("<mention-date> → date text", () => {
    expect(notionEnhancedToObsidian('<mention-date start="2026-05-13"/>')).toBe("2026-05-13");
    expect(notionEnhancedToObsidian('<mention-date start="2026-05-13" end="2026-06-01"/>')).toBe(
      "2026-05-13 → 2026-06-01",
    );
  });

  it("<details>/<summary> → toggle markers", () => {
    const input = "<details>\n<summary>Toggle Title</summary>\nInner content\n</details>";
    const result = notionEnhancedToObsidian(input);
    expect(result).toContain("%%im-nobsidian:toggle:start%%");
    expect(result).toContain("- Toggle Title");
    expect(result).toContain("%%im-nobsidian:toggle:end%%");
  });

  it("::: callout → > [!type]", () => {
    const input = "::: callout\n💡 My Tip\nMore details here\n:::";
    const result = notionEnhancedToObsidian(input);
    expect(result).toContain("> [!tip] My Tip");
    expect(result).toContain("> More details here");
  });

  it("<unknown> 블록 제거", () => {
    const input = 'Before <unknown id="xyz" type="button"/> After';
    expect(notionEnhancedToObsidian(input)).toBe("Before  After");
  });
});

describe("obsidianToNotionEnhanced", () => {
  it("toggle markers → <details>/<summary>", () => {
    const input =
      "%%im-nobsidian:toggle:start%%\n- Toggle Title\n  Inner content\n%%im-nobsidian:toggle:end%%";
    const result = obsidianToNotionEnhanced(input);
    expect(result).toContain("<details>");
    expect(result).toContain("<summary>Toggle Title</summary>");
    expect(result).toContain("Inner content");
    expect(result).toContain("</details>");
  });

  it("> [!type] → ::: callout", () => {
    const input = "> [!warning] Be careful";
    const result = obsidianToNotionEnhanced(input);
    expect(result).toContain("::: callout");
    expect(result).toContain("⚠️ Be careful");
  });
});

describe("round-trip", () => {
  it("mention-page 왕복", () => {
    const notion = 'See <mention-page id="abc">My Note</mention-page> here';
    const obsidian = notionEnhancedToObsidian(notion);
    expect(obsidian).toBe("See [[My Note]] here");
  });

  it("callout 왕복", () => {
    const obsidian = "> [!tip] Helpful advice\n> Details here";
    const notion = obsidianToNotionEnhanced(obsidian);
    const back = notionEnhancedToObsidian(notion);
    expect(back).toContain("> [!tip] Helpful advice");
    expect(back).toContain("> Details here");
  });
});
