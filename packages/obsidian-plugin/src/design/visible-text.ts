/**
 * 마크다운 원문 조각 → Obsidian 이 그려 보이는 글(근사).
 *
 * 읽기 보기에서는 마커(`%%…%%`)가 그려지기 «전» 에 지워져, 어느 글을 칠할지는 원문으로만 안다.
 * 원문 조각을 보이는 글로 바꿔 그려진 글에서 차례대로 찾는다(`render-dom.ts`). 여기가 틀리면 그
 * 조각을 못 찾고 건너뛸 뿐 다른 글을 칠하지 않는다 — 찾는 자리가 차례로만 앞으로 가기 때문이다.
 */

/** 줄 머리의 블록 문법 — 인용 · 콜아웃 머리 · 제목 · 목록 · 할 일. */
const BLOCK_PREFIX_RE =
  /^[\t ]*(?:>[\t ]?)*(?:[\t ]*(?:#{1,6}[\t ]+|[-*+][\t ]+(?:\[.\][\t ]+)?|\d+[.)][\t ]+(?:\[.\][\t ]+)?|\[![^\]]*\][-+]?[\t ]*))?/;

export function blockPrefixLength(line: string): number {
  return BLOCK_PREFIX_RE.exec(line)?.[0].length ?? 0;
}

/** 표 구분 줄(`| --- | :-: |`). */
export const TABLE_SEPARATOR_RE = /^[\t >]*\|?(?:[\t ]*:?-+:?[\t ]*\|)+[\t ]*(?::?-+:?[\t ]*)?$/;

/** 표 줄 — 컨테이너 접두 뒤가 파이프로 시작한다. */
export const TABLE_LINE_RE = /^[\t >]*\|/;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

/** 위키링크가 보이는 글 — 별칭, 없으면 경로 끝 이름(제목 · 블록 참조는 ` > ` 로 이어진다). */
function wikilinkText(target: string): string {
  const [path, ...rest] = target.split("#");
  const name = path!.split("/").pop()!.replace(/\.md$/, "");
  const tail = rest.join("#").replace(/^\^/, "");
  return tail ? `${name} > ${tail}` : name;
}

export function toVisibleText(source: string): string {
  return (
    source
      // 임베드 · 이미지는 글이 아니다
      .replace(/!\[\[[^\]]*\]\]/g, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
      .replace(/\[\[([^\]]*)\]\]/g, (_m, target: string) => wikilinkText(target))
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // 각주 참조는 번호로 그려진다
      .replace(/\[\^[^\]]*\]/g, "")
      // 남은 Obsidian 주석 · 인라인 HTML 태그
      .replace(/%%[^\n]*?%%/g, "")
      .replace(/<\/?[a-zA-Z][^>]*>/g, "")
      // 코드 안은 칠하지 않는다 — 찾는 쪽(`render-dom.ts`)도 그려진 코드의 글을 빼고 이어 붙인다
      .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, "")
      // 강조 구분자
      .replace(/\*\*|~~|==/g, "")
      .replace(/(^|[^\\])\*/g, "$1")
      .replace(/(^|[\s\p{P}])_+(?=\S)|(?<=\S)_+(?=[\s\p{P}]|$)/gu, "$1")
      // 이스케이프 · 문자 참조
      .replace(/\\([!-/:-@[-`{-~])/g, "$1")
      .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e]!)
  );
}

/** 표 줄을 칸으로 — 이스케이프 `\|` · 코드 안의 `|` 는 칸을 나누지 않는다. */
export function splitTableCells(text: string): string[] {
  const cells: string[] = [];
  let current = "";
  let tick = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "`") {
      let run = 1;
      while (text[i + run] === "`") run++;
      tick = tick === 0 ? run : tick === run ? 0 : tick;
      current += text.slice(i, i + run);
      i += run - 1;
    } else if (ch === "|" && text[i - 1] !== "\\" && tick === 0) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}
