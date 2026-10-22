/**
 * Svelte 컴파일 옵션 — 컴포넌트 CSS 는 문서에 `<style id="svelte-해시">` 로 들어가고, Svelte 는 같은 id 가 이미
 * 있으면 다시 넣지 않는다. 해시가 CSS 를 고쳐도 그대로면, 플러그인을 업데이트하거나 다시 불러와도 Obsidian 을 다시
 * 켜기 전까지 옛 CSS 가 남는다(실측: 변경 패널의 오류 띠 색 수정이 보이지 않았다).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { compile } from "svelte/compiler";
import { svelteCompilerOptions } from "../svelte-options.mjs";

const component = (color: string): string =>
  `<div class="box">x</div>\n<style>.box { color: ${color}; }</style>`;

/** 컴파일된 컴포넌트가 주입할 `<style>` 의 id. */
function styleId(source: string, filename = "/repo/src/views/Box.svelte"): string {
  const { js } = compile(source, { ...svelteCompilerOptions, filename });
  const id = /\$\$css = \{\s*hash: '(svelte-[a-z0-9]+)'/.exec(js.code)?.[1];
  if (!id) throw new Error("주입 CSS 가 없다 — css 가 injected 인지 본다");
  return id;
}

describe("Svelte 컴파일 옵션", () => {
  it("CSS 를 고치면 해시가 바뀐다 — 다시 불러온 플러그인이 새 CSS 를 넣는다", () => {
    expect(styleId(component("red"))).not.toBe(styleId(component("blue")));
  });

  it("같은 CSS 는 어느 폴더에서 빌드해도 같은 해시다", () => {
    expect(styleId(component("red"), "/home/a/repo/src/views/Box.svelte")).toBe(
      styleId(component("red"), "/runner/work/repo/src/views/Box.svelte"),
    );
  });

  it("빌드가 이 옵션을 쓴다", () => {
    const build = readFileSync(new URL("../esbuild.config.mjs", import.meta.url), "utf-8");

    expect(build).toMatch(/import \{ svelteCompilerOptions \} from "\.\/svelte-options\.mjs"/);
    expect(build).toMatch(/sveltePlugin\(\{\s*compilerOptions: svelteCompilerOptions,?\s*\}\)/);
  });
});
