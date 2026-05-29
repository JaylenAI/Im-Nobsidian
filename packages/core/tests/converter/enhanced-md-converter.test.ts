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

  it("<details>/<summary> → callout toggle", () => {
    const input = "<details>\n<summary>Toggle Title</summary>\nInner content\n</details>";
    const result = notionEnhancedToObsidian(input);
    expect(result).toContain("> [!toggle]- Toggle Title");
    expect(result).toContain("> Inner content");
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

  // 위키링크: Notion 이 escape 한 평문 위키링크 복원
  it("escape 된 위키링크 \\[\\[..\\]\\] → [[..]] 복원", () => {
    const input = "앞 \\[\\[존재하지않는페이지ZZZ\\]\\] 뒤";
    expect(notionEnhancedToObsidian(input)).toBe("앞 [[존재하지않는페이지ZZZ]] 뒤");
  });

  it("escape 된 별칭 위키링크 \\[\\[t|d\\]\\] → [[t|d]] 복원", () => {
    const input = "앞 \\[\\[대상|표시\\]\\] 뒤";
    expect(notionEnhancedToObsidian(input)).toBe("앞 [[대상|표시]] 뒤");
  });

  it("escape 된 임베드 !\\[\\[..\\]\\] → ![[..]] 복원", () => {
    const input = "!\\[\\[그림.png\\]\\]";
    expect(notionEnhancedToObsidian(input)).toBe("![[그림.png]]");
  });
});

describe("obsidianToNotionEnhanced", () => {
  it("callout toggle → <details>/<summary>", () => {
    const input = "> [!toggle]- Toggle Title\n> Inner content";
    const result = obsidianToNotionEnhanced(input);
    expect(result).toContain("<details>");
    expect(result).toContain("<summary>Toggle Title");
    expect(result).toContain("Inner content");
    expect(result).toContain("</details>");
  });

  it("legacy toggle markers → <details>/<summary>", () => {
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

  // 위키링크: id 기반 mention → url 기반 mention (Notion markdown API 가 id 형식은 통째로 삭제)
  it("resolved 위키링크 mention(id) → url 기반 mention", () => {
    const input =
      '앞 <mention-page id="36413b18-d382-8086-9a16-d92c1b2239cc">제목</mention-page> 뒤';
    expect(obsidianToNotionEnhanced(input)).toBe(
      '앞 <mention-page url="https://www.notion.so/36413b18d38280869a16d92c1b2239cc"/> 뒤',
    );
  });

  it("unresolved 위키링크 preserve-link(target=label) → 평문 [[target]]", () => {
    const input = "앞 [foo](im-nobsidian://wikilink/foo) 뒤";
    expect(obsidianToNotionEnhanced(input)).toBe("앞 [[foo]] 뒤");
  });

  it("unresolved 위키링크 preserve-link(target≠label) → 평문 [[target|label]]", () => {
    const enc = encodeURIComponent("실제 대상");
    const input = `앞 [표시](im-nobsidian://wikilink/${enc}) 뒤`;
    expect(obsidianToNotionEnhanced(input)).toBe("앞 [[실제 대상|표시]] 뒤");
  });

  it("평문 위키링크 [[...]] 는 그대로 보존 (Notion 이 텍스트로 round-trip 복원)", () => {
    const input = "앞 [[그냥링크]] 뒤";
    expect(obsidianToNotionEnhanced(input)).toBe("앞 [[그냥링크]] 뒤");
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

  it("미디어 video 왕복", () => {
    const notion = '<video src="https://example.com/clip.mp4">My Clip</video>';
    const obsidian = notionEnhancedToObsidian(notion);
    const back = obsidianToNotionEnhanced(obsidian);
    expect(back).toBe(notion);
  });

  it("미디어 pdf 왕복", () => {
    const notion = '<pdf src="https://example.com/doc.pdf">My Doc</pdf>';
    const obsidian = notionEnhancedToObsidian(notion);
    const back = obsidianToNotionEnhanced(obsidian);
    expect(back).toBe(notion);
  });

  it("미디어 file 왕복", () => {
    const notion = '<file src="https://example.com/data.zip">Archive</file>';
    const obsidian = notionEnhancedToObsidian(notion);
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

  it("tab 왕복", () => {
    const obsidian = "> [!tab] My Tab\n> Tab body content";
    const notion = obsidianToNotionEnhanced(obsidian);
    expect(notion).toContain('<tab title="My Tab">');
    const back = notionEnhancedToObsidian(notion);
    expect(back).toContain("> [!tab] My Tab");
    expect(back).toContain("> Tab body content");
  });

  it("복합 문서 왕복 (색상 + 밑줄 + unknown + 미디어)", () => {
    const notion = [
      "# 복합 테스트",
      "",
      '<span color="red">중요</span> 텍스트와 <span underline="true">밑줄</span>',
      "",
      '<audio src="https://x.com/a.mp3">음악</audio>',
      "",
      '<unknown id="xyz" type="synced_block"/>',
      "",
      "일반 텍스트",
    ].join("\n");

    const obsidian = notionEnhancedToObsidian(notion);
    expect(obsidian).toContain("%%im-nobsidian:color:red%%중요%%/color%%");
    expect(obsidian).toContain("%%im-nobsidian:underline%%밑줄%%/underline%%");
    expect(obsidian).toContain("[🔊 음악](https://x.com/a.mp3)");
    expect(obsidian).toContain("%%im-nobsidian:unknown:id=xyz&type=synced_block%%");

    const back = obsidianToNotionEnhanced(obsidian);
    expect(back).toContain('<span color="red">중요</span>');
    expect(back).toContain('<span underline="true">밑줄</span>');
    expect(back).toContain('<audio src="https://x.com/a.mp3">음악</audio>');
    expect(back).toContain('<unknown id="xyz" type="synced_block"/>');
  });

  it("중첩 토글 Push→Pull 외부 callout 변환 + 내부 HTML 보존", () => {
    const notion = [
      "<details>",
      "<summary>Outer</summary>",
      "Outer content",
      "<details>",
      "<summary>Inner</summary>",
      "Deep content",
      "</details>",
      "</details>",
    ].join("\n");

    const obsidian = notionEnhancedToObsidian(notion);
    expect(obsidian).toContain("> [!toggle]- Outer");
    expect(obsidian).toContain("Outer content");
    expect(obsidian).toContain("Deep content");
  });

  it("다중 색상 왕복", () => {
    const notion =
      '<span color="red">빨강</span> 그리고 <span color="blue">파랑</span> 그리고 <span color="green">초록</span>';
    const obsidian = notionEnhancedToObsidian(notion);
    const back = obsidianToNotionEnhanced(obsidian);
    expect(back).toBe(notion);
  });

  it("Notion 테이블 HTML → MD 테이블 변환", () => {
    const notion =
      "<table><tr><th>이름</th><th>나이</th></tr><tr><td>Alice</td><td>30</td></tr></table>";
    const obsidian = notionEnhancedToObsidian(notion);
    expect(obsidian).toContain("| 이름 | 나이 |");
    expect(obsidian).toContain("| --- | --- |");
    expect(obsidian).toContain("| Alice | 30 |");
  });

  it("수학식 라운드트립", () => {
    const notion = "Inline $`E = mc^2`$ and block:\n$$\n```\n\\sum_{i=1}^n i\n```\n$$";
    const obsidian = notionEnhancedToObsidian(notion);
    expect(obsidian).toContain("$E = mc^2$");
    expect(obsidian).toContain("$$");
    expect(obsidian).toContain("\\sum_{i=1}^n i");
  });
});
