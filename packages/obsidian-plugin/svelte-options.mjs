/**
 * Svelte 컴파일 옵션 — 빌드(`esbuild.config.mjs`)가 쓴다.
 *
 * 컴포넌트 CSS 는 문서에 `<style id="svelte-해시">` 로 주입되고, Svelte 는 같은 id 가 이미 있으면 다시 넣지 않는다.
 * Svelte 5 의 기본 해시는 파일 이름으로 만들어 CSS 를 고쳐도 그대로다. 그래서 플러그인을 업데이트하거나 다시
 * 불러와도 Obsidian 을 다시 켜기 전까지 옛 CSS 가 남았다(변경 패널의 오류 띠 색 수정이 보이지 않았다).
 *
 * 해시를 컴포넌트 이름과 CSS 내용으로 만든다 — 고친 CSS 는 새 id 로 들어가고, 남은 옛 `<style>` 은 옛 해시의
 * 요소만 가리키므로 해가 없다. 파일 경로를 쓰지 않으므로 어느 폴더에서 빌드해도 같은 해시다.
 *
 * @type {import("svelte/compiler").CompileOptions}
 */
export const svelteCompilerOptions = {
  css: "injected",
  cssHash: ({ name, css, hash }) => `svelte-${hash(name + css)}`,
};
