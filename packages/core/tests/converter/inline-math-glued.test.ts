/**
 * 글자에 붙은 인라인 수식 — Obsidian 은 수식으로 그리는데 Notion 은 글로 읽던 것.
 *
 * Notion 은 여는 `$` 앞이 글자 · 숫자이거나 닫는 `$` 뒤가 글자면 수식으로 읽지 않는다(2026-10-23 탐침:
 * `w$^9$가` → 글 `$^9$`). Obsidian 은 여는 `$` 뒤 · 닫는 `$` 앞이 공백이 아니고 닫는 `$` 뒤가 숫자가 아니면
 * 수식이다. 그런 수식은 Notion 이 내보내는 모양 `` $`식`$ `` 로 보낸다 — 탐침에서 `` w$`^9`$가 `` 는 수식이 됐다.
 */
import { describe, it, expect } from "vitest";
import { MathNormalizer } from "../../src/converter/pre-processors/math.js";
import { notionEnhancedToObsidian } from "../../src/converter/enhanced-md-converter.js";
import type { ConversionContext } from "../../src/types/convert.js";

const context: ConversionContext = { direction: "push", path: "markdown-api", filePath: "n.md" };
const push = (content: string) =>
  new MathNormalizer().process({ content, metadata: {}, context }).content;

describe("글자에 붙은 인라인 수식 — Notion 이 읽는 모양으로 보낸다", () => {
  it.each([
    ["w$^9$가 끝", "w$`^9`$가 끝"],
    ["값은 5$x$ 이다", "값은 5$`x`$ 이다"],
    ["앞 $x^2$뒤", "앞 $`x^2`$뒤"],
    ["- 목록 a$b$c 와 $d$", "- 목록 a$`b`$c 와 $d$"],
  ])("%s", (note, sent) => {
    expect(push(note)).toBe(sent);
  });

  it.each([
    ["Notion 도 읽는 수식은 그대로", "앞 $x^2$ 뒤"],
    ["Obsidian 도 글로 읽는 `$` 는 그대로", "가격 $5 와 $10"],
    ["이스케이프한 `$` 는 글", "a\\$b$ 끝"],
    ["닫는 `$` 뒤가 숫자면 글", "a$b$1"],
    ["인라인 코드 안은 코드", "코드 `a$b$c` 끝"],
    ["이미 Notion 모양인 수식", "w$`^9`$가"],
    ["블록 수식", "$$\nx$y$z\n$$"],
  ])("%s", (_name, note) => {
    expect(push(note)).toBe(note);
  });

  it("받으면 볼트의 원래 모양으로 돌아온다", () => {
    expect(notionEnhancedToObsidian(push("w$^9$가 끝"))).toBe("w$^9$가 끝");
  });
});
