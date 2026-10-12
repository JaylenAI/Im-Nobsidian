/**
 * 블록 API 의 블록 트리를 Notion 이 Markdown API 로 내보내는 글(NFM)과 같은 글로 — 블록 폴백 pull 전용.
 *
 * Markdown API 로 받지 못한 페이지(잘린 export · 오류 · `preferMarkdownApi: false`)는 블록 API 로 받는다. 예전
 * 에는 notion-to-md 로 볼트 마크다운을 바로 만들었는데, Markdown API 경로와 모양이 달라 같은 페이지가 받는 길에
 * 따라 다른 노트가 됐다. 토글 · 콜아웃 · 접는 제목의 자식이 빠지고 글자 색 · 표 · 칼럼 비율 · 콜아웃 아이콘이
 * 사라졌다 — 그 노트를 push 하면 Notion 에서 그 블록들이 지워졌다(2026-10-12 실측, 코퍼스 10장 모두 달랐다).
 *
 * 그래서 블록을 NFM 으로 옮기고 Markdown API 경로와 **같은 변환**(`notionBodyToObsidian`)에 넘긴다. 규칙은 블록
 * API 로 만든 탐침 페이지들의 Markdown API export 를 그대로 옮겼다(2026-10-12 실측, `tests/fixtures/nfm/`):
 *
 * - 블록마다 한 줄, 빈 줄 없음(압축형 export). 자식은 탭 하나 더 — 인용 · 목록의 자식도 `>` 없이 탭이다.
 * - 코드 · 표의 몸통 줄은 들여쓰지 않는다. 블록 수식은 식의 첫 줄만 들여쓴다.
 * - 서식은 바깥부터 `<span color underline>` → 링크 → `**` → `*` → `~~` → `` ` ``. 서식 끝의 공백도 안에 둔다.
 * - 글의 `\ * < > ` ~ [ ] | $ { }` 는 `\` 로 escape 한다 — 인라인 코드 · 링크 주소 · 수식 안은 그대로.
 *   줄바꿈은 `<br>`.
 * - 봇 멘션은 내보내지 않는다. 북마크 · 바로가기 · 경로 블록은 그 페이지의 블록 주소를 실은 `<unknown/>` 이다.
 *
 * 블록 API 가 주지 않아 옮기지 못하는 것: 표의 열 너비(`<colgroup>`) · 행 색, 날짜 멘션의 지역 시간대 이름
 * (오프셋에서 다시 짓는다), 탭의 제목.
 */
import { compactNotionId } from "../utils/id.js";
import { blockDateAttrs } from "./mention.js";
import { nfmAttrString } from "./nfm-attrs.js";

/** 블록 API 의 블록 — 자식이 있으면 `children` 에 미리 담아 둔다(`NotionClient.fetchBlockTree`). */
export interface NfmSourceBlock {
  readonly id: string;
  readonly type: string;
  readonly has_children?: boolean;
  readonly children?: readonly NfmSourceBlock[];
}

export interface BlocksToNfmContext {
  /**
   * 받는 페이지 — 북마크 같은 자리 태그와 동기화 참조 블록이 이 페이지의 블록 주소를 싣는다. 참조 블록도
   * 원본이 든 페이지가 아니라 이 페이지 주소에 원본 블록 id 를 붙인다(실측).
   */
  readonly pageId: string;
}

/** Notion 페이지 · 블록 주소의 머리 — Markdown API 가 쓰는 것과 같다. */
export const NOTION_PAGE_URL_PREFIX = "https://app.notion.com/p/";

interface RichTextItem {
  readonly type: string;
  readonly plain_text?: string;
  readonly href?: string | null;
  readonly text?: { readonly content: string; readonly link?: { readonly url: string } | null };
  readonly equation?: { readonly expression: string };
  readonly mention?: Record<string, unknown> & { readonly type: string };
  readonly annotations?: Partial<Annotations>;
}

interface Annotations {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly strikethrough: boolean;
  readonly underline: boolean;
  readonly code: boolean;
  readonly color: string;
}

/** 블록 트리를 NFM 으로. 줄 끝 개행은 붙이지 않는다. */
export function blocksToNfm(
  blocks: readonly NfmSourceBlock[],
  context: BlocksToNfmContext,
): string {
  return renderBlocks(blocks, 0, context).join("\n");
}

function renderBlocks(
  blocks: readonly NfmSourceBlock[],
  depth: number,
  context: BlocksToNfmContext,
): string[] {
  const lines: string[] = [];
  let number = 0;
  for (const block of blocks) {
    number = block.type === "numbered_list_item" ? number + 1 : 0;
    lines.push(...renderBlock(block, depth, context, number));
  }
  return lines;
}

function renderBlock(
  block: NfmSourceBlock,
  depth: number,
  context: BlocksToNfmContext,
  number: number,
): string[] {
  const indent = "\t".repeat(depth);
  const body = bodyOf(block);
  const text = () => richTextToNfm(body.rich_text as readonly RichTextItem[] | undefined);
  const children = () => renderBlocks(block.children ?? [], depth + 1, context);
  const color = blockColorAttr(body.color);

  switch (block.type) {
    case "paragraph": {
      const content = text();
      if (content === "" && color === "" && (block.children ?? []).length === 0) {
        return [`${indent}<empty-block/>`];
      }
      return [`${indent}${content}${color}`, ...children()];
    }
    case "heading_1":
    case "heading_2":
    case "heading_3": {
      const level = Number(block.type.slice(-1));
      const attrs = [
        body.is_toggleable === true ? 'toggle="true"' : "",
        colorName(body.color) ? `color="${colorName(body.color)}"` : "",
      ].filter((a) => a !== "");
      const content = text();
      const head = `${"#".repeat(level)}${content === "" ? "" : ` ${content}`}`;
      return [`${indent}${head}${attrs.length > 0 ? ` {${attrs.join(" ")}}` : ""}`, ...children()];
    }
    case "bulleted_list_item":
      return [`${indent}- ${text()}${color}`, ...children()];
    case "numbered_list_item":
      return [`${indent}${number}. ${text()}${color}`, ...children()];
    case "to_do":
      return [`${indent}- [${body.checked === true ? "x" : " "}] ${text()}${color}`, ...children()];
    case "quote":
      return [`${indent}> ${text()}${color}`, ...children()];
    case "callout": {
      const icon = calloutIcon(body.icon);
      const attrs = [
        icon === null ? "" : ` icon="${icon}"`,
        colorName(body.color) ? ` color="${colorName(body.color)}"` : "",
      ].join("");
      const content = text();
      return [
        `${indent}<callout${attrs}>`,
        ...(content === "" ? [] : [`${indent}\t${content}`]),
        ...children(),
        `${indent}</callout>`,
      ];
    }
    case "toggle": {
      const name = colorName(body.color);
      return [
        `${indent}<details${name ? ` color="${name}"` : ""}>`,
        `${indent}<summary>${text()}</summary>`,
        ...children(),
        `${indent}</details>`,
      ];
    }
    case "code": {
      const code = plainText(body.rich_text as readonly RichTextItem[] | undefined);
      return [`${indent}\`\`\`${String(body.language ?? "")}`, code, `${indent}\`\`\``];
    }
    case "equation":
      return [`${indent}$$`, `${indent}${String(body.expression ?? "")}`, `${indent}$$`];
    case "divider":
      return [`${indent}---`];
    case "table":
      return renderTable(block, body, indent);
    case "column_list":
      return [`${indent}<columns>`, ...children(), `${indent}</columns>`];
    case "column": {
      const ratio = typeof body.width_ratio === "number" ? columnRatio(body.width_ratio) : "";
      return [`${indent}<column${ratio}>`, ...children(), `${indent}</column>`];
    }
    case "tab":
      return [`${indent}<tabs>`, ...renderTabs(block, depth + 1, context), `${indent}</tabs>`];
    case "image":
      return [`${indent}![${richTextToNfm(captionOf(body))}](${mediaUrl(body)})`];
    case "video":
    case "audio":
    case "pdf":
    case "file":
      return [
        `${indent}<${block.type} src="${mediaUrl(body)}">${richTextToNfm(captionOf(body))}</${block.type}>`,
      ];
    case "embed":
      return [
        `${indent}<embed src="${String(body.url ?? "")}">${richTextToNfm(captionOf(body))}</embed>`,
      ];
    case "bookmark":
      return [`${indent}${unknownTag(context.pageId, block.id, "bookmark")}`];
    case "link_to_page":
      return [`${indent}${unknownTag(context.pageId, block.id, "alias")}`];
    case "table_of_contents": {
      const name = colorName(body.color);
      return [`${indent}<table_of_contents${name ? ` color="${name}"` : ""}/>`];
    }
    case "synced_block": {
      const source = (body.synced_from as { block_id?: string } | null | undefined)?.block_id;
      const tag = source ? "synced_block_reference" : "synced_block";
      const url = blockUrl(context.pageId, source ?? block.id);
      return [`${indent}<${tag} url="${url}">`, ...children(), `${indent}</${tag}>`];
    }
    case "child_page":
      return [
        `${indent}<page url="${pageUrl(block.id)}">${escapeText(String(body.title ?? ""))}</page>`,
      ];
    case "child_database":
      return [
        `${indent}<database url="${pageUrl(block.id)}">${escapeText(String(body.title ?? ""))}</database>`,
      ];
    default:
      // 경로(breadcrumb) · 옮길 수 없는 블록 — Markdown API 처럼 블록을 가리키는 자리 태그.
      return [`${indent}${unknownTag(context.pageId, block.id, block.type)}`];
  }
}

/** 탭 블록의 자식 하나가 탭 하나다 — 탭의 제목은 블록 API 가 주지 않는다(export 도 싣지 않는다). */
function renderTabs(block: NfmSourceBlock, depth: number, context: BlocksToNfmContext): string[] {
  const indent = "\t".repeat(depth);
  return (block.children ?? []).flatMap((tab) => [
    `${indent}<tab>`,
    ...renderBlocks([tab], depth + 1, context),
    `${indent}</tab>`,
  ]);
}

function renderTable(
  block: NfmSourceBlock,
  body: Record<string, unknown>,
  indent: string,
): string[] {
  const attrs = [
    body.has_column_header === true ? ' header-row="true"' : "",
    body.has_row_header === true ? ' header-column="true"' : "",
  ].join("");
  const rows = (block.children ?? []).flatMap((row) => {
    const cells = ((bodyOf(row).cells as RichTextItem[][] | undefined) ?? []).map(
      (cell) => `<td>${richTextToNfm(cell)}</td>`,
    );
    return ["<tr>", ...cells, "</tr>"];
  });
  return [`${indent}<table${attrs}>`, ...rows, `${indent}</table>`];
}

// ─── 글 조각 ───

/** NFM 에서 `\` 로 escape 하는 글자 — 실측(위 머리말). `_` · `#` · `&` · `"` 는 그대로 둔다. */
const ESCAPED_CHAR_RE = /[\\*<>`~[\]|${}]/g;

function escapeText(text: string): string {
  return breakLines(text.replace(ESCAPED_CHAR_RE, "\\$&"));
}

/** 줄바꿈은 `<br>` — 인라인 코드 안도 그렇다. 인라인 코드 안의 글자는 escape 하지 않는다(실측). */
function breakLines(text: string): string {
  return text.replace(/\n/g, "<br>");
}

/** 글 조각들을 NFM 으로. 서식 · 링크가 같은 이웃 조각은 하나로 붙인다(Notion 도 그렇게 낸다). */
export function richTextToNfm(items: readonly RichTextItem[] | undefined): string {
  let out = "";
  let run: { key: string; item: RichTextItem; text: string } | null = null;
  const flush = () => {
    if (run) {
      const code = run.item.annotations?.code === true;
      out += decorate(run.item, code ? breakLines(run.text) : escapeText(run.text), code);
    }
    run = null;
  };
  for (const item of items ?? []) {
    if (item.type !== "text") {
      flush();
      const inner = inlineOf(item);
      out += inner === "" ? "" : decorate(item, inner, false);
      continue;
    }
    const content = item.text?.content ?? item.plain_text ?? "";
    const key = JSON.stringify([annotationsOf(item), linkOf(item)]);
    if (run !== null && (run as { key: string }).key === key) {
      (run as { text: string }).text += content;
    } else {
      flush();
      run = { key, item, text: content };
    }
  }
  flush();
  return out;
}

/** 멘션 · 인라인 수식의 NFM. 내보내지 않는 것(봇)은 "". */
function inlineOf(item: RichTextItem): string {
  if (item.type === "equation") return `$\`${item.equation?.expression ?? ""}\`$`;
  const mention = item.mention;
  if (!mention) return escapeText(item.plain_text ?? "");
  const value = mention[mention.type] as Record<string, unknown> | undefined;
  switch (mention.type) {
    case "user": {
      if (value?.type === "bot") return "";
      if (typeof value?.id !== "string") return escapeText(item.plain_text ?? "");
      return `<mention-user url="user://${value.id}"/>`;
    }
    case "date": {
      const attrs = value ? blockDateAttrs(value as Parameters<typeof blockDateAttrs>[0]) : null;
      return attrs === null
        ? escapeText(item.plain_text ?? "")
        : `<mention-date${nfmAttrString(attrs)}/>`;
    }
    case "page":
    case "database": {
      if (typeof value?.id !== "string") return escapeText(item.plain_text ?? "");
      const tag = `mention-${mention.type}`;
      return `<${tag} url="${pageUrl(value.id)}">${escapeText(item.plain_text ?? "")}</${tag}>`;
    }
    default:
      return item.href
        ? `[${escapeText(item.plain_text ?? "")}](${item.href})`
        : escapeText(item.plain_text ?? "");
  }
}

function annotationsOf(item: RichTextItem): Annotations {
  const a = item.annotations ?? {};
  return {
    bold: a.bold === true,
    italic: a.italic === true,
    strikethrough: a.strikethrough === true,
    underline: a.underline === true,
    code: a.code === true,
    color: a.color ?? "default",
  };
}

function linkOf(item: RichTextItem): string | null {
  return item.text?.link?.url ?? null;
}

/** 서식을 입힌다 — 안쪽부터 코드 · 취소선 · 기울임 · 굵게 · 링크 · span(색 · 밑줄). */
function decorate(item: RichTextItem, inner: string, code: boolean): string {
  const a = annotationsOf(item);
  let out = code ? `\`${inner}\`` : inner;
  if (a.strikethrough) out = `~~${out}~~`;
  if (a.italic) out = `*${out}*`;
  if (a.bold) out = `**${out}**`;
  const link = linkOf(item);
  if (link !== null) out = `[${out}](${link})`;
  const span = [
    colorName(a.color) ? `color="${colorName(a.color)}"` : "",
    a.underline ? 'underline="true"' : "",
  ].filter((s) => s !== "");
  return span.length > 0 ? `<span ${span.join(" ")}>${out}</span>` : out;
}

function plainText(items: readonly RichTextItem[] | undefined): string {
  return (items ?? []).map((t) => t.plain_text ?? t.text?.content ?? "").join("");
}

// ─── 속성 ───

/** 블록의 종류별 몸통(`paragraph` · `callout` …). */
function bodyOf(block: NfmSourceBlock): Record<string, unknown> {
  const body = (block as unknown as Record<string, unknown>)[block.type];
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}

/** 블록 API 의 색 이름 → NFM 색 이름(`yellow_background` → `yellow_bg`). 기본색은 "". */
function colorName(color: unknown): string {
  if (typeof color !== "string" || color === "" || color === "default") return "";
  return color.replace(/_background$/, "_bg");
}

function blockColorAttr(color: unknown): string {
  const name = colorName(color);
  return name ? ` {color="${name}"}` : "";
}

/** 콜아웃 아이콘 — 이모지 · 그림 주소 · Notion 아이콘(`/icons/<이름>_<색>.svg`). 모르는 모양이면 null. */
function calloutIcon(icon: unknown): string | null {
  const value = icon as
    | {
        type?: string;
        emoji?: string;
        external?: { url?: string };
        file?: { url?: string };
        icon?: { name?: string; color?: string };
      }
    | null
    | undefined;
  switch (value?.type) {
    case "emoji":
      return value.emoji ?? null;
    case "external":
      return value.external?.url ?? null;
    case "file":
      return value.file?.url ?? null;
    case "icon":
      return value.icon?.name
        ? `/icons/${value.icon.name}${value.icon.color ? `_${value.icon.color}` : ""}.svg`
        : null;
    default:
      return null;
  }
}

/** 칼럼 너비 — 블록 API 는 비율(0.25), NFM 은 백분율(`ratio="25"`). */
function columnRatio(widthRatio: number): string {
  return ` ratio="${Math.round(widthRatio * 100 * 1000) / 1000}"`;
}

function captionOf(body: Record<string, unknown>): readonly RichTextItem[] {
  return (body.caption as readonly RichTextItem[] | undefined) ?? [];
}

function mediaUrl(body: Record<string, unknown>): string {
  const kind = body.type as string | undefined;
  const source = kind ? (body[kind] as { url?: string } | undefined) : undefined;
  return source?.url ?? "";
}

function pageUrl(id: string): string {
  return `${NOTION_PAGE_URL_PREFIX}${compactNotionId(id)}`;
}

function blockUrl(pageId: string, blockId: string): string {
  return `${pageUrl(pageId)}#${compactNotionId(blockId)}`;
}

function unknownTag(pageId: string, blockId: string, alt: string): string {
  return `<unknown url="${blockUrl(pageId, blockId)}" alt="${alt}"/>`;
}
