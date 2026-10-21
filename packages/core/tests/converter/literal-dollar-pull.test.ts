/**
 * C13 — Notion 의 글 `$` 를 볼트에 쓸 모양.
 *
 * markdown API 는 인라인 수식을 `` $`식`$ `` 로, 글의 `$` 는 `\$` 로 준다(실측 2026-10-21). 예전 pull 은 `\$…\$` 를
 * 이스케이프된 수식으로 보고 `$…$` 로 풀어, Notion 의 글 `$a$` 가 Obsidian 에서 수식이 되고 그 노트를 push 하면
 * Notion 에서도 수식이 됐다. 코드 블록 안의 `\$x\$` 도 바뀌었다.
 *
 * Obsidian 1.13.7 실측(읽기 보기): `$a$` · `a$b$c` · `x $a$b` 는 수식, `$a$1` · `$ x $` · `$5 와 $10` 은 글,
 * `\$a\$` 는 글 `$a$`.
 */
import { describe, it, expect } from "vitest";
import { notionEnhancedToObsidian } from "../../src/converter/enhanced-md-converter.js";
import { unescapeSafeLiteralDollars } from "../../src/converter/literal-dollar.js";

describe("unescapeSafeLiteralDollars — 수식 짝이 생길 수 없는 줄만 푼다", () => {
  it.each([
    ["\\$a\\$", "\\$a\\$"],
    ["a\\$b\\$c", "a\\$b\\$c"],
    ["x \\$a\\$b", "x \\$a\\$b"],
    ["\\$\\$a\\$\\$", "\\$\\$a\\$\\$"],
    ["글 \\$x+1\\$ 그리고 $y$", "글 \\$x+1\\$ 그리고 $y$"],
    ["\\$5 $y$", "\\$5 $y$"],
    ["$y$\\$5", "$y$\\$5"],
  ])("수식이 될 수 있으면 둔다: %s", (line, expected) => {
    expect(unescapeSafeLiteralDollars(line)).toBe(expected);
  });

  it.each([
    ["가격은 \\$5 와 \\$10 이다", "가격은 $5 와 $10 이다"],
    ["공백 \\$ x \\$ 달러", "공백 $ x $ 달러"],
    ["\\$a\\$1", "$a$1"],
    ["가격 \\$5", "가격 $5"],
    ["$y$ 그리고 \\$5", "$y$ 그리고 $5"],
    ["끝에 \\\\\\$ 하나", "끝에 \\\\$ 하나"],
  ])("수식이 될 수 없으면 푼다: %s", (line, expected) => {
    expect(unescapeSafeLiteralDollars(line)).toBe(expected);
  });

  it("줄마다 따로 정한다", () => {
    expect(unescapeSafeLiteralDollars("\\$a\\$\n가격 \\$5")).toBe("\\$a\\$\n가격 $5");
  });

  it("인라인 코드 · 코드 펜스 안은 건드리지 않는다", () => {
    expect(unescapeSafeLiteralDollars("`\\$x` 가격 \\$5")).toBe("`\\$x` 가격 $5");
    expect(unescapeSafeLiteralDollars("```\n가격 \\$5\n```")).toBe("```\n가격 \\$5\n```");
  });
});

describe("pull 변환 — Notion 의 글 달러는 글로 남는다(C13)", () => {
  it.each([
    ["\\$a\\$", "\\$a\\$"],
    ["글 \\$x+1\\$ 그리고 $`y`$", "글 \\$x+1\\$ 그리고 $y$"],
    ["\\$\\$a\\^2\\$\\$", "\\$\\$a^2\\$\\$"],
    ["가격은 \\$5 와 \\$10 이다", "가격은 $5 와 $10 이다"],
    ["$`a`$ 와 $`b`$", "$a$ 와 $b$"],
  ])("%s", (nfm, expected) => {
    expect(notionEnhancedToObsidian(nfm)).toBe(expected);
  });

  it("코드 블록 안의 `\\$` 는 글자 그대로다", () => {
    expect(notionEnhancedToObsidian("```bash\necho \\$HOME\\$\n```")).toBe(
      "```bash\necho \\$HOME\\$\n```",
    );
  });
});
