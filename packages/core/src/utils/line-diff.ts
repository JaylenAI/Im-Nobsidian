import { structuredPatch } from "diff";
import type { StructuredPatchHunk } from "diff";

/** 줄 비교의 한 줄. 번호는 1부터 — 더한 줄은 옛 번호가, 지운 줄은 새 번호가 없다. */
export interface DiffLine {
  readonly kind: "same" | "added" | "removed";
  readonly text: string;
  readonly oldNumber: number | null;
  readonly newNumber: number | null;
  /**
   * 글 끝에 줄바꿈이 없는 줄. 바뀐 줄에만 붙인다 — 끝 줄바꿈만 다른 두 줄이 같은 줄을 지우고 다시 쓴 것처럼
   * 보이지 않게. 같은 줄에 붙은 것은 양쪽 다 없다는 뜻이라 차이가 아니다.
   */
  readonly noNewlineAtEnd?: true;
}

/** 바뀐 줄과 그 앞뒤의 같은 줄 묶음 — Git 의 `@@ -oldStart,oldLines +newStart,newLines @@`. */
export interface DiffHunk {
  /** 묶음의 첫 옛 줄 번호(1부터). 옛 줄이 없는 묶음(`oldLines` 0)도 1부터 센다. */
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly DiffLine[];
}

/** 줄 종류마다 앞에 붙이는 부호 — Git 의 통합 diff 와 같다. 줄 비교를 글로 보이는 곳은 모두 이것을 쓴다. */
export const DIFF_SIGN: Readonly<Record<DiffLine["kind"], string>> = {
  same: " ",
  added: "+",
  removed: "-",
};

export interface LineDiffOptions {
  /** 바뀐 줄 앞뒤로 함께 보일 같은 줄 수. 기본 3 — Git 과 같다. */
  readonly context?: number;
}

const DEFAULT_CONTEXT = 3;

/**
 * 이보다 많이 바뀐 두 글은 줄을 맞춰 보지 않고 통째로 바꾼 것으로 보인다. 맞춰 보는 시간은 바뀐 양에 비례해
 * 늘어, 전혀 다른 긴 두 글을 맞추는 동안 플러그인 화면이 멈춘다.
 */
const MAX_EDIT_LENGTH = 2000;

/**
 * 두 글의 줄 비교 — 바뀐 곳과 그 앞뒤 몇 줄을 묶음으로 낸다. 같은 글이면 빈 배열.
 *
 * 예전의 충돌 비교는 같은 번호의 줄끼리 견줬다 — 한쪽 앞에 한 줄만 더해도 그 뒤의 모든 줄이 바뀐 것으로
 * 보였다. 여기는 가장 긴 공통 줄을 맞춰 실제로 더하고 지운 줄만 가른다.
 */
export function lineDiff(before: string, after: string, options?: LineDiffOptions): DiffHunk[] {
  const patch = structuredPatch("", "", before, after, undefined, undefined, {
    context: options?.context ?? DEFAULT_CONTEXT,
    maxEditLength: MAX_EDIT_LENGTH,
  });
  if (!patch) return [replaceAll(before, after)];
  return patch.hunks.map(toHunk);
}

/** 끝 줄바꿈이 없는 줄 뒤에 적는 줄 — Git 과 같은 글이다. */
const NO_NEWLINE_MARK = "\\ No newline at end of file";

/**
 * 통합 diff 글의 줄(Git 의 `diff -u` 와 같은 모양) — 옛 글 · 새 글 이름 두 줄, 묶음마다 `@@` 머리와 부호를
 * 붙인 줄. 같은 글이면 이름 두 줄뿐이다. 끝 줄바꿈이 없다는 표시는 Git 과 달리 바뀐 줄 뒤에만 적는다
 * (`DiffLine.noNewlineAtEnd`). 글로 보이는 곳(CLI `diff` · `resolve`)이 모두 이것을 쓴다 — 저마다 만들면
 * 앞뒤 줄 수 · 큰 글 상한이 곳마다 달라진다.
 */
export function formatUnifiedDiff(
  hunks: readonly DiffHunk[],
  oldName: string,
  newName: string,
): string[] {
  const lines = [`--- ${oldName}`, `+++ ${newName}`];
  for (const hunk of hunks) {
    lines.push(formatHunkHeader(hunk));
    for (const line of hunk.lines) {
      lines.push(`${DIFF_SIGN[line.kind]}${line.text}`);
      if (line.noNewlineAtEnd) lines.push(NO_NEWLINE_MARK);
    }
  }
  return lines;
}

/** Git 모양의 묶음 머리. 옛 줄(또는 새 줄)이 없는 묶음은 Git 처럼 그 앞 줄 번호를 적는다. */
export function formatHunkHeader(hunk: DiffHunk): string {
  const oldStart = hunk.oldLines === 0 ? hunk.oldStart - 1 : hunk.oldStart;
  const newStart = hunk.newLines === 0 ? hunk.newStart - 1 : hunk.newStart;
  return `@@ -${oldStart},${hunk.oldLines} +${newStart},${hunk.newLines} @@`;
}

function toHunk(hunk: StructuredPatchHunk): DiffHunk {
  const lines: DiffLine[] = [];
  let oldNumber = hunk.oldStart;
  let newNumber = hunk.newStart;
  for (const raw of hunk.lines) {
    const text = raw.slice(1);
    switch (raw[0]) {
      case "+":
        lines.push({ kind: "added", text, oldNumber: null, newNumber: newNumber++ });
        break;
      case "-":
        lines.push({ kind: "removed", text, oldNumber: oldNumber++, newNumber: null });
        break;
      case "\\": {
        // 「\ No newline at end of file」 — 바로 앞 줄의 표시다.
        const last = lines.at(-1);
        if (last && last.kind !== "same")
          lines[lines.length - 1] = { ...last, noNewlineAtEnd: true };
        break;
      }
      default:
        lines.push({ kind: "same", text, oldNumber: oldNumber++, newNumber: newNumber++ });
    }
  }
  return {
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    lines,
  };
}

/** 옛 글을 모두 지우고 새 글을 모두 더한 한 묶음 — 맞춰 보기를 그만둔 두 글. */
function replaceAll(before: string, after: string): DiffHunk {
  const removed = splitLines(before).map((text, index, all): DiffLine => ({
    kind: "removed",
    text,
    oldNumber: index + 1,
    newNumber: null,
    ...(index === all.length - 1 && !before.endsWith("\n") ? { noNewlineAtEnd: true } : {}),
  }));
  const added = splitLines(after).map((text, index, all): DiffLine => ({
    kind: "added",
    text,
    oldNumber: null,
    newNumber: index + 1,
    ...(index === all.length - 1 && !after.endsWith("\n") ? { noNewlineAtEnd: true } : {}),
  }));
  return {
    oldStart: 1,
    oldLines: removed.length,
    newStart: 1,
    newLines: added.length,
    lines: [...removed, ...added],
  };
}

/** 줄로 나눈다 — 끝 줄바꿈 뒤의 빈 조각은 줄이 아니다. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}
