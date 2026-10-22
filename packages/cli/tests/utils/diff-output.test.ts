/**
 * 통합 diff 출력 — `diff` · `resolve` 가 같은 색으로 보인다. 이름 줄은 자리로 가른다.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { printUnifiedDiff } from "../../src/utils/diff-output.js";

const LINES = [
  "--- a/노트.md",
  "+++ b/노트.md",
  "@@ -1,3 +1,2 @@",
  " 같음",
  "----",
  "+새 줄",
  "\\ No newline at end of file",
];

function printed(color: boolean): unknown[] {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  printUnifiedDiff(LINES, color);
  return log.mock.calls.map(([line]) => line);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("printUnifiedDiff", () => {
  it("이름 두 줄은 굵게, 묶음 머리는 청록, 지운 줄은 빨강, 더한 줄은 초록 — 나머지는 그대로", () => {
    expect(printed(true)).toEqual([
      "\x1b[1m--- a/노트.md\x1b[0m",
      "\x1b[1m+++ b/노트.md\x1b[0m",
      "\x1b[36m@@ -1,3 +1,2 @@\x1b[0m",
      " 같음",
      "\x1b[31m----\x1b[0m",
      "\x1b[32m+새 줄\x1b[0m",
      "\\ No newline at end of file",
    ]);
  });

  it("색을 끄면 줄을 그대로 찍는다", () => {
    expect(printed(false)).toEqual(LINES);
  });
});
