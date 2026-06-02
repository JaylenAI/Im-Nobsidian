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

  // M6: url 기반 page mention 의 라벨 동반형(breadcrumb 콜아웃 등)도 해소한다.
  // 기존엔 self-closing(`/>`)만 처리해 라벨형이 raw <mention-page> 로 잔존했다.
  it("<mention-page url=../> (self-closing) → [[notion:id]] (회귀가드)", () => {
    const id = "36413b18d38280869a16d92c1b2239cc";
    expect(
      notionEnhancedToObsidian(`앞 <mention-page url="https://www.notion.so/${id}"/> 뒤`),
    ).toBe(`앞 [[notion:${id}]] 뒤`);
  });

  it("<mention-page url=..>label</mention-page> (라벨형) → [[notion:id]] (M6)", () => {
    const id = "36f13b18d382806587b2e8b7ccb303bc";
    const input = `> [!note] <mention-page url="https://www.notion.so/${id}">AI Engineer (1)</mention-page> | [[ETC]]`;
    const result = notionEnhancedToObsidian(input);
    expect(result).toContain(`[[notion:${id}]]`);
    expect(result).not.toContain("<mention-page");
    expect(result).toContain("[[ETC]]"); // 같은 줄 기존 위키링크 보존
  });

  it("한 줄 다중 라벨형 mention-page 모두 해소 (lazy 과잉소비 방지)", () => {
    const a = "36f13b18d382806587b2e8b7ccb303bc";
    const b = "a7713b18d38282c292ab8158f069bd7f";
    const input = `> [!note] <mention-page url="https://www.notion.so/${a}">AI Engineer (1)</mention-page> | [[ETC]] | <mention-page url="https://www.notion.so/${b}">Study</mention-page>`;
    const result = notionEnhancedToObsidian(input);
    expect(result).toContain(`[[notion:${a}]]`);
    expect(result).toContain(`[[notion:${b}]]`);
    expect(result).not.toContain("<mention-page");
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

// I3 인라인 서식 무손실 — Notion span ↔ compact 마커 왕복이 첫 라운드 이후 fixpoint 로
// 수렴함을 합성으로 못박는다(개별 방향 테스트는 위 두 describe 에 존재).
describe("underline/color 왕복 fixpoint (I3)", () => {
  const spans = [
    '<span underline="true">밑줄</span>',
    '<span color="red">빨강</span>',
    '<span color="yellow_background">강조</span>',
  ];

  for (const span of spans) {
    it(`Notion→Obsidian→Notion fixpoint: ${span}`, () => {
      const marker = notionEnhancedToObsidian(span);
      expect(marker).not.toContain("<span"); // Obsidian 측은 compact 마커
      expect(obsidianToNotionEnhanced(marker)).toBe(span); // 재push 시 원본 span 복원
      // Obsidian 측 마커 자체도 한 번 더 왕복하면 그대로(fixpoint)
      expect(notionEnhancedToObsidian(obsidianToNotionEnhanced(marker))).toBe(marker);
    });
  }
});

// P1(결함①) 회귀 가드 — 토글/콜아웃 내부 코드블록의 cascade 차단.
//
// Notion Markdown API 는 <details>/callout 직계 자식을 탭으로 들여쓴다. 과거에는 본문에
// `> ` 만 덧붙여 닫는 펜스가 `> \t``` ` 형태가 됐고, CommonMark 닫는-펜스 규칙(들여쓰기
// ≤3칸, 탭=4칸) 위반으로 코드블록이 닫히지 않아 이후 본문 전체를 삼켰다(Blog.md L8~597,
// 589줄 오염). 아래 가드는 변환 출력의 코드펜스가 항상 균형을 이룸을 단언한다.
describe("토글/콜아웃 코드펜스 cascade 차단 (P1)", () => {
  // blockquote 마커(`> ` 반복)를 벗긴 뒤 CommonMark 펜스 규칙으로 균형을 검증한다.
  function fencesBalanced(md: string): boolean {
    let open = false;
    let openLen = 0;
    for (const raw of md.split("\n")) {
      const stripped = raw.replace(/^(?:>\s?)+/, "");
      const m = /^([\t ]*)(`{3,}|~{3,})(.*)$/.exec(stripped);
      if (!m) continue;
      const indentCols = m[1]!.replace(/\t/g, "    ").length; // 탭 = 4칸
      const len = m[2]!.length;
      const hasInfo = m[3]!.trim().length > 0;
      if (!open) {
        if (indentCols <= 3) {
          open = true;
          openLen = len;
        }
      } else if (!hasInfo && indentCols <= 3 && len >= openLen) {
        open = false;
        openLen = 0;
      }
    }
    return !open; // EOF 에서 미닫힘 코드블록이 없어야 한다
  }

  // 닫는 펜스가 `> ` + 탭/4칸+ 들여쓰기 + 백틱 형태(=깨진 펜스)로 새지 않아야 한다.
  const BROKEN_FENCE_RE = /(?:>\s?)+(?:\t| {4,})(?:`{3,}|~{3,})/;

  it("탭 들여쓰기 코드 자식을 가진 토글 → 펜스 균형 + 깨진 펜스 없음", () => {
    const notion = [
      "<details>",
      "<summary>코드 토글</summary>",
      "\t```javascript",
      "\tconst x = 1;",
      "\tconsole.log(x);",
      "\t```",
      "</details>",
    ].join("\n");
    const out = notionEnhancedToObsidian(notion);
    expect(out).toContain("> [!toggle]- 코드 토글");
    expect(out).toContain("> ```javascript");
    expect(fencesBalanced(out)).toBe(true);
    expect(out).not.toMatch(BROKEN_FENCE_RE);
  });

  it("토글 뒤 본문이 코드블록에 삼켜지지 않는다 (cascade)", () => {
    const notion = [
      "<details>",
      "<summary>T</summary>",
      "\t```js",
      "\tdoStuff();",
      "\t```",
      "</details>",
      "",
      "# 삼켜지면 안 되는 제목",
      "",
      "본문 단락입니다.",
    ].join("\n");
    const out = notionEnhancedToObsidian(notion);
    expect(fencesBalanced(out)).toBe(true);
    // 제목/단락이 코드펜스 바깥에 평문으로 남아야 한다
    expect(out).toContain("# 삼켜지면 안 되는 제목");
    expect(out).toContain("본문 단락입니다.");
  });

  it("중첩 토글의 내부 코드도 펜스 균형 유지", () => {
    const notion = [
      "<details>",
      "<summary>외부</summary>",
      "\t외부 내용",
      "\t<details>",
      "\t<summary>내부</summary>",
      "\t\t```bash",
      "\t\techo hi",
      "\t\t```",
      "\t</details>",
      "</details>",
    ].join("\n");
    const out = notionEnhancedToObsidian(notion);
    expect(out).toContain("> [!toggle]- 외부");
    expect(fencesBalanced(out)).toBe(true);
    expect(out).not.toMatch(BROKEN_FENCE_RE);
  });

  it("리스트형 토글-코드(normalizeCodeBlockToggles) 2탭 중첩도 변환", () => {
    const notion = ["\t- 중첩 코드 토글", "\t\t```bash", "\t\techo nested", "\t\t```"].join("\n");
    const out = notionEnhancedToObsidian(notion);
    expect(out).toContain("> [!toggle]- 중첩 코드 토글");
    expect(out).toContain("echo nested");
    expect(fencesBalanced(out)).toBe(true);
  });

  it("코드 본문에 백틱 펜스가 있으면 더 긴 펜스로 감싼다 (동적 펜스 길이)", () => {
    const notion = [
      "- 마크다운 예제",
      "\t````markdown",
      "\t```js",
      "\tconst x = 1;",
      "\t```",
      "\t````",
    ].join("\n");
    const out = notionEnhancedToObsidian(notion);
    expect(fencesBalanced(out)).toBe(true);
    expect(out).toContain("> ````markdown"); // 4-백틱 외부 펜스 보존
    expect(out).toContain("> ```js"); // 3-백틱은 내부 콘텐츠
  });

  // 실데이터(Empowerment/Blog) 회귀 가드 — Notion 실제 출력의 **비대칭 들여쓰기**:
  // 펜스 줄만 탭으로 들여쓰고 코드 본문은 열 0 에 둔다. 공통-들여쓰기 dedent 는 최소값이
  // 0(본문)이라 무변경 → 펜스의 탭이 살아남아 `> \t``` ` 로 깨졌다. 코드블록 인식 dedent 로
  // 펜스만 열 0 정렬해 차단. (위 균등-들여쓰기 케이스로는 잡히지 않던 실데이터 결함)
  it("비대칭 들여쓰기(펜스만 탭, 본문 열0) 토글 → 펜스 균형", () => {
    const notion = [
      "<details>",
      "<summary>블로그 작성용 프롬프트 예시</summary>",
      "\t```javascript",
      "월급쟁이부자들 블로그 매체 매뉴얼",
      "",
      "1. 고객 가치",
      "\t```",
      "</details>",
      "",
      "## 뒤따르는 제목",
    ].join("\n");
    const out = notionEnhancedToObsidian(notion);
    expect(out).toContain("> [!toggle]- 블로그 작성용 프롬프트 예시");
    expect(out).toContain("> ```javascript");
    expect(fencesBalanced(out)).toBe(true);
    expect(out).not.toMatch(BROKEN_FENCE_RE);
    // cascade 없음 — 뒤 제목이 코드로 삼켜지지 않는다
    expect(out).toContain("## 뒤따르는 제목");
  });

  it("비대칭 들여쓰기 + 연속 토글(닫힘→열림) → 펜스 균형", () => {
    // 실데이터 L1213~1216 재현: 코드 토글이 닫히자마자 다음 코드 토글이 열리는 인접 배치.
    const notion = [
      "<details>",
      "<summary>클로드 스킬#1</summary>",
      "\t```javascript",
      "const a = 1;",
      "</script>",
      "\t```",
      "</details>",
      "<details>",
      "<summary>클로드 스킬#2</summary>",
      "\t```python",
      "name: blog-writer",
      "\t```",
      "</details>",
    ].join("\n");
    const out = notionEnhancedToObsidian(notion);
    expect(out).toContain("> [!toggle]- 클로드 스킬#1");
    expect(out).toContain("> [!toggle]- 클로드 스킬#2");
    expect(fencesBalanced(out)).toBe(true);
    expect(out).not.toMatch(BROKEN_FENCE_RE);
  });

  it("코드블록 내부의 의미적 들여쓰기는 보존(파이썬)", () => {
    const notion = [
      "<details>",
      "<summary>파이썬</summary>",
      "\t```python",
      "def foo():",
      "    return 1", // 4칸 의미적 들여쓰기 — 보존되어야 함
      "\t```",
      "</details>",
    ].join("\n");
    const out = notionEnhancedToObsidian(notion);
    expect(fencesBalanced(out)).toBe(true);
    expect(out).not.toMatch(BROKEN_FENCE_RE);
    expect(out).toContain(">     return 1"); // 콜아웃 prefix + 보존된 4칸
  });
});

// P2(결함②) 회귀 가드 — 중첩 prefix/탭 누적 폭주 차단.
//
// Notion Markdown API 는 <callout>/<columns> 를 탭으로 들여쓴 직계 자식으로 표현한다.
// 과거 변환은 (1) 평면 비탐욕 정규식이 중첩 콜아웃을 잘못 짝지어 고아 태그를 남기고,
// (2) 안쪽 컨테이너를 풀며 선행 들여쓰기를 열 0 으로 당겨 부모 dedent 공통최소값을 0 으로
// 만들어 구조적 탭이 살아남았다(`> > \t\t…`). 칼럼은 탭 하나만 벗겨 깊은 구조 탭이 남았다.
// 통합 innermost-first 변환(선행 들여쓰기 캡처→재적용)으로 폭주를 차단한다. 실데이터
// portfolio(깊이 6)·checkup(탭 73) 오펜더를 합성으로 재현한다.
describe("중첩 prefix/탭 누적 폭주 차단 (P2)", () => {
  // blockquote prefix(`> ` 반복) 뒤에 구조적 탭이 남으면 폭주. 산문 전용 픽스처에선
  // 코드 본문 탭이 없으므로 prefix 뒤 어떤 탭이든 구조적 폭주로 간주한다.
  const STRUCT_TAB_RE = /(?:>\s?)+[^\n]*\t/;
  // 컨테이너 원시 태그가 출력에 새어나오면 안 된다.
  const RAW_CONTAINER_RE = /<\/?(?:details|summary|callout|columns|column)\b[^>]*>/;

  it("중첩 콜아웃 → > > 올바른 깊이, 고아 태그·탭 폭주 없음", () => {
    const notion = [
      "<callout>",
      "\t상위 콜아웃 본문",
      "\t<callout>",
      "\t\t하위 콜아웃 본문",
      "\t</callout>",
      "</callout>",
    ].join("\n");
    const out = notionEnhancedToObsidian(notion);
    expect(out).toContain("> [!note] 상위 콜아웃 본문");
    expect(out).toContain("> > [!note] 하위 콜아웃 본문");
    expect(out).not.toMatch(RAW_CONTAINER_RE);
    expect(out).not.toMatch(STRUCT_TAB_RE);
  });

  it("칼럼 안 콜아웃 → 평탄화 + 구조적 탭 제거", () => {
    const notion = [
      "<columns>",
      "\t<column>",
      "\t\t<callout>",
      "\t\t\t콜아웃 in 칼럼",
      "\t\t</callout>",
      "\t</column>",
      "\t<column>",
      "\t\t둘째 칼럼 본문",
      "\t</column>",
      "</columns>",
    ].join("\n");
    const out = notionEnhancedToObsidian(notion);
    expect(out).toContain("> [!note] 콜아웃 in 칼럼");
    expect(out).toContain("둘째 칼럼 본문");
    expect(out).not.toMatch(RAW_CONTAINER_RE);
    expect(out).not.toMatch(STRUCT_TAB_RE);
  });

  it("교차 중첩(콜아웃-in-칼럼-in-토글, 깊이 6) → 정확한 중첩, 폭주 없음", () => {
    const notion = [
      "<details>",
      "<summary>포트폴리오</summary>",
      "\t<columns>",
      "\t\t<column>",
      "\t\t\t<callout>",
      "\t\t\t\t깊은 콜아웃",
      "\t\t\t\t<callout>",
      "\t\t\t\t\t더 깊은 콜아웃",
      "\t\t\t\t</callout>",
      "\t\t\t</callout>",
      "\t\t</column>",
      "\t</columns>",
      "</details>",
    ].join("\n");
    const out = notionEnhancedToObsidian(notion);
    expect(out).toContain("> [!toggle]- 포트폴리오");
    expect(out).toContain("> > [!note] 깊은 콜아웃");
    expect(out).toContain("> > > [!note] 더 깊은 콜아웃");
    expect(out).not.toMatch(RAW_CONTAINER_RE);
    expect(out).not.toMatch(STRUCT_TAB_RE);
  });

  it("중첩 토글 → 외부 본문 탭이 prefix 뒤에 남지 않는다", () => {
    const notion = [
      "<details>",
      "<summary>외부</summary>",
      "\t외부 내용",
      "\t<details>",
      "\t<summary>내부</summary>",
      "\t\t내부 내용",
      "\t</details>",
      "</details>",
    ].join("\n");
    const out = notionEnhancedToObsidian(notion);
    expect(out).toContain("> [!toggle]- 외부");
    expect(out).toContain("> 외부 내용"); // `> \t외부 내용` 아님
    expect(out).toContain("> > [!toggle]- 내부");
    expect(out).toContain("> > 내부 내용");
    expect(out).not.toMatch(STRUCT_TAB_RE);
  });

  it("깊은 콜아웃 본문(탭 다수) → prefix 뒤 구조적 탭 없음", () => {
    // checkup 실데이터(`> > \t\t> > \t\t…`) 재현: 칼럼>콜아웃 깊은 들여쓰기 본문.
    const notion = [
      "<columns>",
      "\t<column>",
      "\t\t<callout>",
      "\t\t\t첫 줄",
      "\t\t\t둘째 줄",
      "\t\t\t셋째 줄",
      "\t\t</callout>",
      "\t</column>",
      "</columns>",
    ].join("\n");
    const out = notionEnhancedToObsidian(notion);
    expect(out).toContain("> [!note] 첫 줄");
    expect(out).toContain("> 둘째 줄");
    expect(out).toContain("> 셋째 줄");
    expect(out).not.toMatch(STRUCT_TAB_RE);
  });

  it("콜아웃 안 코드블록(비대칭 들여쓰기) → 펜스 균형 유지(P1 합류)", () => {
    const notion = [
      "<callout>",
      "\t코드 포함 콜아웃",
      "\t```python",
      "def foo():",
      "    return 1",
      "\t```",
      "</callout>",
    ].join("\n");
    const out = notionEnhancedToObsidian(notion);
    // 코드 본문의 의미적 4칸 들여쓰기는 보존(코드블록 내부는 STRUCT_TAB 검사 제외)
    expect(out).toContain("> [!note] 코드 포함 콜아웃");
    expect(out).toContain("> ```python");
    let open = false;
    for (const raw of out.split("\n")) {
      const stripped = raw.replace(/^(?:>\s?)+/, "");
      if (/^[\t ]*(`{3,}|~{3,})/.test(stripped)) open = !open;
    }
    expect(open).toBe(false); // 펜스 균형
  });
});
