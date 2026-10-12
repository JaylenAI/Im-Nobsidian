/**
 * 수식이 아닌 `$` 를 `\$` 로 — 블록 방식 push(martian) 전용 (C9).
 *
 * martian(remark-math)은 짝이 맞는 `$` 를 모두 인라인 수식으로 읽는다 — `$5 와 $10` 이 수식 `5 와 ` 가
 * 되고 `$ x $` 도 수식이 된다(실측). Markdown API 로 보내면 Notion 이 스스로 가린다(ADR-023). 블록
 * 방식도 같은 곳만 수식이 되도록, Notion 이 수식으로 읽지 않는 `$` 를 미리 escape 한다.
 *
 * Notion 의 규칙(2026-10-12 실측, 줄마다):
 *
 * - 여는 `$` 는 앞이 글자 · 숫자가 아니고, 뒤가 공백이 아니어야 한다.
 * - 닫는 `$` 는 여는 `$` 다음의 첫 `$` 다 — 수식 안에서 `\` 는 escape 가 아니다(`$a\$ b` 는 수식 `a\`).
 *   앞이 공백이 아니고 뒤가 글자 · 숫자 · `$` 가 아니어야 한다.
 * - 닫는 `$` 가 맞지 않으면 여는 `$` 는 글이다. 그 닫는 `$` 부터 다시 본다 — `$a $b$` 는 `$a ` 가 글,
 *   `$b$` 가 수식이다.
 * - `$$` 는 건드리지 않는다(블록 수식 · 글 사이 `$$x$$`). 블록 수식의 식 줄도 건드리지 않는다.
 *
 * 코드 펜스 · 인라인 코드 안은 호출측이 뺀다(`mapOutsideCode`).
 */

/** 블록 수식을 여닫는 줄 — 인용 표시 · 들여쓰기 뒤 `$$` 하나. */
const BLOCK_MATH_FENCE_RE = /^(?:[ \t]*>)*[ \t]*\$\$[ \t]*$/;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const SPACE_RE = /\s/;

export function escapeLiteralDollars(markdown: string): string {
  let inBlockMath = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (BLOCK_MATH_FENCE_RE.test(line)) {
        inBlockMath = !inBlockMath;
        return line;
      }
      return inBlockMath ? line : escapeLine(line);
    })
    .join("\n");
}

function escapeLine(line: string): string {
  if (!line.includes("$")) return line;
  let out = "";
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === "\\") {
      out += line.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch !== "$") {
      out += ch;
      i += 1;
      continue;
    }
    if (line[i + 1] === "$") {
      // `$$` 이상 — 그대로 둔다.
      let end = i;
      while (line[end] === "$") end += 1;
      out += line.slice(i, end);
      i = end;
      continue;
    }
    const close = mathCloseAt(line, i);
    if (close === null) {
      out += "\\$";
      i += 1;
      continue;
    }
    out += line.slice(i, close + 1);
    i = close + 1;
  }
  return out;
}

/** `open` 의 `$` 가 여는 인라인 수식의 닫는 `$` 자리. 수식이 아니면 null. */
function mathCloseAt(line: string, open: number): number | null {
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
