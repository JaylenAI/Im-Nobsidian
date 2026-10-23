import { describe, expect, it } from "vitest";
import {
  receiveLiteralBackslashes,
  receiveLoneBackticks,
  sendLiteralBackslashes,
} from "../../src/converter/literal-escapes.js";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";
import { respace } from "../../src/converter/post-processors/block-spacer.js";
import { toWikilinkAlias } from "../../src/sync/image-handler.js";

// 실측(2026-10-23, `pages.create({ markdown })` → `retrieveMarkdown`): Notion 은 문장부호가 아닌 글자 앞의 `\` 를
// 지우고(`C:\Users\me` → `C:Usersme`), 글 `\` · 글 백틱을 `\\` · `` \` `` 로 돌려준다.

describe("글 백슬래시 — push", () => {
  it.each([
    ["C:\\Users\\me", "C:\\\\Users\\\\me"],
    ["a \\ b", "a \\\\ b"],
    ["x\\y", "x\\\\y"],
    ["\\한글", "\\\\한글"],
    ["- 목록 C:\\Users", "- 목록 C:\\\\Users"],
  ])("지워질 `\\` 를 `\\\\` 로 — %s", (vault, sent) => {
    expect(sendLiteralBackslashes(vault)).toBe(sent);
  });

  it.each([
    ["escape 쌍", "a\\\\b \\* \\[x\\]"],
    ["줄 끝 — Notion 이 글로 둔다", "끝\\\n다음"],
    ["인라인 코드", "`코드 \\ 안`"],
    ["코드 펜스", "```\nC:\\Users\n```"],
    ["인라인 수식", "$\\alpha + \\beta$"],
    ["블록 수식", "$$\n\\frac{a}{b}\n$$"],
    ["콜아웃 속 블록 수식", "\t$$\n\t\\sum x\n\t$$"],
    ["링크 주소", "[이름](C:\\dir\\a.md)"],
    ["태그 속성", '<callout icon="\\x">'],
  ])("%s 는 그대로", (_name, text) => {
    expect(sendLiteralBackslashes(text)).toBe(text);
  });
});

describe("글 백슬래시 — pull", () => {
  it.each([
    ["C:\\\\Users\\\\me", "C:\\Users\\me"],
    ["a \\\\ b", "a \\ b"],
    ["- 목록 C:\\\\Users", "- 목록 C:\\Users"],
  ])("Notion 의 `\\\\` 를 사람이 쓴 `\\` 로 — %s", (notion, vault) => {
    expect(receiveLiteralBackslashes(notion)).toBe(vault);
  });

  it.each([
    ["뒤가 문장부호 — 풀면 escape 가 된다", "\\\\* \\\\["],
    ["줄 끝", "끝\\\\"],
    ["escape 된 글자", "\\* \\_"],
    ["인라인 코드", "`a\\\\b`"],
    ["수식", "$`\\\\alpha`$"],
  ])("%s 는 그대로", (_name, text) => {
    expect(receiveLiteralBackslashes(text)).toBe(text);
  });

  it("받은 모양을 다시 보내면 Notion 이 가진 모양 그대로다(수렴)", () => {
    for (const notion of ["C:\\\\Users\\\\me", "a \\\\ b", "\\\\* 와 \\\\\\\\ 둘", "끝\\\\"]) {
      expect(sendLiteralBackslashes(receiveLiteralBackslashes(notion))).toBe(notion);
    }
  });
});

describe("글 백틱 — pull", () => {
  it.each([
    ["홀로 선 백틱 \\` 하나", "홀로 선 백틱 ` 하나"],
    ["두 개 `a` 와 하나 \\` 섞임.", "두 개 `a` 와 하나 ` 섞임."],
    ["- 목록 속 \\` 백틱", "- 목록 속 ` 백틱"],
  ])("짝이 생기지 않으면 맨 백틱으로 — %s", (notion, vault) => {
    expect(receiveLoneBackticks(notion)).toBe(vault);
  });

  it.each([
    ["둘을 풀면 코드가 된다", "글 \\`a\\` 글"],
    ["펜스 안", "```\n\\`\n```"],
    ["코드 안의 `\\`", "`a\\` 뒤"],
  ])("%s — 그대로", (_name, text) => {
    expect(receiveLoneBackticks(text)).toBe(text);
  });
});

describe("변환기에 물린 자리", () => {
  it("push 의 마지막 — 볼트의 글 `\\` 가 Notion 에서 지워지지 않는 모양으로", () => {
    expect(obsidianToNotionEnhanced("경로 C:\\Users\\me 와 $\\alpha$")).toBe(
      "경로 C:\\\\Users\\\\me 와 $\\alpha$",
    );
  });

  it("pull — Notion 이 돌려준 글은 볼트에서 쓴 모양 그대로", () => {
    expect(notionEnhancedToObsidian("경로 C:\\\\Users\\\\me 와 하나 \\` 백틱")).toBe(
      "경로 C:\\Users\\me 와 하나 ` 백틱",
    );
  });
});

describe("이미지 캡션 → 임베드 별칭", () => {
  it("캡션의 escape 를 푼다 — 별칭은 글자 그대로다", () => {
    expect(toWikilinkAlias("\\*\\*\\*별칭\\*\\*\\*")).toBe("***별칭***");
  });

  it("푼 뒤 생긴 `|` 도 별칭을 끊지 않게 바꾼다", () => {
    expect(toWikilinkAlias("a \\| b")).toBe("a - b");
  });
});

describe("콜아웃 안 블록 간격", () => {
  it("문단 사이 · 안쪽 콜아웃 앞뒤에 빈 `>` 줄 — 볼트에서 쓴 모양(2026-10-23 라이브)", () => {
    const pulled = [
      "> [!note] 바깥",
      "> 첫 줄",
      "> > [!tip] 안쪽",
      "> > 안쪽 첫 줄",
      "> > 안쪽 둘째 문단",
      "> 바깥 마지막",
    ].join("\n");
    expect(respace(pulled, true)).toBe(
      [
        "> [!note] 바깥",
        "> 첫 줄",
        ">",
        "> > [!tip] 안쪽",
        "> > 안쪽 첫 줄",
        "> >",
        "> > 안쪽 둘째 문단",
        ">",
        "> 바깥 마지막",
      ].join("\n"),
    );
  });

  it("목록 항목은 붙여 둔다 · 머리줄 바로 뒤는 띄우지 않는다", () => {
    const pulled = ["> [!tip] 메모", "> - 하나", "> - 둘", "> 문단"].join("\n");
    expect(respace(pulled, true)).toBe(
      ["> [!tip] 메모", "> - 하나", "> - 둘", ">", "> 문단"].join("\n"),
    );
  });

  it("줄머리가 다른 줄이 섞이면 손대지 않는다 — 떼고 씌우면 그 줄의 깊이가 바뀐다", () => {
    const pulled = ["> [!tip] 메모", "> 첫 줄", "  > 다른 깊이"].join("\n");
    expect(respace(pulled, true)).toBe(pulled);
  });
});
