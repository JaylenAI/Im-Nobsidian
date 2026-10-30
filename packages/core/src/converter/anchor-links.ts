/**
 * 제목 · 블록으로 가는 위키링크(`[[노트#제목]]` · `[[노트#^블록]]` · `[[#제목]]`) ↔ Notion 블록 링크
 * (`https://www.notion.so/<페이지>#<블록>`).
 *
 * - Notion 의 블록 링크는 블록 id 로 가리킨다. 그래서 push 는 대상 페이지의 블록을 읽어 제목 글자 · 블록 id(`^abc`)가
 *   맞는 블록을 찾고, pull 은 블록을 읽어 그 제목 · 블록 id 를 다시 붙인다.
 * - Notion 은 링크의 쿼리를 버리고 `https://app.notion.com/p/<페이지>#<블록>` 으로 돌려준다(2026-10-30 실측). 페이지
 *   멘션에 블록을 붙이면 블록 id 를 페이지 id 로 바꿔 버린다 — 그래서 늘 글자 링크로 보낸다.
 * - 본문을 통째로 바꿔도(`replace_content`) 그대로인 블록 · 고친 문단의 id 는 남는다(2026-10-30 실측). 대상 페이지를
 *   다시 올려도 링크가 끊기지 않는다.
 * - 페이지의 맨 위 블록만 본다 — 콜아웃 · 토글 · 목록 자식 속 제목 · 블록 id 는 찾지 않는다(링크를 글자로 남긴다).
 */
import { compactNotionId } from "../utils/id.js";

/** 링크 대상을 노트와 앵커로 가른다 — `#` 가 없으면 null. 노트 이름에는 `#` 를 쓸 수 없다(Obsidian). */
export function splitAnchor(target: string): { note: string; anchor: string } | null {
  const at = target.indexOf("#");
  if (at < 0) return null;
  const anchor = target.slice(at + 1).trim();
  return anchor === "" ? null : { note: target.slice(0, at).trim(), anchor };
}

/**
 * Obsidian 이 별칭 없는 링크에 보이는 글자 — `[[노트#가#나]]` 는 「노트 > 가 > 나」, `[[#가]]` 는 「가」. push 는 이것을
 * 링크 글자로 보내고, pull 은 링크 글자가 이것이면 별칭을 붙이지 않는다.
 */
export function anchorDisplay(note: string, anchor: string): string {
  return [...(note === "" ? [] : [note]), ...anchor.split("#").map((s) => s.trim())].join(" > ");
}

/**
 * 링크 글자가 Obsidian 이 보이는 글자({@link anchorDisplay})면 그 링크의 대상(`노트#가#나`) — 아니면 null. pull 이 블록
 * 하나로는 알 수 없는 것(노트를 어떤 경로로 적었나 · 어느 제목 아래의 제목인가)을 글자에서 되살린다. 마지막 조각이 블록의
 * 앵커와 같아야 한다.
 *
 * @param notes 그 노트를 적을 수 있는 꼴 — 짧은 이름 · 경로. 자기 노트면 `""` 도.
 */
export function anchorTargetOfDisplay(
  text: string,
  notes: readonly string[],
  anchor: string,
): string | null {
  for (const note of notes) {
    const prefix = note === "" ? "" : `${note} > `;
    if (!text.startsWith(prefix)) continue;
    const segments = text.slice(prefix.length).split(" > ");
    const last = segments[segments.length - 1]!;
    const same = anchor.startsWith("^") ? last === anchor : headingKey(last) === anchor;
    if (same && segments.every((s) => s.trim() !== "")) return `${note}#${segments.join("#")}`;
  }
  return null;
}

/** 블록 링크로 가리킬 수 있는 블록 — 제목이면 그 글자, 아니면 글 끝의 `^블록id` 로 찾는다. */
export interface AnchorBlock {
  readonly id: string;
  readonly heading: boolean;
  /** 블록의 글자(서식 없는). */
  readonly text: string;
}

/** 글 끝의 Obsidian 블록 id — `문단 ^abc-1`. */
const BLOCK_ID_SUFFIX_RE = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/;

/**
 * Obsidian 이 링크의 제목 글자에서 빼는 글자를 빼고 견준다 — 제목 `가: 나` 로 가는 링크는 `[[노트#가 나]]` 다. 공백은
 * 하나로 본다.
 */
function headingKey(text: string): string {
  return text
    .replace(/[#|^:%[\]\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 앵커가 가리키는 블록의 id — 없으면 null.
 *
 * - `^abc` 는 글 끝에 그 블록 id 를 적은 블록.
 * - `가#나` 는 제목 `가` 뒤에 처음 나오는 제목 `나` — Obsidian 처럼 앞 제목부터 차례로 찾는다.
 */
export function anchorBlockId(blocks: readonly AnchorBlock[], anchor: string): string | null {
  if (anchor.startsWith("^")) {
    const id = anchor.slice(1);
    return blocks.find((b) => BLOCK_ID_SUFFIX_RE.exec(b.text)?.[1] === id)?.id ?? null;
  }
  const segments = anchor.split("#").map(headingKey);
  let next = 0;
  let found: string | null = null;
  for (const block of blocks) {
    if (!block.heading || headingKey(block.text) !== segments[next]) continue;
    found = block.id;
    if (++next === segments.length) return found;
  }
  return null;
}

/** 블록을 가리키는 앵커(`#` 뒤) — 제목이면 글자, 글 끝에 블록 id 가 있으면 `^id`. 둘 다 아니면 null. */
export function anchorOfBlock(block: AnchorBlock): string | null {
  if (block.heading) return headingKey(block.text) || null;
  const id = BLOCK_ID_SUFFIX_RE.exec(block.text)?.[1];
  return id === undefined ? null : `^${id}`;
}

/** Notion 블록 → {@link AnchorBlock}. 제목은 `heading_1` ~ `heading_3`(토글 제목 포함). */
export function anchorBlockOf(block: {
  readonly id: string;
  readonly type: string;
  readonly [key: string]: unknown;
}): AnchorBlock {
  const body = block[block.type] as
    { rich_text?: ReadonlyArray<{ plain_text?: string }> } | undefined;
  return {
    id: block.id,
    heading: /^heading_[1-3]$/.test(block.type),
    text: (body?.rich_text ?? []).map((t) => t.plain_text ?? "").join(""),
  };
}

/** `#` 가 든 위키링크(임베드 아님)의 대상 — 그룹 1. 표 칸의 `\|` 별칭 구분자를 받는다. */
const ANCHORED_WIKILINK_RE = /(?<!!)\[\[([^[\]|]*#[^[\]|]*?)\\?(?:\|[^[\]]+)?\]\]/g;

/** 노트의 제목 · 블록 링크의 대상(`노트#제목`) — 코드 안의 것도 든다(대상 페이지를 한 번 더 읽을 뿐이다). */
export function anchoredWikilinkTargets(markdown: string): string[] {
  return [...new Set([...markdown.matchAll(ANCHORED_WIKILINK_RE)].map((m) => m[1]!.trim()))].filter(
    (target) => splitAnchor(target) !== null,
  );
}

/** push 가 보내는 블록 링크. */
export function notionBlockUrl(pageId: string, blockId: string): string {
  return `https://www.notion.so/${compactNotionId(pageId)}#${compactNotionId(blockId)}`;
}

/** push 가 앵커 링크를 풀 때 쓰는 것 — 쓰기 전에 대상 페이지의 블록을 읽어 둔다(변환은 기다리지 않는다). */
export interface AnchorLookup {
  /** 올리는 노트의 페이지 — `[[#제목]]` 의 대상. 아직 만들지 않았으면 null. */
  readonly selfPageId: string | null;
  /** 그 페이지에서 앵커가 가리키는 블록 — 못 찾았으면 null. */
  blockOf(pageId: string, anchor: string): string | null;
}
