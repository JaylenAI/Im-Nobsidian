/**
 * 플러그인 전용 상수 단일 진실원(SSOT).
 *
 * 공유 내부 경로(`.im-nobsidian` 등)는 `@im-nobsidian/core`의 paths 상수를 사용하고,
 * 이 파일에는 Obsidian 플러그인 런타임에만 의미 있는 값(번들 파일명·뷰 타입)만 둔다.
 * 플러그인 폴더명은 하드코딩하지 않고 `this.manifest.id`로 동적 해석한다.
 */

/** esbuild가 번들에 복사하는 sql.js WASM 파일명. */
export const WASM_FILE = "sql-wasm.wasm";
