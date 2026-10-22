/**
 * S-33 — 첨부 자리표시자보다 깊이 들여쓴 뒷줄이 업로드에서 지워지던 결함.
 *
 * Notion 은 인용보다 깊이 들여쓴 줄을 — 빈 줄을 사이에 두어도 — 그 인용의 자식으로 묶는다(실측
 * 2026-10-04). 업로드가 자리표시자 인용을 이미지로 바꾸며 지울 때 그 자식도 지워졌다. push 는 이제
 * 자리표시자를 뒷줄 깊이로 들여 둘을 형제로 둔다 — 실측에서 둘 다 앞 블록의 자식으로 갔다.
 */
import { describe, it, expect } from "vitest";
import { indentPlaceholdersToNextLine } from "../../src/converter/placeholder-indent.js";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";
import { obsidianToNotionEnhanced } from "../../src/converter/enhanced-md-converter.js";

const PUSH = { direction: "push", path: "markdown-api", filePath: "a.md" } as const;

/** push 가 Notion 에 보내는 글. */
const sent = (note: string): string =>
  obsidianToNotionEnhanced(createDefaultPipeline().convertToNotion(note, PUSH).content);

const image = (name: string) => `> 📎 ${name} %% im-nobsidian:local-image:${name} %%`;
const file = (name: string) => `> 📎 ${name} %% im-nobsidian:local-file:${name} %%`;

describe("indentPlaceholdersToNextLine — 자리표시자를 깊이 들여쓴 뒷줄과 형제로", () => {
  /** [이름, 보내던 글, 고친 글] */
  const RAISED: Array<[string, string, string]> = [
    [
      "맨 바깥 — 빈 줄 · 네 칸 목록",
      `- 항목\n\n${image("a.png")}\n\n    - 깊은 하나\n    - 깊은 둘`,
      `- 항목\n\n    ${image("a.png")}\n\n    - 깊은 하나\n    - 깊은 둘`,
    ],
    [
      "탭으로 들여쓴 문단",
      `앞 문단\n\n${file("b.pdf")}\n\n\t뒤 문단`,
      `앞 문단\n\n\t${file("b.pdf")}\n\n\t뒤 문단`,
    ],
    [
      "두 칸 줄 — 빈 줄 없이",
      `${image("a.png")}\n  이어 쓴 글`,
      `  ${image("a.png")}\n  이어 쓴 글`,
    ],
    [
      "콜아웃 속 목록 항목에 이어 쓴 임베드 뒤 더 깊은 하위 목록",
      [
        '<callout icon="📝">',
        "\t1. 항목",
        "\t\t- 하위 둘",
        `\t\t${image("b.png")}`,
        "\t\t\t- 손자",
        "\t\t\t- 손자 둘",
        "\t\t- 하위 셋",
        "</callout>",
      ].join("\n"),
      [
        '<callout icon="📝">',
        "\t1. 항목",
        "\t\t- 하위 둘",
        `\t\t\t${image("b.png")}`,
        "\t\t\t- 손자",
        "\t\t\t- 손자 둘",
        "\t\t- 하위 셋",
        "</callout>",
      ].join("\n"),
    ],
    [
      "잇단 자리표시자는 아랫것을 따라 함께 든다",
      `앞 문단\n\n${image("a.png")}\n\n${image("b.png")}\n\n    - 깊은 항목`,
      `앞 문단\n\n    ${image("a.png")}\n\n    ${image("b.png")}\n\n    - 깊은 항목`,
    ],
    [
      "뒷줄이 코드 블록이면 여는 펜스 줄의 깊이",
      `앞 문단\n\n${image("a.png")}\n\n    \`\`\`js\n    const a = 1;\n    \`\`\``,
      `앞 문단\n\n    ${image("a.png")}\n\n    \`\`\`js\n    const a = 1;\n    \`\`\``,
    ],
  ];

  it.each(RAISED)("%s", (_name, before, after) => {
    expect(indentPlaceholdersToNextLine(before)).toBe(after);
  });

  /** [이름, 그대로 둘 글] */
  const KEPT: Array<[string, string]> = [
    ["뒷줄이 같은 깊이", `\t- 하위\n\t${image("a.png")}\n\t- 하위 둘`],
    ["뒷줄이 더 얕음", `\t\t${image("a.png")}\n\n\t2. 둘째\n</callout>`],
    ["컨테이너를 닫는 줄", `<callout>\n\t${image("a.png")}\n</callout>`],
    ["글 끝", `앞 문단\n\n${image("a.png")}\n`],
    ["코드 속 자리표시자 모양 글", `\`\`\`md\n${image("a.png")}\n    - 깊은 줄\n\`\`\``],
    ["자리표시자가 아닌 인용", "> 인용\n\n    - 깊은 항목"],
  ];

  it.each(KEPT)("%s — 그대로", (_name, content) => {
    expect(indentPlaceholdersToNextLine(content)).toBe(content);
  });
});

describe("push 가 보내는 글 — 실볼트 모양", () => {
  it("임베드 뒤 빈 줄 · 네 칸 목록이면 자리표시자를 네 칸으로 들인다", () => {
    const note = "### 제목\n\n- 항목\n\n![[a.png]]\n\n    - 깊은 하나\n    - 깊은 둘\n";
    expect(sent(note)).toContain(`- 항목\n\n    ${image("a.png")}\n\n    - 깊은 하나`);
  });

  it("뒷줄이 같은 깊이면 보내던 글 그대로", () => {
    const note = "앞 문단\n\n![[a.png]]\n\n뒤 문단\n";
    expect(sent(note)).toBe(`앞 문단\n\n${image("a.png")}\n\n뒤 문단`);
  });
});
