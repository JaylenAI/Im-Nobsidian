import { mapOutsideCodeFences } from "../utils/md-regions.js";

/**
 * 인라인 `$` 수식을 Notion 처럼 가른다 — 블록 방식 push 의 NFM 글 변환(`nfm-inline`)과 pull 이 같은 규칙을 쓴다.
 *
 * Notion 의 규칙(2026-10-12 실측, 줄마다):
 *
 * - 여는 `$` 는 앞이 글자 · 숫자가 아니고, 뒤가 공백이 아니어야 한다.
 * - 닫는 `$` 는 여는 `$` 다음의 첫 `$` 다 — 수식 안에서 `\` 는 escape 가 아니다(`$a\$ b` 는 수식 `a\`).
 *   앞이 공백이 아니고 뒤가 글자 · 숫자 · `$` 가 아니어야 한다.
 * - 닫는 `$` 가 맞지 않으면 여는 `$` 는 글이다. 그 닫는 `$` 부터 다시 본다 — `$a $b$` 는 `$a ` 가 글,
 *   `$b$` 가 수식이다.
 */

const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const SPACE_RE = /\s/;

/**
 * `open` 의 `$` 가 여는 인라인 수식의 닫는 `$` 자리. 수식이 아니면 null — 블록 방식 push 의 NFM 글 변환
 * (`nfm-inline`)도 같은 규칙으로 수식을 가른다.
 */
export function mathCloseAt(line: string, open: number): number | null {
  const before = line[open - 1];
  const after = line[open + 1];
  if (before !== undefined && WORD_CHAR_RE.test(before)) return null;
  if (after === undefined || SPACE_RE.test(after)) return null;

  // 수식 안의 `\$` 도 닫는 `$` 다 — martian(remark-math)도 Notion 도 그렇게 읽는다(실측).
  const close = line.indexOf("$", open + 1);
  if (close === -1) return null;

  const inner = line[close - 1]!;
  const next = line[close + 1];
  if (SPACE_RE.test(inner)) return null;
  if (next !== undefined && (next === "$" || WORD_CHAR_RE.test(next))) return null;
  return close;
}

/**
 * pull 쪽 — Notion 의 글 `$`(markdown API 의 `\$`)를 볼트에 쓸 모양. 줄마다 정한다.
 *
 * Obsidian 은 Notion 보다 넓게 수식으로 읽는다(1.13.7 실측): 여는 `$` 는 뒤가 공백이 아니면 되고(`a$b$c` 도 수식),
 * 닫는 `$` 는 앞이 공백이 아니고 뒤가 숫자가 아니면 된다. `\$` 는 글 `$` 다. 그래서 글 `$` 를 맨 `$` 로 풀었을 때
 * 그 줄에서 글 `$` 가 낀 수식 짝이 하나라도 생길 수 있으면 그 줄의 글 `$` 는 모두 `\$` 로 둔다. 짝이 생길 수 없는
 * 줄(`가격 $5 와 $10` · `$ x $`)만 푼다 — 사람이 쓴 모양 그대로다. Notion 의 짝 규칙은 Obsidian 의 것보다 좁아
 * 같은 판정이 push 쪽도 지킨다.
 *
 * 코드 펜스 줄과 인라인 코드 안은 건드리지 않는다 — 그 안의 `\$` 는 글자 그대로다.
 */
export function unescapeSafeLiteralDollars(markdown: string): string {
  return mapOutsideCodeFences(markdown, (segment) =>
    segment
      .split("\n")
      .map((line) => (line.includes("\\$") ? unescapeLineIfSafe(line) : line))
      .join("\n"),
  );
}

/** 줄 안의 `$` 하나 — 글(`\$`)인지 수식 기호인지와, 글 `$` 를 모두 푼 줄에서의 자리. */
interface DollarMark {
  readonly at: number;
  readonly literal: boolean;
}

function unescapeLineIfSafe(line: string): string {
  let bare = "";
  const marks: DollarMark[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === "\\" && line[i + 1] === "$") {
      marks.push({ at: bare.length, literal: true });
      bare += "$";
      i += 2;
    } else if (ch === "\\") {
      bare += line.slice(i, i + 2);
      i += 2;
    } else if (ch === "`") {
      // 인라인 코드 — 같은 길이의 백틱 줄로 닫힌다. 닫히지 않으면 백틱은 글자다.
      let run = i;
      while (line[run] === "`") run += 1;
      const fence = line.slice(i, run);
      const close = line.indexOf(fence, run);
      const end = close === -1 ? run : close + fence.length;
      bare += line.slice(i, end);
      i = end;
    } else {
      if (ch === "$") marks.push({ at: bare.length, literal: false });
      bare += ch;
      i += 1;
    }
  }
  return pairsWithLiteral(bare, marks) ? line : bare;
}

/** 글 `$` 가 낀 Obsidian 수식 짝이 생길 수 있는가 — 붙은 `$$` 도 수식이 될 수 있어 짝으로 본다. */
function pairsWithLiteral(bare: string, marks: readonly DollarMark[]): boolean {
  const opens = (at: number) => bare[at + 1] !== undefined && !SPACE_RE.test(bare[at + 1]!);
  const closes = (at: number) =>
    !SPACE_RE.test(bare[at - 1] ?? " ") && !/\d/.test(bare[at + 1] ?? "");
  for (const [k, open] of marks.entries()) {
    for (const close of marks.slice(k + 1)) {
      if (!open.literal && !close.literal) continue;
      if (close.at === open.at + 1) return true;
      if (opens(open.at) && closes(close.at)) return true;
    }
  }
  return false;
}
