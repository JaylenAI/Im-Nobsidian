import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { mapOutsideCode } from "../../utils/md-regions.js";
import { mathCloseAt } from "../literal-dollar.js";

const BLOCK_MATH_REGEX = /\$\$([\s\S]+?)\$\$/g;
/** 줄머리가 인용 표시(`>`)와 들여쓰기뿐인가 — 콜아웃 · 목록 안의 블록 수식은 줄마다 이것을 단다. */
const CONTAINER_PREFIX_RE = /^(?:[ \t]*>)*[ \t]*$/;
/** 줄머리(인용 표시 · 들여쓰기) — {@link CONTAINER_PREFIX_RE} 의 줄 앞 부분. */
const CONTAINER_LEAD_RE = /^(?:[ \t]*>)*[ \t]*/;

/**
 * 블록 수식(`$$…$$`)의 두 `$$` 를 저마다 제 줄에 세운다 — Notion 은 `$$` 가 줄에 혼자 있을 때만 블록
 * 수식으로 읽는다. 한 줄로 쓴 `$$ x^2 $$` · 식이 `$$` 줄에 붙은 `$$ a` … `b $$` 는 빈 인라인 수식과
 * 글이 된다(실측).
 *
 * 콜아웃 · 목록 안의 수식은 새 줄에도 줄머리(`> ` · 들여쓰기)를 단다. 예전에는 닫는 `$$` 를 줄머리
 * 없이 세워 콜아웃 밖으로 꺼냈고, Notion 은 그 `$$` 부터 뒤 문단을 수식으로 삼켰다(실측).
 * 글 사이의 `$$x$$` 는 둔다 — Notion 은 인라인 수식으로 읽는데, 줄을 가르면 빈 수식과 글이 된다.
 *
 * 코드 펜스 · 인라인 코드 안의 `$` 는 코드다. 셸의 `$$`(PID) · `$HOME` 을 수식으로 보면 Notion 의
 * 코드가 바뀌고, 코드 속 `$$` 가 코드 밖 수식의 `$$` 와 짝지어져 그 사이 본문까지 옮겨졌다(S-21).
 *
 * 블록 수식으로 서지 못하는 `$$` 는 Notion 이 빈 인라인 수식으로 읽는다(2026-10-21 실측) — 짝이 없는 `$$` 는
 * Obsidian 이 글로 그리는데 Notion 에는 빈 수식 상자가 생겼다. 그래서 줄 안에서 짝이 없는 `$$` 는 `\$\$`(두 쪽 모두
 * 글 `$$`)로, 글과 한 줄인 `$$ x $$` 는 안쪽 공백을 떼어 `$$x$$`(Notion 의 인라인 수식)로 보낸다
 * ({@link settleLineDollars}). 제 줄의 `$$` 는 블록 수식의 경계라 둔다.
 *
 * 인라인 수식(`$…$`)의 안쪽은 건드리지 않는다. 예전에는 안쪽 공백을 잘라 `$ x $` 가 수식이 되고
 * `$5 and $10` 이 `$5 and$10` 으로 바뀌었다. Obsidian 과 Notion 은 여는 `$` 뒤 · 닫는 `$` 앞이
 * 공백이거나 닫는 `$` 뒤가 숫자면 수식으로 읽지 않는다(Obsidian 1.13.7 의 토크나이저 · Notion 실측).
 * 다만 Notion 은 글자에 붙은 수식(`w$^9$가`)도 글로 읽는다 — 그런 수식만 `` $`식`$ `` 로 보낸다({@link quoteGluedMath}).
 */
export class MathNormalizer implements Processor {
  readonly name = "MathNormalizer";
  readonly order = 50;

  process(input: ProcessorInput): ProcessorOutput {
    // 줄 가운데의 짝 없는 `$$` 를 먼저 글로 — 남겨 두면 뒤 블록 수식의 여는 `$$` 와 짝지어져 그 수식을 세우지 못한다.
    const source = settleDollars(input.content, false);
    const stood = mapOutsideCode(source, (segment, base) =>
      segment.replace(
        BLOCK_MATH_REGEX,
        (match: string, equation: string, at: number) =>
          standBlockMath(source, base + at, match, equation) ?? match,
      ),
    );
    const content = quoteGluedMath(settleDollars(stood, true));

    return {
      content,
      metadata: input.metadata,
    };
  }
}

/**
 * 원문 `start` 의 `$$…$$` 를 `$$` · 식 · `$$` 줄로 편다. 두 `$$` 가 줄의 처음(줄머리 뒤)과 끝이
 * 아니거나, 식의 줄이 여는 줄의 줄머리를 달지 않았으면(짝이 인용 · 목록 밖으로 넘어감) · 식이
 * 비었으면 null — 그대로 둔다.
 */
function standBlockMath(
  source: string,
  start: number,
  match: string,
  equation: string,
): string | null {
  const prefix = source.slice(source.lastIndexOf("\n", start - 1) + 1, start);
  if (!CONTAINER_PREFIX_RE.test(prefix)) return null;

  const end = start + match.length;
  const lineEnd = source.indexOf("\n", end);
  if (source.slice(end, lineEnd === -1 ? undefined : lineEnd).trim() !== "") return null;

  const [first = "", ...rest] = equation.split("\n");
  const lines = [first];
  for (const line of rest) {
    const inner = withoutPrefix(line, prefix);
    if (inner === null) return null;
    lines.push(inner);
  }

  const expression = lines.join("\n").trim();
  if (expression === "") return null;

  const body = expression
    .split("\n")
    .map((line) => (line === "" ? prefix.trimEnd() : `${prefix}${line}`));
  return ["$$", ...body, `${prefix}$$`].join("\n");
}

/** 줄머리를 뗀 줄 — 빈 인용 줄(`>`)은 빈 줄이다. 줄머리가 다르면 null. */
function withoutPrefix(line: string, prefix: string): string | null {
  if (line.startsWith(prefix)) return line.slice(prefix.length);
  if (line.trimEnd() === prefix.trimEnd()) return "";
  return null;
}

/**
 * 글의 `$$` — 앞이 `\` · `$` 가 아니고 뒤가 `$` 가 아니다. `$$$` 처럼 세 개 넘게 붙은 `$` 는 보지 않는다. 앞이
 * 공백(줄 머리)이 아닌 `$$` 는 인라인 수식 둘 사이(`$a$$b$`)일 수 있어 글로 바꾸지 않는다({@link settleLineDollars}).
 */
const DOUBLE_DOLLAR_RE = /(?<![\\$])\$\$(?!\$)/g;
/** 제 줄의 `$$` — 줄머리 · 목록 표지 · 콜아웃 머리(`[!note]`) 뒤에 `$$` 만 있다. 블록 수식의 경계다. */
const OWN_LINE_DOLLARS_RE =
  /^(?:[ \t]*>)*[ \t]*(?:\[![^\]]*\][+-]?[ \t]*|(?:[-*+]|\d+[.)])[ \t]+)?\$\$[ \t]*$/;

/** 코드 밖 줄마다 {@link settleLineDollars}. */
function settleDollars(content: string, final: boolean): string {
  return mapOutsideCode(content, (segment) =>
    segment
      .split("\n")
      .map((line) => (line.includes("$$") ? settleLineDollars(line, final) : line))
      .join("\n"),
  );
}

/**
 * 한 줄의 `$$` 를 앞에서부터 둘씩 짝짓고 Notion 이 Obsidian 과 같게 읽을 모양으로 고친다.
 *
 * - 짝이 없는 `$$` 는 `\$\$` — 앞이 공백 · 줄 머리일 때만. `final` 이 아니면(블록 수식을 세우기 전) 뒤에도 글이 있어
 *   블록 수식의 경계일 수 없는 것만.
 * - 안쪽 끝에 공백이 있는 짝(`$$ x $$`)의 공백을 뗀다 — 제 줄의 짝은 뒤에서 블록 수식으로 선다. 식이 빈 짝(`$$ $$`)은 둔다.
 */
function settleLineDollars(line: string, final: boolean): string {
  if (OWN_LINE_DOLLARS_RE.test(line)) return line;
  const at = [...line.matchAll(DOUBLE_DOLLAR_RE)].map((m) => m.index);
  const edits: Array<readonly [start: number, end: number, text: string]> = [];
  for (let k = 0; k + 1 < at.length; k += 2) {
    const inner = line.slice(at[k]! + 2, at[k + 1]);
    const trimmed = inner.trim();
    if (trimmed !== "" && trimmed !== inner) {
      edits.push([at[k]!, at[k + 1]! + 2, `$$${trimmed}$$`]);
    }
  }
  if (at.length % 2 === 1) {
    const stray = at[at.length - 1]!;
    const before = line[stray - 1];
    const openText = before === undefined || /\s/.test(before);
    const lead = line.match(CONTAINER_LEAD_RE)![0].length;
    const midLine = line.slice(lead, stray).trim() !== "" && line.slice(stray + 2).trim() !== "";
    if (openText && (final || midLine)) edits.push([stray, stray + 2, "\\$\\$"]);
  }
  let out = line;
  for (const [start, end, text] of edits.reverse())
    out = out.slice(0, start) + text + out.slice(end);
  return out;
}

/**
 * Obsidian 은 수식으로 그리는데 Notion 은 글로 읽는 인라인 수식을 `` $`식`$ `` 로 — Notion 이 내보내는 모양이고,
 * 글자에 붙어 있어도 수식으로 읽는다(2026-10-23 탐침: `w$^9$가` 는 글, `` w$`^9`$가 `` 는 수식).
 *
 * Notion 은 여는 `$` 앞이 글자 · 숫자이거나 닫는 `$` 뒤가 글자면 수식이 아니다({@link mathCloseAt}). Obsidian 은
 * 여는 `$` 뒤 · 닫는 `$` 앞이 공백이 아니고 닫는 `$` 뒤가 숫자가 아니면 수식이다. 두 쪽이 모두 수식으로 읽는 것은
 * 그대로 둔다 — 보내는 모양이 바뀌면 이미 올린 노트가 다르게 보인다.
 *
 * 여는 `$` 다음의 첫 `$` 가 닫지 못하면 그 `$` 는 손대지 않는다 — Obsidian 이 더 뒤의 `$` 와 짝지을 수도
 * 있지만, 가르지 못하는 것은 예전처럼 보낸다. 블록 수식의 줄 · 백틱이 든 식도 그대로다.
 */
function quoteGluedMath(content: string): string {
  let inBlock = false;
  return mapOutsideCode(content, (segment) =>
    segment
      .split("\n")
      .map((line) => {
        if (OWN_LINE_DOLLARS_RE.test(line)) {
          inBlock = !inBlock;
          return line;
        }
        return inBlock || !line.includes("$") ? line : quoteLineGluedMath(line);
      })
      .join("\n"),
  );
}

function quoteLineGluedMath(line: string): string {
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
      let run = i;
      while (line[run] === "$") run += 1;
      out += line.slice(i, run);
      i = run;
      continue;
    }
    const close = obsidianMathCloseAt(line, i);
    if (close === null) {
      out += ch;
      i += 1;
      continue;
    }
    const expression = line.slice(i + 1, close);
    out +=
      expression.includes("`") || mathCloseAt(line, i) === close
        ? line.slice(i, close + 1)
        : `$\`${expression}\`$`;
    i = close + 1;
  }
  return out;
}

/** `open` 의 `$` 를 Obsidian 이 여는 인라인 수식으로 읽을 때 닫는 `$` 자리 — 여는 `$` 다음의 첫 `$` 만 본다. */
function obsidianMathCloseAt(line: string, open: number): number | null {
  const after = line[open + 1];
  if (after === undefined || /\s/.test(after)) return null;
  const close = line.indexOf("$", open + 1);
  if (close === -1 || line[close + 1] === "$") return null;
  const inner = line[close - 1]!;
  if (/\s/.test(inner) || inner === "\\" || /\d/.test(line[close + 1] ?? "")) return null;
  return close;
}
