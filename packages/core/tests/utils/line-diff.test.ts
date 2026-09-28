/**
 * 줄 비교 — 변경 패널 · 충돌 창 · CLI 가 같은 비교를 보인다.
 */
import { describe, it, expect } from "vitest";
import { formatHunkHeader, formatUnifiedDiff, lineDiff } from "../../src/utils/line-diff.js";
import type { DiffHunk } from "../../src/utils/line-diff.js";

/** 묶음의 줄을 `+a` · `-b` · ` c` 로 — 번호 없이 무엇이 바뀌었는지만. */
const signs = (hunks: readonly DiffHunk[]) =>
  hunks.map((hunk) =>
    hunk.lines.map((line) => `${{ same: " ", added: "+", removed: "-" }[line.kind]}${line.text}`),
  );

const numbered = (count: number, mark: (index: number) => string | null = () => null) =>
  Array.from({ length: count }, (_, index) => mark(index) ?? `줄${index + 1}`).join("\n") + "\n";

describe("lineDiff", () => {
  it("같은 글이면 묶음이 없다", () => {
    expect(lineDiff("가\n나\n", "가\n나\n")).toEqual([]);
    expect(lineDiff("", "")).toEqual([]);
  });

  it("앞에 한 줄을 더하면 그 줄만 더한 줄이다 — 뒤의 줄은 같은 줄로 맞춘다", () => {
    expect(signs(lineDiff("나\n다\n라\n", "가\n나\n다\n라\n"))).toEqual([
      ["+가", " 나", " 다", " 라"],
    ]);
  });

  it("줄마다 옛 번호 · 새 번호를 싣는다 — 더한 줄은 옛 번호가, 지운 줄은 새 번호가 없다", () => {
    const [hunk] = lineDiff("가\n나\n다\n", "가\n다\n라\n");

    expect(hunk!.lines).toEqual([
      { kind: "same", text: "가", oldNumber: 1, newNumber: 1 },
      { kind: "removed", text: "나", oldNumber: 2, newNumber: null },
      { kind: "same", text: "다", oldNumber: 3, newNumber: 2 },
      { kind: "added", text: "라", oldNumber: null, newNumber: 3 },
    ]);
    expect(hunk).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 });
  });

  it("멀리 떨어진 두 변경은 앞뒤 세 줄씩만 붙여 두 묶음으로 낸다", () => {
    const before = numbered(20);
    const after = numbered(20, (i) => (i === 2 ? "고친3" : i === 17 ? "고친18" : null));

    const hunks = lineDiff(before, after);

    expect(signs(hunks)).toEqual([
      [" 줄1", " 줄2", "-줄3", "+고친3", " 줄4", " 줄5", " 줄6"],
      [" 줄15", " 줄16", " 줄17", "-줄18", "+고친18", " 줄19", " 줄20"],
    ]);
    expect(hunks[1]).toMatchObject({ oldStart: 15, oldLines: 6, newStart: 15, newLines: 6 });
  });

  it("앞뒤로 붙일 줄 수를 고를 수 있다", () => {
    const after = numbered(10, (i) => (i === 4 ? "고친5" : null));
    expect(signs(lineDiff(numbered(10), after, { context: 0 }))).toEqual([["-줄5", "+고친5"]]);
  });

  it("새 글은 모든 줄이 더한 줄 · 지운 글은 모든 줄이 지운 줄이다", () => {
    expect(signs(lineDiff("", "가\n나\n"))).toEqual([["+가", "+나"]]);
    expect(signs(lineDiff("가\n나\n", ""))).toEqual([["-가", "-나"]]);
  });

  it("끝 줄바꿈만 다른 줄은 바뀐 줄에 표시한다 — 같은 줄로 지우고 다시 쓴 것처럼 보이지 않게", () => {
    const [hunk] = lineDiff("가\n나", "가\n나\n");

    expect(hunk!.lines).toEqual([
      { kind: "same", text: "가", oldNumber: 1, newNumber: 1 },
      { kind: "removed", text: "나", oldNumber: 2, newNumber: null, noNewlineAtEnd: true },
      { kind: "added", text: "나", oldNumber: null, newNumber: 2 },
    ]);
  });

  it("양쪽 다 끝 줄바꿈이 없는 같은 줄은 표시하지 않는다 — 차이가 아니다", () => {
    const [hunk] = lineDiff("가\n나\n다", "가\n고침\n다");

    expect(hunk!.lines.at(-1)).toEqual({ kind: "same", text: "다", oldNumber: 3, newNumber: 3 });
  });

  it("너무 많이 바뀐 두 글은 맞춰 보지 않고 옛 글을 모두 지우고 새 글을 모두 더한 것으로 낸다", () => {
    const before = numbered(2100, (i) => `옛${i + 1}`);
    const after = numbered(2100, (i) => `새${i + 1}`).slice(0, -1);

    const hunks = lineDiff(before, after);

    expect(hunks).toHaveLength(1);
    const [hunk] = hunks;
    expect(hunk).toMatchObject({ oldStart: 1, oldLines: 2100, newStart: 1, newLines: 2100 });
    expect(hunk!.lines[0]).toEqual({ kind: "removed", text: "옛1", oldNumber: 1, newNumber: null });
    expect(hunk!.lines[2099]).toEqual({
      kind: "removed",
      text: "옛2100",
      oldNumber: 2100,
      newNumber: null,
    });
    expect(hunk!.lines[2100]).toEqual({
      kind: "added",
      text: "새1",
      oldNumber: null,
      newNumber: 1,
    });
    expect(hunk!.lines.at(-1)).toEqual({
      kind: "added",
      text: "새2100",
      oldNumber: null,
      newNumber: 2100,
      noNewlineAtEnd: true,
    });
  });

  it("맞춰 보기를 그만둔 두 글도 끝 줄바꿈이 없는 쪽의 마지막 줄에 표시한다", () => {
    const before = numbered(2100, (i) => `옛${i + 1}`).slice(0, -1);
    const after = numbered(2100, (i) => `새${i + 1}`);

    const [hunk] = lineDiff(before, after);

    expect(hunk!.lines[2099]).toEqual({
      kind: "removed",
      text: "옛2100",
      oldNumber: 2100,
      newNumber: null,
      noNewlineAtEnd: true,
    });
    expect(hunk!.lines.at(-1)).toEqual({
      kind: "added",
      text: "새2100",
      oldNumber: null,
      newNumber: 2100,
    });
  });

  it("맞춰 보기를 그만둔 두 글의 한쪽이 빈 글이면 그쪽은 줄이 없다 — 빈 줄 하나로 세지 않는다", () => {
    const hunks = lineDiff(
      numbered(2100, (i) => `옛${i + 1}`),
      "",
    );

    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ oldLines: 2100, newLines: 0 });
    expect(hunks[0]!.lines.every((line) => line.kind === "removed")).toBe(true);
  });
});

describe("formatUnifiedDiff", () => {
  it("Git 의 통합 diff 와 같은 글 — 이름 두 줄 · 묶음 머리 · 부호 붙은 줄 · 끝 줄바꿈 없음 표시", () => {
    expect(formatUnifiedDiff(lineDiff("가\n나\n", "가\n너"), "a/노트.md", "b/노트.md")).toEqual([
      "--- a/노트.md",
      "+++ b/노트.md",
      "@@ -1,2 +1,2 @@",
      " 가",
      "-나",
      "+너",
      "\\ No newline at end of file",
    ]);
  });

  it("같은 글이면 이름 두 줄뿐이다", () => {
    expect(formatUnifiedDiff(lineDiff("가\n", "가\n"), "a/x.md", "b/x.md")).toEqual([
      "--- a/x.md",
      "+++ b/x.md",
    ]);
  });

  it("줄 글이 부호처럼 시작해도 그대로 적는다 — 구분선을 지우면 `----`", () => {
    expect(formatUnifiedDiff(lineDiff("---\n본문\n", "본문\n"), "a", "b").slice(2)).toEqual([
      "@@ -1,2 +1,1 @@",
      "----",
      " 본문",
    ]);
  });
});

describe("formatHunkHeader", () => {
  it("Git 과 같은 모양 — 한쪽 줄이 없는 묶음은 그 앞 줄 번호를 적는다", () => {
    expect(formatHunkHeader(lineDiff("가\n나\n다\n", "가\n고침\n다\n")[0]!)).toBe(
      "@@ -1,3 +1,3 @@",
    );
    expect(formatHunkHeader(lineDiff("", "가\n")[0]!)).toBe("@@ -0,0 +1,1 @@");
    expect(formatHunkHeader(lineDiff("가\n", "")[0]!)).toBe("@@ -1,1 +0,0 @@");
  });
});
