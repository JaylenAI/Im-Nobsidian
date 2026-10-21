/**
 * 일반 인용(콜아웃 아님) 안의 코드 펜스 → 인용의 자식 코드 블록 (push, S-23).
 *
 * Notion 은 인용의 `>` 한 줄을 인용 블록 하나로 읽는다(2026-10-04 실측). `> ```js` · `> x` · `> ```` 는
 * 글이 펜스 기호인 인용 블록 넷이 됐다 — Obsidian 은 인용 안 코드 블록으로 그리는데 Notion 에는 코드가
 * 없었다. Notion 의 인용은 자식 블록을 가지므로 펜스를 바로 앞 인용 줄의 자식으로 보낸다. 모양은 pull 이
 * 인용의 자식을 쓰는 꼴(BlockSpacer · ADR-022)과 같다 — 빈 줄 뒤 2칸 들여쓴 펜스와 코드 줄. 그래서 받은 노트와
 * 로컬 노트가 같은 꼴로 올라가 pull 이 로컬의 `> ```` 표기를 남긴다(`restoreLocalForm`).
 *
 * 펜스 앞에 인용 줄이 없으면(인용이 코드로 시작) 빈 인용 줄(`>`)을 부모로 둔다 — Notion 은 빈 인용 줄을 빈
 * 인용 블록으로 만든다(실측). 펜스 뒤 인용 줄은 새 인용 블록이다. 인용 안에서 닫히지 않은 펜스 · 중첩 인용
 * (`> >`) 안 펜스는 그대로 둔다.
 */
import { CLAMPED_INDENT } from "./callout-indent.js";
import { closesCodeFence, type CodeFenceOpening, openCodeFence } from "../utils/md-regions.js";

/** 맨 바깥 인용 줄 — 줄머리 `>` 와 그 뒤 공백 하나까지가 접두다. */
const QUOTE_LINE_RE = /^> ?(.*)$/;
/** 콜아웃 · 토글 머리 — 이 인용은 콜아웃 변환이 다룬다. */
const CALLOUT_HEAD_RE = /^\[!/;

export function quotedCodeToChildren(content: string): string {
  const lines = content.split("\n");
  const inCode = unquotedCodeMask(lines);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (inCode[i] || !QUOTE_LINE_RE.test(lines[i]!)) {
      out.push(lines[i]!);
      i += 1;
      continue;
    }
    let end = i;
    while (end < lines.length && !inCode[end] && QUOTE_LINE_RE.test(lines[end]!)) end += 1;
    const bodies = lines.slice(i, end).map((line) => QUOTE_LINE_RE.exec(line)![1]!);
    if (CALLOUT_HEAD_RE.test(bodies[0]!)) out.push(...lines.slice(i, end));
    else out.push(...unquoteCode(lines.slice(i, end), bodies));
    i = end;
  }
  return out.join("\n");
}

/**
 * 인용 밖 코드 펜스의 줄 — 그 안의 `>` 줄은 코드다. `codeLineMask` 는 인용 안 펜스도 코드로 쳐서 쓰지 않는다.
 */
function unquotedCodeMask(lines: readonly string[]): boolean[] {
  let fence: CodeFenceOpening | null = null;
  return lines.map((line) => {
    if (fence !== null) {
      if (closesCodeFence(line, fence)) fence = null;
      return true;
    }
    fence = openCodeFence(line);
    return fence !== null;
  });
}

/** 인용 한 덩이 — 닫히는 펜스를 앞 인용 줄의 자식으로 꺼낸다. */
function unquoteCode(lines: readonly string[], bodies: readonly string[]): string[] {
  const out: string[] = [];
  let quoted = false;
  for (let k = 0; k < lines.length; k++) {
    const opening = openCodeFence(bodies[k]!);
    const close = opening ? bodies.findIndex((b, j) => j > k && closesCodeFence(b, opening)) : -1;
    if (close < 0) {
      out.push(lines[k]!);
      quoted = true;
      continue;
    }
    if (!quoted) out.push(">");
    if (out[out.length - 1] !== "") out.push("");
    out.push(...bodies.slice(k, close + 1).map((b) => (b === "" ? b : CLAMPED_INDENT + b)));
    if (close + 1 < lines.length) out.push("");
    // 이어지는 펜스도 같은 인용 줄의 자식이다 — 코드는 자식을 갖지 못해 Notion 이 형제로 둔다.
    quoted = true;
    k = close;
  }
  return out;
}
