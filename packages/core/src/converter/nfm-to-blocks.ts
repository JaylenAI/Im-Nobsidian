/**
 * NFM 을 블록 API 로 만들 블록으로 — 블록 방식 push(`preferMarkdownApi: false`) 전용 (C14, ADR-035).
 *
 * Markdown API 경로는 볼트 노트를 NFM 으로 옮겨(`obsidianToNotionEnhanced`) 보내고 Notion 이 블록을 만든다.
 * 블록 방식은 예전에 볼트 노트를 martian 으로 바로 블록으로 만들었는데, 볼트 모양(콜아웃 · 토글 · 칼럼 ·
 * 멘션 · 색 …)을 몰라 그 블록들이 Notion 에서 글이나 인용으로 바뀌었다. 그래서 Markdown API 와 **같은 NFM** 을
 * 만들고, Notion 이 그 NFM 을 블록으로 만드는 규칙을 그대로 따라 블록을 만든다. {@link blocksToNfm} 의 역이다.
 *
 * Notion 의 규칙(2026-10-12 실측 — Markdown API 로 만든 탐침 페이지의 블록 트리):
 *
 * - 한 줄이 한 블록이고 빈 줄은 버린다. 들여쓰기(탭 · 공백 하나씩 같은 폭)가 더 깊으면 앞 블록의 자식이다.
 *   자식을 가질 수 없는 블록(접지 않는 제목 · 구분선 · 빈 블록 · 코드 …) 아래로 깊은 줄은 형제가 된다.
 * - `#`~`###` 은 제목 1~3, `####`~`######` 은 제목 4. 글이 없으면 문단이다. 줄 끝 `{toggle="true" color="…"}`
 *   는 블록 속성이다 — 문단 · 목록 · 할 일 · 인용에도 `{color}` 가 붙는다. `1)` 은 번호 목록이 아니다.
 * - 코드 펜스는 백틱 셋 이상. 펜스의 들여쓰기는 몸통 줄이 **모두** 그 들여쓰기를 가질 때만 걷는다. 닫는 펜스는
 *   들여쓰기와 상관없다. `$$` 줄 사이는 블록 수식이다(닫지 않으면 끝까지).
 * - `<details>` 의 자식은 `<summary>` 아래 같은 깊이여도 된다. `<callout>` 은 첫 줄이 맨 문단일 때만 그 줄이
 *   콜아웃의 글이다(줄의 속성은 버린다) — 목록 · 제목 · 코드로 시작하면 글은 비고 모두 자식이다.
 * - `<tabs>` 의 `<tab>` 은 첫 줄이 탭 이름(문단), 나머지 줄은 모두 그 문단의 자식이다. 탭의 `title` 속성은
 *   읽지 않는다. `<tabs>` 밖의 `<tab>` 은 글이다.
 * - `<table>` 은 `<tr>` · `<td>` 만 읽는다(`<colgroup>` · 행 · 칸 색은 블록 API 에 없다). 칸의 `\|` 는 `|` 다.
 *   GFM 표(`| a | b |` + 맞춤 줄)는 `|` 로 시작해야 표이고, 첫 행은 머리 행이다.
 *
 * Notion 과 일부러 다르게 하는 것: 콜아웃 첫 줄 아래 자식은 Notion 이 블록 API 에서 보이지 않는 곳에 두지만
 * 여기서는 콜아웃의 자식으로 둔다. 표의 너비는 가장 긴 행으로 맞춘다(Notion 은 행을 잘랐다).
 *
 * 블록 API 로 만들 수 없는 태그는 버린다 — 다른 페이지를 옮기는 `<page>` · `<database>`, 바로가기
 * (`<unknown alt="alias">`), 볼트에서 주소를 알 수 없는 북마크. 북마크는 볼트의 링크 쌍에서 주소를 받는다
 * ({@link NfmToBlocksOptions.bookmarks}).
 */
import type { BlockRequest } from "../notion/block-tree.js";
import { richTextChunks } from "../notion/rich-text.js";
import type { BookmarkTarget } from "../types/convert.js";
import { normalizeNotionId } from "../utils/id.js";
import { notionCodeLanguage } from "./code-language.js";
import { apiColor, nfmInlineToRichText, type NfmRichText } from "./nfm-inline.js";
import { nfmAttrValue, parseNfmAttrs, type NfmAttrs } from "./nfm-attrs.js";

/** 만들 블록 — 블록 API 요청 모양이다. 자식은 몸통의 `children` 에 깊이 제한 없이 담는다. */
export type NfmBlock = BlockRequest;

export interface NfmToBlocksOptions {
  /**
   * 북마크 자리 태그(`<unknown url="…" alt="bookmark"/>`)의 주소 → 북마크. Markdown API 는 그 주소로 Notion 의
   * 북마크를 남기지만 블록 방식은 새로 만들어야 한다 — 볼트의 링크 쌍이 주소와 캡션을 싣는다.
   */
  readonly bookmarks?: ReadonlyMap<string, BookmarkTarget>;
}

/** NFM 을 블록으로. 블록 API 의 깊이 · 개수 한도는 보내는 쪽이 나눈다(`NotionClient.appendBlockTree`). */
export function nfmToBlocks(nfm: string, options: NfmToBlocksOptions = {}): NfmBlock[] {
  const lines = nfm.split("\n");
  return prune(new NfmBlockParser(lines, options).parse(0, lines.length).map((p) => p.block));
}

/**
 * NFM 의 첫 블록이 맨 문단인가 — `<callout>` 몸통이면 그 줄이 콜아웃의 글이 되는 조건이다(Notion 의
 * 가져오기, 실측). Notion 은 글 없는 콜아웃의 첫 자식(이미지 · 목록 · 제목 · 코드 …)을 같은 자리에 내보내므로
 * pull 도 이 규칙으로 콜아웃의 글과 자식을 가른다.
 */
export function startsWithParagraph(lines: readonly string[]): boolean {
  return new NfmBlockParser(lines, {}).parse(0, lines.length)[0]?.plain === true;
}

// ─── 줄 ───

const BLANK_RE = /^[ \t]*$/;
const FENCE_OPEN_RE = /^(`{3,})([^`]*)$/;
const MATH_FENCE_RE = /^\$\$[ \t]*$/;
/** GFM 표의 맞춤 줄 — `| --- | :---: |`. */
const PIPE_DELIMITER_RE = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?$/;
const CONTAINER_OPEN_RE =
  /^<(details|callout|columns|tabs|table|synced_block|synced_block_reference)((?:\s+[A-Za-z][\w-]*="[^"]*")*)\s*>[ \t]*$/;
const SUMMARY_RE = /^<summary>(.*)<\/summary>[ \t]*$/;
const EMPTY_BLOCK_RE = /^<empty-block\s*\/>[ \t]*$/;
const TOC_RE = /^<table_of_contents((?:\s+[A-Za-z][\w-]*="[^"]*")*)\s*\/>[ \t]*$/;
const UNKNOWN_RE = /^<unknown((?:\s+[A-Za-z][\w-]*="[^"]*")*)\s*\/>[ \t]*$/;
const CHILD_TAG_RE = /^<(page|database)\s[^>]*>.*<\/\1>[ \t]*$/;
const MEDIA_RE = /^<(video|audio|pdf|file|embed)\s+src="([^"]*)"[^>]*>(.*)<\/\1>[ \t]*$/;
const IMAGE_RE = /^!\[((?:\\.|[^\\\]])*)\]\(([^\s)]+)\)[ \t]*$/;
const DIVIDER_RE = /^(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const HEADING_RE = /^(#{1,6})[ \t]+(\S.*)$/;
const TODO_RE = /^[-*+][ \t]+\[([ xX])\](?:[ \t]+(.*))?$/;
const BULLET_RE = /^[-*+](?:[ \t]+(.*))?$/;
const NUMBERED_RE = /^\d{1,9}\.(?:[ \t]+(.*))?$/;
const QUOTE_RE = /^>[ \t]?(.*)$/;
/** 줄 끝 블록 속성 — `글 {color="red"}`, `**글**{color="red"}`. */
const BLOCK_ATTRS_RE = /[ \t]*\{((?:[ \t]*[A-Za-z][\w-]*="[^"]*")+)[ \t]*\}[ \t]*$/;
const HTTP_URL_RE = /^https?:\/\//;
/** Notion 아이콘 그림 — `/icons/<이름>_<색>.svg`. */
const NOTION_ICON_RE =
  /^\/icons\/(.+?)(?:_(gray|lightgray|brown|yellow|orange|green|blue|purple|pink|red))?\.svg$/;

/** 들여쓰기로 자식을 받는 블록. */
const NESTING_TYPES: ReadonlySet<string> = new Set([
  "paragraph",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "quote",
]);

interface Parsed {
  readonly block: NfmBlock;
  /** 이 블록 아래 더 깊은 줄을 자식으로 받는가. */
  readonly nests: boolean;
  /** 문단 줄인가 — 콜아웃의 첫 줄이면 콜아웃의 글이 된다. 빈 블록(`<empty-block/>`)은 아니다. */
  readonly plain?: boolean;
}

/** 블록 하나 대신 그 자리에 둘 블록들 — 블록 API 로 만들 수 없는 감싸개를 벗긴 것. */
interface Unwrapped {
  readonly blocks: readonly NfmBlock[];
}

class NfmBlockParser {
  constructor(
    private readonly lines: readonly string[],
    private readonly options: NfmToBlocksOptions,
  ) {}

  /** `[start, end)` 의 줄들을 블록으로 — 들여쓰기 폭으로 자식을 가른다. */
  parse(start: number, end: number): Parsed[] {
    const roots: Parsed[] = [];
    const stack: Array<{ width: number; parsed: Parsed }> = [];
    let i = start;
    while (i < end) {
      const raw = this.lines[i]!;
      if (BLANK_RE.test(raw)) {
        i += 1;
        continue;
      }
      const width = /^[ \t]*/.exec(raw)![0].length;
      const { parsed, next } = this.block(i, end, width);
      i = next;
      while (stack.length > 0 && stack[stack.length - 1]!.width >= width) stack.pop();
      if (parsed === null) continue;
      const parent = stack[stack.length - 1];
      const placed = "blocks" in parsed ? parsed.blocks.map(leaf) : [parsed];
      if (parent) childrenOf(parent.parsed.block).push(...placed.map((p) => p.block));
      else roots.push(...placed);
      if (!("blocks" in parsed) && parsed.nests) stack.push({ width, parsed });
    }
    return roots;
  }

  /** `i` 줄에서 시작하는 블록과 그 다음 줄. 만들지 않는 블록이면 parsed 가 null. */
  private block(
    i: number,
    end: number,
    width: number,
  ): { parsed: Parsed | Unwrapped | null; next: number } {
    const raw = this.lines[i]!;
    const line = raw.slice(width);

    const fence = FENCE_OPEN_RE.exec(line);
    if (fence) return this.code(i, end, raw.slice(0, width), fence[1]!.length, fence[2]!);

    if (MATH_FENCE_RE.test(line)) return this.equation(i, end, raw.slice(0, width));

    if (line.startsWith("|") && i + 1 < end && PIPE_DELIMITER_RE.test(this.lines[i + 1]!.trim())) {
      return this.pipeTable(i, end);
    }

    const container = CONTAINER_OPEN_RE.exec(line);
    if (container) {
      const name = container[1]!;
      const close = this.closeOf(name, i + 1, end);
      const attrs = parseNfmAttrs(container[2]!);
      const parsed = this.container(name, attrs, i + 1, close);
      return { parsed, next: Math.min(close + 1, end) };
    }

    return { parsed: this.single(line), next: i + 1 };
  }

  private code(
    i: number,
    end: number,
    indent: string,
    length: number,
    info: string,
  ): { parsed: Parsed; next: number } {
    const closeRe = new RegExp(`^[ \\t]*\`{${length},}[ \\t]*$`);
    let close = i + 1;
    while (close < end && !closeRe.test(this.lines[close]!)) close += 1;
    const content = dedent(this.lines.slice(i + 1, close), indent).join("\n");
    return {
      parsed: leaf({
        type: "code",
        code: { rich_text: plainRichText(content), language: notionCodeLanguage(info.trim()) },
      }),
      next: Math.min(close + 1, end),
    };
  }

  private equation(i: number, end: number, indent: string): { parsed: Parsed; next: number } {
    let close = i + 1;
    while (close < end && !MATH_FENCE_RE.test(this.lines[close]!.trimStart())) close += 1;
    const expression = dedent(this.lines.slice(i + 1, close), indent).join("\n");
    return {
      parsed: leaf({ type: "equation", equation: { expression } }),
      next: Math.min(close + 1, end),
    };
  }

  /** 여는 태그에 짝이 맞는 닫는 태그의 줄. 없으면 `end` — 끝까지가 안이다. 코드 펜스 안은 건너뛴다. */
  private closeOf(name: string, from: number, end: number): number {
    const open = new RegExp(`^<${name}(?:\\s[^>]*)?>[ \\t]*$`);
    const close = `</${name}>`;
    let depth = 1;
    for (let k = from; k < end; k += 1) {
      const line = this.lines[k]!.trim();
      const fence = FENCE_OPEN_RE.exec(line);
      if (fence) {
        const closeRe = new RegExp(`^[ \\t]*\`{${fence[1]!.length},}[ \\t]*$`);
        k += 1;
        while (k < end && !closeRe.test(this.lines[k]!)) k += 1;
        continue;
      }
      if (open.test(line)) depth += 1;
      else if (line === close && --depth === 0) return k;
    }
    return end;
  }

  private container(
    name: string,
    attrs: NfmAttrs,
    start: number,
    end: number,
  ): Parsed | Unwrapped | null {
    switch (name) {
      case "details":
        return this.toggle(attrs, start, end);
      case "callout":
        return this.callout(attrs, start, end);
      case "columns":
        return this.columns(start, end);
      case "tabs":
        return this.tabs(start, end);
      case "table":
        return this.table(attrs, start, end);
      case "synced_block":
        // 원본 블록은 새로 만든다 — 다른 페이지의 참조는 옛 원본을 가리킨 채 남는다(ADR-035).
        return leaf({
          type: "synced_block",
          synced_block: { synced_from: null, children: this.blocksOf(start, end) },
        });
      case "synced_block_reference": {
        const source = /#([0-9a-fA-F-]{32,36})$/.exec(nfmAttrValue(attrs, "url") ?? "")?.[1];
        if (source === undefined) return null;
        return leaf({
          type: "synced_block",
          synced_block: { synced_from: { type: "block_id", block_id: normalizeNotionId(source) } },
        });
      }
      default:
        return null;
    }
  }

  private blocksOf(start: number, end: number): NfmBlock[] {
    return this.parse(start, end).map((p) => p.block);
  }

  private firstLine(start: number, end: number): number {
    let k = start;
    while (k < end && BLANK_RE.test(this.lines[k]!)) k += 1;
    return k;
  }

  private toggle(attrs: NfmAttrs, start: number, end: number): Parsed {
    const first = this.firstLine(start, end);
    const summary = first < end ? SUMMARY_RE.exec(this.lines[first]!.trim()) : null;
    const color = apiColor(nfmAttrValue(attrs, "color"));
    return leaf({
      type: "toggle",
      toggle: {
        rich_text: nfmInlineToRichText(summary?.[1] ?? ""),
        ...(color ? { color } : {}),
        children: this.blocksOf(summary ? first + 1 : start, end),
      },
    });
  }

  private callout(attrs: NfmAttrs, start: number, end: number): Parsed {
    const parsed = this.parse(start, end);
    const head = parsed[0]?.plain === true ? parsed.shift()!.block : null;
    const headBody = head ? bodyOf(head) : null;
    const icon = calloutIcon(nfmAttrValue(attrs, "icon"));
    const color = apiColor(nfmAttrValue(attrs, "color"));
    return leaf({
      type: "callout",
      callout: {
        rich_text: (headBody?.rich_text as NfmRichText[] | undefined) ?? [],
        ...(icon ? { icon } : {}),
        ...(color ? { color } : {}),
        children: [
          ...((headBody?.children as NfmBlock[] | undefined) ?? []),
          ...parsed.map((p) => p.block),
        ],
      },
    });
  }

  /** `<tag …>` … `</tag>` 들 — 그 밖의 줄은 읽지 않는다. */
  private sections(
    tag: string,
    start: number,
    end: number,
  ): Array<{ attrs: NfmAttrs; start: number; end: number }> {
    const open = new RegExp(`^<${tag}((?:\\s+[A-Za-z][\\w-]*="[^"]*")*)\\s*>$`);
    const out: Array<{ attrs: NfmAttrs; start: number; end: number }> = [];
    for (let k = start; k < end; k += 1) {
      const m = open.exec(this.lines[k]!.trim());
      if (!m) continue;
      const close = this.closeOf(tag, k + 1, end);
      out.push({ attrs: parseNfmAttrs(m[1]!), start: k + 1, end: close });
      k = close;
    }
    return out;
  }

  private columns(start: number, end: number): Parsed | Unwrapped | null {
    const sections = this.sections("column", start, end).map(({ attrs, start: s, end: e }) => ({
      ratio: Number(nfmAttrValue(attrs, "ratio")),
      children: this.blocksOf(s, e),
    }));
    if (sections.length === 0) return null;
    // 칼럼 하나짜리 묶음은 블록 API 가 거부한다(칼럼 둘 이상, 실측) — 칼럼의 블록을 그 자리에 둔다.
    if (sections.length === 1) return { blocks: sections[0]!.children };
    const columns = sections.map(({ ratio, children }) => ({
      type: "column",
      column: {
        // 칼럼은 블록 하나는 품어야 만들어진다.
        children: children.length > 0 ? children : [emptyParagraph()],
        ...(Number.isFinite(ratio) && ratio > 0 ? { width_ratio: ratio / 100 } : {}),
      },
    }));
    return leaf({ type: "column_list", column_list: { children: columns } });
  }

  private tabs(start: number, end: number): Parsed | null {
    const items = this.sections("tab", start, end).map(({ start: s, end: e }) => {
      const parsed = this.parse(s, e);
      const head = parsed[0]?.block.type === "paragraph" ? parsed.shift()!.block : emptyParagraph();
      const body = bodyOf(head);
      return {
        type: "paragraph",
        paragraph: {
          ...body,
          children: [
            ...((body.children as NfmBlock[] | undefined) ?? []),
            ...parsed.map((p) => p.block),
          ],
        },
      };
    });
    if (items.length === 0) return null;
    return leaf({ type: "tab", tab: { children: items } });
  }

  private table(attrs: NfmAttrs, start: number, end: number): Parsed | null {
    const inner = this.lines.slice(start, end).join("\n");
    const rows = [...inner.matchAll(/<tr(?:\s[^>]*)?>([\s\S]*?)<\/tr>/g)].map((row) =>
      [...row[1]!.matchAll(/<td(?:\s[^>]*)?>([\s\S]*?)<\/td>/g)].map((cell) =>
        nfmInlineToRichText(cell[1]!),
      ),
    );
    if (rows.length === 0) return null;
    return tableBlock(rows, {
      columnHeader: nfmAttrValue(attrs, "header-row") === "true",
      rowHeader: nfmAttrValue(attrs, "header-column") === "true",
    });
  }

  /** GFM 표 — 머리 행이 있다(Notion 실측: 맞춤 줄은 읽지 않는다). 행은 `|` 로 시작하는 줄까지. */
  private pipeTable(i: number, end: number): { parsed: Parsed; next: number } {
    const rows = [pipeCells(this.lines[i]!)];
    let next = i + 2;
    while (next < end && this.lines[next]!.trimStart().startsWith("|")) {
      rows.push(pipeCells(this.lines[next]!));
      next += 1;
    }
    return { parsed: tableBlock(rows, { columnHeader: true, rowHeader: false }), next };
  }

  /** 한 줄짜리 블록. */
  private single(line: string): Parsed | null {
    if (EMPTY_BLOCK_RE.test(line)) return leaf(emptyParagraph());

    const toc = TOC_RE.exec(line);
    if (toc) {
      const color = apiColor(nfmAttrValue(parseNfmAttrs(toc[1]!), "color"));
      // 색을 빼고 보내면 블록 API 는 회색으로 만든다 — Notion 의 가져오기는 기본색이다(실측 2026-10-20).
      return leaf({ type: "table_of_contents", table_of_contents: { color: color ?? "default" } });
    }

    const unknown = UNKNOWN_RE.exec(line);
    if (unknown) return this.unknown(parseNfmAttrs(unknown[1]!));

    if (CHILD_TAG_RE.test(line)) return null;

    const media = MEDIA_RE.exec(line);
    if (media) return mediaBlock(media[1]!, media[2]!, media[3]!) ?? this.paragraph(line);

    const image = IMAGE_RE.exec(line);
    if (image) return mediaBlock("image", image[2]!, image[1]!) ?? this.paragraph(line);

    if (DIVIDER_RE.test(line.trimEnd())) return leaf({ type: "divider", divider: {} });

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const { text, attrs } = splitBlockAttrs(heading[2]!);
      const level = Math.min(heading[1]!.length, 4);
      const toggle = nfmAttrValue(attrs, "toggle") === "true";
      const color = apiColor(nfmAttrValue(attrs, "color"));
      const type = `heading_${level}`;
      return {
        block: {
          type,
          [type]: {
            rich_text: nfmInlineToRichText(text),
            ...(color ? { color } : {}),
            ...(toggle ? { is_toggleable: true, children: [] } : {}),
          },
        },
        nests: toggle,
      };
    }

    const todo = TODO_RE.exec(line);
    if (todo) return nesting("to_do", todo[2] ?? "", { checked: todo[1] !== " " });

    const bullet = BULLET_RE.exec(line);
    if (bullet) return nesting("bulleted_list_item", bullet[1] ?? "");

    const numbered = NUMBERED_RE.exec(line);
    if (numbered) return nesting("numbered_list_item", numbered[1] ?? "");

    const quote = QUOTE_RE.exec(line);
    if (quote) return nesting("quote", quote[1] ?? "");

    return this.paragraph(line);
  }

  /** 문단 줄 — 콜아웃의 첫 줄이면 그 글이 콜아웃의 글이 된다(줄의 색은 버린다, 실측). */
  private paragraph(line: string): Parsed {
    return { ...nesting("paragraph", line), plain: true };
  }

  private unknown(attrs: NfmAttrs): Parsed | null {
    const url = nfmAttrValue(attrs, "url") ?? "";
    switch (nfmAttrValue(attrs, "alt")) {
      case "bookmark": {
        const target = this.options.bookmarks?.get(url);
        if (target === undefined) return null;
        return leaf({
          type: "bookmark",
          bookmark: { url: target.url, caption: plainRichText(target.caption) },
        });
      }
      case "breadcrumb":
        return leaf({ type: "breadcrumb", breadcrumb: {} });
      default:
        return null;
    }
  }
}

// ─── 블록 ───

function leaf(block: NfmBlock): Parsed {
  return { block, nests: false };
}

/** 글 · 색을 가진, 들여쓰기 자식을 받는 블록. */
function nesting(type: string, content: string, extra: Record<string, unknown> = {}): Parsed {
  const { text, attrs } = splitBlockAttrs(content);
  const color = apiColor(nfmAttrValue(attrs, "color"));
  return {
    block: {
      type,
      [type]: {
        rich_text: nfmInlineToRichText(text),
        ...extra,
        ...(color ? { color } : {}),
        children: [],
      },
    },
    nests: NESTING_TYPES.has(type),
  };
}

/** 표 — 너비는 가장 긴 행이고 짧은 행은 빈 칸으로 채운다(블록 API 는 행마다 칸 수가 같아야 한다). */
function tableBlock(
  rows: readonly NfmRichText[][][],
  header: { readonly columnHeader: boolean; readonly rowHeader: boolean },
): Parsed {
  const width = Math.max(1, ...rows.map((cells) => cells.length));
  return leaf({
    type: "table",
    table: {
      table_width: width,
      has_column_header: header.columnHeader,
      has_row_header: header.rowHeader,
      children: rows.map((cells) => ({
        type: "table_row",
        table_row: { cells: [...cells, ...Array.from({ length: width - cells.length }, () => [])] },
      })),
    },
  });
}

/**
 * GFM 표 한 행의 칸 — `\|` 는 칸을 가르지 않는다(볼트의 뜻). Notion 은 `\|` 에서도 칸을 갈랐지만(실측)
 * 그러면 칸 글이 옆 칸으로 밀린다.
 */
function pipeCells(line: string): NfmRichText[][] {
  const body = line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "");
  return body.split(/(?<!\\)\|/).map((cell) => nfmInlineToRichText(cell.trim()));
}

function emptyParagraph(): NfmBlock {
  return { type: "paragraph", paragraph: { rich_text: [] } };
}

/** 글 끝의 블록 속성을 떼어 낸다. */
function splitBlockAttrs(content: string): { text: string; attrs: NfmAttrs } {
  const m = BLOCK_ATTRS_RE.exec(content);
  if (!m) return { text: content, attrs: [] };
  return { text: content.slice(0, m.index), attrs: parseNfmAttrs(m[1]!) };
}

/** 외부 주소의 미디어 · 임베드. 주소가 http(s) 가 아니면 null — 블록 API 가 요청 전체를 거부한다. */
function mediaBlock(kind: string, url: string, caption: string): Parsed | null {
  if (!HTTP_URL_RE.test(url)) return null;
  const captionText = nfmInlineToRichText(caption);
  if (kind === "embed") return leaf({ type: "embed", embed: { url, caption: captionText } });
  return leaf({
    type: kind,
    [kind]: { type: "external", external: { url }, caption: captionText },
  });
}

function calloutIcon(icon: string | undefined): Record<string, unknown> | null {
  if (!icon) return null;
  const notion = NOTION_ICON_RE.exec(icon);
  if (notion) {
    return { type: "icon", icon: { name: notion[1]!, ...(notion[2] ? { color: notion[2] } : {}) } };
  }
  if (HTTP_URL_RE.test(icon)) return { type: "external", external: { url: icon } };
  return { type: "emoji", emoji: icon };
}

/** 코드 · 캡션처럼 서식 없이 보내는 글. 너무 길어 담을 수 없으면 한도까지 담는다 — Notion 이 거부한다. */
function plainRichText(text: string): NfmRichText[] {
  const chunks = richTextChunks(text) ?? [text];
  return chunks.map((content) => ({
    type: "text",
    text: { content },
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: "default",
    },
  }));
}

/**
 * 펜스의 들여쓰기를 걷는다 — 몸통 줄이 **모두** 그 들여쓰기로 시작할 때만(실측). 빈 줄은 따지지 않는다.
 */
function dedent(lines: readonly string[], indent: string): string[] {
  if (indent === "") return [...lines];
  const all = lines.every((line) => BLANK_RE.test(line) || line.startsWith(indent));
  return all ? lines.map((line) => line.slice(Math.min(indent.length, line.length))) : [...lines];
}

function bodyOf(block: NfmBlock): Record<string, unknown> {
  return block[block.type] as Record<string, unknown>;
}

function childrenOf(block: NfmBlock): NfmBlock[] {
  const body = bodyOf(block);
  if (!Array.isArray(body.children)) body.children = [];
  return body.children as NfmBlock[];
}

/** 빈 `children` 를 걷는다 — 자식을 받지 못하는 블록에 빈 배열을 보내지 않는다. */
function prune(blocks: NfmBlock[]): NfmBlock[] {
  for (const block of blocks) {
    const body = bodyOf(block);
    if (!Array.isArray(body.children)) continue;
    if (body.children.length === 0 && block.type !== "synced_block") delete body.children;
    else prune(body.children as NfmBlock[]);
  }
  return blocks;
}
