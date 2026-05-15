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

  it("<unknown> 블록 보존 마커 생성", () => {
    const input = 'Before <unknown id="xyz" type="button"/> After';
    expect(notionEnhancedToObsidian(input)).toBe(
      "Before %%im-nobsidian:unknown:id=xyz&type=button%% After",
    );
  });

  // 2A: 미디어 태그
  it("<audio> → 링크 변환", () => {
    const input = '<audio src="https://example.com/song.mp3">My Song</audio>';
    expect(notionEnhancedToObsidian(input)).toBe("[🔊 My Song](https://example.com/song.mp3)");
  });

  it("<video> → 링크 변환", () => {
    const input = '<video src="https://example.com/clip.mp4">My Video</video>';
    expect(notionEnhancedToObsidian(input)).toBe("[🎬 My Video](https://example.com/clip.mp4)");
  });

  it("<pdf> → 링크 변환", () => {
    const input = '<pdf src="https://example.com/doc.pdf">Report</pdf>';
    expect(notionEnhancedToObsidian(input)).toBe("[📄 Report](https://example.com/doc.pdf)");
  });

  it("<file> → 링크 변환", () => {
    const input = '<file src="https://example.com/data.zip">Archive</file>';
    expect(notionEnhancedToObsidian(input)).toBe("[📎 Archive](https://example.com/data.zip)");
  });

  it("미디어 태그 캡션 없으면 기본값", () => {
    const input = '<audio src="https://example.com/a.mp3"></audio>';
    expect(notionEnhancedToObsidian(input)).toBe("[🔊 audio](https://example.com/a.mp3)");
  });

  // 2B: Tab 블록
  it("<tab> → 콜아웃 보존", () => {
    const input = '<tab title="First Tab">Tab content here</tab>';
    const result = notionEnhancedToObsidian(input);
    expect(result).toContain("> [!tab] First Tab");
    expect(result).toContain("> Tab content here");
  });

  // 2C: 색상 보존
  it("<span color> → 보존 마커", () => {
    const input = '<span color="red">중요</span>';
    expect(notionEnhancedToObsidian(input)).toBe("%%im-nobsidian:color:red%%중요%%/color%%");
  });

  // 2C: 밑줄 보존
  it("<span underline> → 보존 마커", () => {
    const input = '<span underline="true">밑줄 텍스트</span>';
    expect(notionEnhancedToObsidian(input)).toBe(
      "%%im-nobsidian:underline%%밑줄 텍스트%%/underline%%",
    );
  });

  // 2D: unknown 보존 (alt 속성)
  it("<unknown alt> 블록 보존 마커", () => {
    const input = '<unknown id="abc" alt="bookmark"/>';
    expect(notionEnhancedToObsidian(input)).toBe("%%im-nobsidian:unknown:id=abc&type=bookmark%%");
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

  // 2A: 미디어 마커 → Enhanced MD
  it("🔊 링크 → <audio>", () => {
    const input = "[🔊 My Song](https://example.com/song.mp3)";
    expect(obsidianToNotionEnhanced(input)).toBe(
      '<audio src="https://example.com/song.mp3">My Song</audio>',
    );
  });

  it("🎬 링크 → <video>", () => {
    const input = "[🎬 My Video](https://example.com/clip.mp4)";
    expect(obsidianToNotionEnhanced(input)).toBe(
      '<video src="https://example.com/clip.mp4">My Video</video>',
    );
  });

  it("📄 링크 → <pdf>", () => {
    const input = "[📄 Report](https://example.com/doc.pdf)";
    expect(obsidianToNotionEnhanced(input)).toBe(
      '<pdf src="https://example.com/doc.pdf">Report</pdf>',
    );
  });

  it("📎 링크 → <file>", () => {
    const input = "[📎 Archive](https://example.com/data.zip)";
    expect(obsidianToNotionEnhanced(input)).toBe(
      '<file src="https://example.com/data.zip">Archive</file>',
    );
  });

  // 2B: Tab 콜아웃 → <tab>
  it("> [!tab] → <tab>", () => {
    const input = "> [!tab] First Tab\n> Tab content here";
    const result = obsidianToNotionEnhanced(input);
    expect(result).toContain('<tab title="First Tab">');
    expect(result).toContain("Tab content here");
    expect(result).toContain("</tab>");
  });

  // 2C: 색상 마커 → <span color>
  it("color 마커 → <span color>", () => {
    const input = "%%im-nobsidian:color:red%%중요%%/color%%";
    expect(obsidianToNotionEnhanced(input)).toBe('<span color="red">중요</span>');
  });

  // 2C: 밑줄 마커 → <span underline>
  it("underline 마커 → <span underline>", () => {
    const input = "%%im-nobsidian:underline%%밑줄%%/underline%%";
    expect(obsidianToNotionEnhanced(input)).toBe('<span underline="true">밑줄</span>');
  });

  // 2D: unknown 마커 → <unknown>
  it("unknown 마커 → <unknown>", () => {
    const input = "%%im-nobsidian:unknown:id=abc&type=bookmark%%";
    expect(obsidianToNotionEnhanced(input)).toBe('<unknown id="abc" type="bookmark"/>');
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

  it("미디어 audio 왕복", () => {
    const notion = '<audio src="https://example.com/song.mp3">My Song</audio>';
    const obsidian = notionEnhancedToObsidian(notion);
    expect(obsidian).toBe("[🔊 My Song](https://example.com/song.mp3)");
    const back = obsidianToNotionEnhanced(obsidian);
    expect(back).toBe(notion);
  });

  it("색상 왕복", () => {
    const notion = '<span color="blue">파란색 텍스트</span>';
    const obsidian = notionEnhancedToObsidian(notion);
    expect(obsidian).toBe("%%im-nobsidian:color:blue%%파란색 텍스트%%/color%%");
    const back = obsidianToNotionEnhanced(obsidian);
    expect(back).toBe(notion);
  });

  it("밑줄 왕복", () => {
    const notion = '<span underline="true">밑줄</span>';
    const obsidian = notionEnhancedToObsidian(notion);
    expect(obsidian).toBe("%%im-nobsidian:underline%%밑줄%%/underline%%");
    const back = obsidianToNotionEnhanced(obsidian);
    expect(back).toBe(notion);
  });

  it("unknown 블록 왕복", () => {
    const notion = '<unknown id="def" type="embed"/>';
    const obsidian = notionEnhancedToObsidian(notion);
    expect(obsidian).toBe("%%im-nobsidian:unknown:id=def&type=embed%%");
    const back = obsidianToNotionEnhanced(obsidian);
    expect(back).toBe(notion);
  });
});
