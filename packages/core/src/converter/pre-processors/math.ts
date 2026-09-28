import type { Processor, ProcessorInput, ProcessorOutput } from "../../types/convert.js";
import { mapOutsideCode } from "../../utils/md-regions.js";

const BLOCK_MATH_REGEX = /\$\$([\s\S]+?)\$\$/g;
/** 줄머리가 인용 표시(`>`)와 들여쓰기뿐인가 — 콜아웃 · 목록 안의 블록 수식은 줄마다 이것을 단다. */
const CONTAINER_PREFIX_RE = /^(?:[ \t]*>)*[ \t]*$/;

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
 * 인라인 수식(`$…$`)은 건드리지 않는다. 예전에는 안쪽 공백을 잘라 `$ x $` 가 수식이 되고
 * `$5 and $10` 이 `$5 and$10` 으로 바뀌었다. Obsidian 과 Notion 은 여는 `$` 뒤 · 닫는 `$` 앞이
 * 공백이거나 닫는 `$` 뒤가 숫자면 수식으로 읽지 않는다(Obsidian 1.13.7 의 토크나이저 · Notion 실측) —
 * 노트 그대로 보내면 두 쪽이 같은 곳을 수식으로 본다.
 */
export class MathNormalizer implements Processor {
  readonly name = "MathNormalizer";
  readonly order = 50;

  process(input: ProcessorInput): ProcessorOutput {
    const source = input.content;
    const content = mapOutsideCode(source, (segment, base) =>
      segment.replace(
        BLOCK_MATH_REGEX,
        (match: string, equation: string, at: number) =>
          standBlockMath(source, base + at, match, equation) ?? match,
      ),
    );

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
