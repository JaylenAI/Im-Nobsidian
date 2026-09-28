/**
 * 플러그인 CSS — 화면 시험(happy-dom)은 테마 색을 계산하지 않아, 글이 바탕과 같은 색이 되어 보이지 않아도
 * 모른다. 실제 Obsidian 1.13 어두운 테마에서 줄 비교의 바뀐 줄이 그렇게 보이지 않았다. 글로 된 규칙을 본다.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), "utf-8");

/** `선택자 { 선언… }` 묶음 — 이 파일의 CSS 는 중첩이 없다. 주석은 뺀다. */
function rules(css: string): { selector: string; body: string }[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    ([, selector, body]) => ({ selector: selector!.trim(), body: body! }),
  );
}

/** 테마가 같은 색으로 둘 수 있는 바탕 · 글 변수 — 1.13 어두운 테마에서 둘 다 #fb464c · #44cf6e 다. */
const SAME_COLOR_PAIRS = [
  ["--background-modifier-error", "--text-error"],
  ["--background-modifier-success", "--text-success"],
] as const;

describe("플러그인 CSS", () => {
  it("빌드가 옮겨 싣는 styles.css 는 src/styles/main.css 와 같다", () => {
    expect(read("../styles.css")).toBe(read("../src/styles/main.css"));
  });

  it("어떤 규칙도 글을 그 바탕과 같은 색일 수 있는 변수로 칠하지 않는다", () => {
    const clashes = rules(read("../src/styles/main.css")).filter(({ body }) =>
      SAME_COLOR_PAIRS.some(
        ([background, text]) =>
          new RegExp(`background(-color)?\\s*:\\s*var\\(${background}\\)`).test(body) &&
          new RegExp(`(^|[;\\s])color\\s*:\\s*var\\(${text}\\)`).test(body),
      ),
    );

    expect(clashes.map((rule) => rule.selector)).toEqual([]);
  });
});
