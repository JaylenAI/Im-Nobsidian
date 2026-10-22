import { DIFF_SIGN } from "@im-nobsidian/core";

const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

/** 줄 첫 글자마다의 색 — 더한 줄 · 지운 줄의 부호는 core 의 것을 따른다. `@` 는 묶음 머리. */
const LINE_COLOR: Readonly<Record<string, string>> = {
  [DIFF_SIGN.added]: GREEN,
  [DIFF_SIGN.removed]: RED,
  "@": CYAN,
};

/**
 * 통합 diff 줄(core `formatUnifiedDiff`)을 찍는다 — `diff` · `resolve` 가 같은 모양 · 같은 색으로 보인다.
 *
 * 옛 글 · 새 글 이름 줄은 첫 글자가 아니라 자리(앞 두 줄)로 가른다 — 구분선(`---`)을 지운 줄은 `----` 로
 * 시작해 첫 글자로는 이름 줄과 구별되지 않는다.
 */
export function printUnifiedDiff(lines: readonly string[], color: boolean): void {
  lines.forEach((line, index) => {
    const code = index < 2 ? BOLD : LINE_COLOR[line.charAt(0)];
    console.log(color && code ? `${code}${line}${RESET}` : line);
  });
}
