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
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";
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

/**
 * Notion 의 빈 인라인 수식(`` $``$ ``) — 옛 push 가 글의 `$$` 를 이렇게 올렸다(2026-10-21 실측). 받으면 글 `\$\$` 다.
 * push 는 짝 없는 `$$` 를 `\$\$` 로 보내므로, 로컬의 `$$` 와 받은 글이 Notion 에서 같은 꼴이다.
 */
describe("빈 인라인 수식은 글 $$ 로 받는다", () => {
  it.each([
    ["문단", "a $``$ b", "a \\$\\$ b"],
    ["글을 사이에 둔 둘", "a $``$ x\\^2 $``$ b", "a \\$\\$ x^2 \\$\\$ b"],
    ["목록", "- $``$ 글", "- \\$\\$ 글"],
  ])("%s", (_name, nfm, expected) => {
    expect(notionEnhancedToObsidian(nfm)).toBe(expected);
  });

  it("코드 펜스 안은 코드의 글이다", () => {
    const nfm = "```\n$``$\n```";
    expect(notionEnhancedToObsidian(nfm)).toBe(nfm);
  });

  it("받은 글과 로컬의 짝 없는 $$ 는 push 하면 같다", () => {
    const pipeline = createDefaultPipeline();
    const sent = (note: string) =>
      obsidianToNotionEnhanced(
        pipeline.convertToNotion(note, {
          direction: "push",
          path: "markdown-api",
          filePath: "t.md",
        }).content,
      );
    expect(sent(notionEnhancedToObsidian("가 $``$ 나"))).toBe(sent("가 $$ 나"));
  });
});
