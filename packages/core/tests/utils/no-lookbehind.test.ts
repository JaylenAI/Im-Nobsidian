/**
 * P11 — 소스에 정규식 lookbehind(`(?<=` · `(?<!`)를 다시 쓰지 않는다. 옛 iOS 에서 플러그인이 뜨지 않는다 —
 * 대신 {@link LookbehindRegExp}(`src/utils/lookbehind.ts`). 주석 속 설명은 보지 않는다 — 코드 줄만.
 * 플러그인 쪽은 빌드한 main.js 를 `obsidian-plugin/tests/distribution.test.ts` 가 본다.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE_ROOTS = ["../../src", "../../../obsidian-plugin/src"].map(
  (relative) => new URL(relative, import.meta.url).pathname,
);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|svelte)$/.test(entry.name) ? [path] : [];
  });
}

/** 주석 줄(`//` · `*` 로 시작)과 줄 끝 `//` 주석을 뺀 코드 줄. */
function codeLines(text: string): { line: number; code: string }[] {
  return text.split("\n").flatMap((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return [];
    return [{ line: index + 1, code: raw.replace(/\s\/\/\s.*$/, "") }];
  });
}

describe("정규식 lookbehind 없음", () => {
  it("core · 플러그인 소스의 코드 줄에 (?<= · (?<! 가 없다", () => {
    const found = SOURCE_ROOTS.flatMap(sourceFiles).flatMap((file) =>
      codeLines(readFileSync(file, "utf-8"))
        .filter(({ code }) => /\(\?<[=!]/.test(code))
        .map(({ line }) => `${file}:${line}`),
    );
    expect(found).toEqual([]);
  });
});
