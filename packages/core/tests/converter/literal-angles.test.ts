/**
 * Notion 이 글의 `<` · `>` 를 `\<` · `\>` 로 준다 (이슈 #8 — pull 이 노트의 `->` 를 `-\>` 로 바꿨다).
 * 아래 입력은 2026-10-25 탐침이 markdown API 에서 실제로 받은 모양이다.
 */
import { describe, it, expect } from "vitest";
import { unescapeAngleBrackets } from "../../src/converter/literal-angles.js";
import { notionEnhancedToObsidian } from "../../src/converter/enhanced-md-converter.js";

describe("unescapeAngleBrackets", () => {
  it("굵은 글씨 · 문단 · 제목 · 목록 · 인용 안의 화살표", () => {
    const received = [
      "**a -\\> b**",
      "a -\\> b",
      "# h -\\> i",
      "- **x -\\> y** tail",
      "- [ ] task -\\> x",
      "> quoted -\\> arrow",
      "a \\<- b and x =\\> y",
      "1 \\>= 0 and 3 \\> 2",
    ].join("\n");
    expect(unescapeAngleBrackets(received)).toBe(
      [
        "**a -> b**",
        "a -> b",
        "# h -> i",
        "- **x -> y** tail",
        "- [ ] task -> x",
        "> quoted -> arrow",
        "a <- b and x => y",
        "1 >= 0 and 3 > 2",
      ].join("\n"),
    );
  });

  it("줄 맨 앞의 \\> 는 둔다 — 풀면 인용이 된다", () => {
    for (const line of ["\\> not a quote", "  \\> x", "- \\> x", "> \\> x", "1. \\> x"]) {
      expect(unescapeAngleBrackets(line)).toBe(line);
    }
  });

  it("태그 · 자동 링크를 열 \\< 는 둔다", () => {
    for (const line of [
      "a\\<b\\> c",
      "\\<span\\>",
      "\\</div\\>",
      "\\<!-- x --\\>",
      "\\<https://x\\>",
    ]) {
      expect(unescapeAngleBrackets(line)).toMatch(/\\</);
    }
  });

  it("코드 펜스 · 인라인 코드 안은 그대로", () => {
    const text = "`a -\\> b` and -\\> c\n```\nx -\\> y\n```";
    expect(unescapeAngleBrackets(text)).toBe("`a -\\> b` and -> c\n```\nx -\\> y\n```");
  });

  it("글 백슬래시 뒤의 > 는 둔다 — 백슬래시가 짝수 개", () => {
    expect(unescapeAngleBrackets("a \\\\> b")).toBe("a \\\\> b");
    expect(unescapeAngleBrackets("a \\\\\\> b")).toBe("a \\\\> b");
  });

  it("pull 변환 전체에서도 풀린다 — 표 칸 포함", () => {
    const nfm = [
      "**a -\\> b**",
      '<table header-row="true">',
      "<tr>",
      "<td>c -\\> d</td>",
      "<td>e</td>",
      "</tr>",
      "</table>",
    ].join("\n");
    const md = notionEnhancedToObsidian(nfm);
    expect(md).toContain("**a -> b**");
    expect(md).toContain("| c -> d | e |");
  });
});
