/**
 * Obsidian 노트의 코드 펜스 — push 가 언어를 Notion 이름으로 바꿔 보내고 pull 이 원래 표기로
 * 되살리는 단위(S-20).
 *
 * 줄머리의 인용(`>`) · 들여쓰기 · 목록 표시를 떼고 판정한다 — 콜아웃 · 목록 안의 펜스가 흔하다.
 * push 는 이 판정으로 **줄을 고치므로** 확신이 없는 곳은 펜스로 보지 않는다(CommonMark):
 *  - 백틱 펜스의 정보 문자열에 백틱이 있으면 펜스가 아니라 인라인 코드다.
 *  - 닫는 펜스는 같은 문자 · 여는 것 이상 길이 · 뒤에 공백만 · 같은 인용 깊이 · 여는 쪽보다
 *    3칸 넘게 들여쓰지 않은 줄이다. 코드 속 들여쓴 ``` 줄이 블록을 닫지 않는다.
 *  - 인용 깊이가 얕아지면 컨테이너가 끝난 것이다 — 그 펜스는 닫히지 않은 채 끝나고, 고치지 않는다.
 */
export interface CodeFence {
  /** 여는 줄 번호(0부터). */
  readonly open: number;
  /** 닫는 줄 번호 — 닫히지 않았으면 null. */
  readonly close: number | null;
  /** 여는 줄에서 펜스 앞 — 인용 표시 · 들여쓰기 · 목록 표시. */
  readonly lead: string;
  /** 여는 펜스 기호(``` · ~~~~ …). */
  readonly bar: string;
  /** 정보 문자열 원문 — 펜스 바로 뒤부터 줄 끝까지. */
  readonly info: string;
  /** 닫는 줄에서 펜스 앞 — 닫히지 않았으면 null. */
  readonly closeLead: string | null;
  /** 닫는 펜스 기호 — 닫히지 않았으면 null. */
  readonly closeBar: string | null;
  /** 코드 줄 — 펜스의 인용 표시를 뗀 것. */
  readonly code: readonly string[];
}

/** 여는 펜스 — 인용 표시 · 들여쓰기(+목록 표시) · 펜스 · 정보 문자열. */
const OPEN_RE = /^((?:[\t ]*>)*)([\t ]*(?:(?:[-*+]|\d{1,9}[.)])[\t ]+)?)(`{3,}|~{3,})(.*)$/;
/** 인용 표시를 뗀 뒤의 닫는 펜스 — 들여쓰기 · 펜스 · 뒤 공백. */
const CLOSE_BODY_RE = /^([\t ]*)(`{3,}|~{3,})[\t ]*$/;
const QUOTE_MARK_RE = /^[\t ]*>/;

/** 인용 표시를 `depth` 개 뗀다. 모자라면 null — 그 줄에서 컨테이너가 끝났다. */
function stripQuoteMarks(line: string, depth: number): { marks: string; rest: string } | null {
  let rest = line;
  for (let k = 0; k < depth; k++) {
    const mark = QUOTE_MARK_RE.exec(rest);
    if (!mark) return null;
    rest = rest.slice(mark[0].length);
  }
  return { marks: line.slice(0, line.length - rest.length), rest };
}

/** 문서의 코드 펜스를 위에서부터 차례로 찾는다. */
export function scanCodeFences(text: string): CodeFence[] {
  const lines = text.split("\n");
  const fences: CodeFence[] = [];

  for (let i = 0; i < lines.length; i++) {
    const open = OPEN_RE.exec(lines[i]!);
    if (!open) continue;
    const [, quotes, indent, bar, info] = open as unknown as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (bar[0] === "`" && info.includes("`")) continue;

    const depth = (quotes.match(/>/g) ?? []).length;
    const code: string[] = [];
    let close: number | null = null;
    let closeLead: string | null = null;
    let closeBar: string | null = null;
    let end = lines.length;

    for (let j = i + 1; j < lines.length; j++) {
      const stripped = stripQuoteMarks(lines[j]!, depth);
      if (!stripped) {
        end = j;
        break;
      }
      const shut = CLOSE_BODY_RE.exec(stripped.rest);
      if (
        shut &&
        shut[2]![0] === bar[0] &&
        shut[2]!.length >= bar.length &&
        shut[1]!.length <= indent.length + 3
      ) {
        close = j;
        closeLead = stripped.marks + shut[1]!;
        closeBar = shut[2]!;
        end = j + 1;
        break;
      }
      code.push(stripped.rest);
    }

    fences.push({
      open: i,
      close,
      lead: quotes + indent,
      bar,
      info,
      closeLead,
      closeBar,
      code,
    });
    // 닫히지 않았으면 컨테이너가 끝난 줄부터 다시 본다 — 그 줄이 새 펜스일 수 있다.
    i = end - 1;
  }

  return fences;
}

/** 코드의 지문 — 공백을 모두 뺀 내용. 컨테이너 들여쓰기 · 줄 끝 공백이 달라도 같은 코드로 본다. */
export function codeFingerprint(fence: CodeFence): string {
  return fence.code.join("\n").replace(/\s+/g, "");
}

/** 코드에 Notion 이 펜스로 읽을 줄(```로 시작)이 있는가 — 있으면 Notion 이 블록을 거기서 가른다. */
export function hasBacktickFenceLine(fence: CodeFence): boolean {
  return fence.code.some((line) => /^[\t ]*```/.test(line));
}
