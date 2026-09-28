/**
 * 플러그인 CSS — 화면 시험(happy-dom)은 테마 색을 계산하지 않아, 글이 바탕과 같은 색이 되어 보이지 않아도
 * 모른다. 실제 Obsidian 1.13 어두운 테마에서 줄 비교의 바뀐 줄이 그렇게 보이지 않았다. 글로 된 규칙을 본다.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

const read = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), "utf-8");

/** 플러그인이 싣는 CSS 전부 — 전역 `main.css` 와 컴포넌트마다의 `<style>`. */
function stylesheets(): { file: string; css: string }[] {
  const components = (
    readdirSync(new URL("../src", import.meta.url), { recursive: true }) as string[]
  )
    .filter((file) => file.endsWith(".svelte"))
    .sort()
    .map((file) => ({
      file: `src/${file}`,
      css: [...read(`../src/${file}`).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
        .map(([, css]) => css)
        .join("\n"),
    }));
  return [{ file: "src/styles/main.css", css: read("../src/styles/main.css") }, ...components];
}

/** `선택자 { 선언… }` 묶음 — 이 플러그인의 CSS 는 중첩이 없다(`@keyframes` 안의 `from` · `to` 도 규칙으로 잡혀 해가 없다). 주석은 뺀다. */
function rules(css: string): { selector: string; body: string }[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    ([, selector, body]) => ({ selector: selector!.trim(), body: body! }),
  );
}

/** 누르거나 올려 둔 상태 — 같은 요소가 이 상태일 때 바탕과 평소의 글색이 함께 보인다. */
const STATE = /:(hover|focus|focus-visible|focus-within|active|not\([^)]*\))/g;

/** `a, b` 를 나누고 상태를 벗긴다 — `.btn:hover:not(:disabled)` 는 `.btn` 이다. */
function elements(selector: string): string[] {
  return selector.split(",").map((part) => part.replace(STATE, "").trim());
}

/** 테마가 같은 색으로 둘 수 있는 바탕 · 글 변수 — 1.13 기본 테마에서 어둡든 밝든 쌍마다 같은 색이다(실측). */
const SAME_COLOR_PAIRS = [
  ["--background-modifier-error", "--text-error"],
  ["--background-modifier-success", "--text-success"],
  ["--background-modifier-warning", "--text-warning"],
] as const;

const setsBackground = (body: string, variable: string): boolean =>
  new RegExp(`background(-color)?\\s*:\\s*var\\(${variable}\\)`).test(body);
const setsColor = (body: string, variable: string): boolean =>
  new RegExp(`(^|[;\\s])color\\s*:\\s*var\\(${variable}\\)`).test(body);

/** 한 요소가 — 한 규칙에서든, 평소 규칙과 상태 규칙에 나눠서든 — 글을 그 바탕과 같은 색일 수 있는 변수로 칠한다. */
function clashes(css: string): string[] {
  const byElement = new Map<string, string[]>();
  for (const { selector, body } of rules(css)) {
    for (const element of elements(selector)) {
      byElement.set(element, [...(byElement.get(element) ?? []), body]);
    }
  }
  return [...byElement]
    .filter(([, bodies]) =>
      SAME_COLOR_PAIRS.some(
        ([background, text]) =>
          bodies.some((body) => setsBackground(body, background)) &&
          bodies.some((body) => setsColor(body, text)),
      ),
    )
    .map(([element]) => element);
}

describe("플러그인 CSS", () => {
  it("빌드가 옮겨 싣는 styles.css 는 src/styles/main.css 와 같다", () => {
    expect(read("../styles.css")).toBe(read("../src/styles/main.css"));
  });

  it("컴포넌트의 <style> 도 본다 — 변경 패널이 있다", () => {
    expect(stylesheets().map(({ file }) => file)).toContain("src/views/SyncDashboard.svelte");
  });

  it("어떤 요소도 글을 그 바탕과 같은 색일 수 있는 변수로 칠하지 않는다 — 올려 둔 상태까지", () => {
    const found = stylesheets().flatMap(({ file, css }) =>
      clashes(css).map((element) => `${file} ${element}`),
    );

    expect(found).toEqual([]);
  });

  it("평소 규칙의 글색과 올려 둔 상태의 바탕이 겹치는 것도 잡는다", () => {
    expect(
      clashes(`
        .btn { color: var(--text-error); }
        .btn:hover:not(:disabled) { background: var(--background-modifier-error); }
        .other { color: var(--text-error); }
        .banner, .note { background-color: var(--background-modifier-warning); color: var(--text-warning); }
        .tinted { background: rgba(var(--color-red-rgb), 0.15); color: var(--text-error); }
      `),
    ).toEqual([".btn", ".banner", ".note"]);
  });
});
