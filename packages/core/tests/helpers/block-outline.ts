/**
 * 블록 트리를 견줄 수 있는 줄들로 — 종류 · 속성 · 글(서식 · 링크)만 남긴다. Notion 이 돌려준 블록
 * (id · 만든 시각 · 기본값이 붙는다)과 블록 API 로 보낼 블록을 같은 모양으로 놓고 견준다.
 */
type Json = Record<string, unknown>;

/** 응답에만 붙고 보낼 때는 기본값인 속성 — 견주지 않는다. */
const RESPONSE_ONLY: ReadonlySet<string> = new Set(["list_format", "list_start_index"]);
const BODY_TEXT: ReadonlySet<string> = new Set([
  "rich_text",
  "children",
  "caption",
  "text",
  "cells",
]);

function url(raw: string): string {
  try {
    return new URL(raw).href;
  } catch {
    return raw;
  }
}

/** rich text 를 한 줄로 — 조각마다 `T"글"→링크/서식/색`, 수식은 `EQ[…]`, 멘션은 `@종류`. */
export function richTextOutline(items: readonly Json[] = []): string {
  return items
    .filter((r) => !(r.type === "text" && (r.text as Json).content === ""))
    .map((r) => {
      const a = (r.annotations ?? {}) as Json;
      const flags = ["bold", "italic", "strikethrough", "underline", "code"]
        .filter((k) => a[k] === true)
        .map((k) => k[0])
        .join("");
      const color = typeof a.color === "string" && a.color !== "default" ? a.color : "";
      let seg: string;
      if (r.type === "equation") seg = `EQ[${(r.equation as Json).expression as string}]`;
      else if (r.type === "mention") {
        const m = r.mention as Json;
        seg = `@${m.type as string}`;
        if (m.type === "date") {
          const d = m.date as Json;
          seg += JSON.stringify({ start: d.start, end: d.end ?? null });
        }
      } else {
        const t = r.text as Json;
        const link = (t.link as Json | null | undefined)?.url as string | undefined;
        seg = `T${JSON.stringify(t.content)}${link ? `→${url(link)}` : ""}`;
      }
      return seg + (flags ? `/${flags}` : "") + (color ? `/${color}` : "");
    })
    .join(" + ");
}

/** 블록 트리를 들여쓴 줄들로. */
export function blockOutline(blocks: readonly Json[], depth = 0): string[] {
  const lines: string[] = [];
  const pad = "  ".repeat(depth);
  for (const block of blocks) {
    const type = block.type as string;
    const body = (block[type] ?? {}) as Json;
    if (type === "table_row") {
      lines.push(
        `${pad}row ${(body.cells as Json[][]).map((c) => richTextOutline(c)).join(" | ")}`,
      );
      continue;
    }
    const attrs: Json = {};
    for (const key of Object.keys(body).sort()) {
      const value = body[key];
      if (BODY_TEXT.has(key) || RESPONSE_ONLY.has(key)) continue;
      if (value === null || value === false || value === "default") continue;
      if (Array.isArray(value) && value.length === 0) continue;
      attrs[key] = value;
    }
    if (attrs.external) attrs.external = url((attrs.external as Json).url as string);
    if (type === "file") delete attrs.name;
    if (type === "synced_block") delete attrs.synced_from;
    const caption = body.caption as Json[] | undefined;
    lines.push(
      `${pad}${type} ${JSON.stringify(attrs)} ${richTextOutline(body.rich_text as Json[])}` +
        (caption?.length ? ` cap:${richTextOutline(caption)}` : ""),
    );
    lines.push(...blockOutline((body.children ?? block.children ?? []) as Json[], depth + 1));
  }
  return lines;
}
