const NOTION_CALLOUT_RE = /^::: callout\n([\s\S]*?)\n:::/gm;
const NOTION_TOGGLE_RE = /<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gs;
const NOTION_PAGE_MENTION_RE = /<mention-page id="([^"]+)">([\s\S]*?)<\/mention-page>/g;
const NOTION_USER_MENTION_RE = /<mention-user id="[^"]*">([^<]*)<\/mention-user>/g;
const NOTION_DATE_MENTION_RE = /<mention-date start="([^"]*)"(?: end="([^"]*)")?[^>]*\/>/g;
const NOTION_UNKNOWN_RE = /<unknown id="[^"]*"[^>]*\/>/g;

const TOGGLE_START = "%%im-nobsidian:toggle:start%%";
const TOGGLE_END = "%%im-nobsidian:toggle:end%%";

export function notionEnhancedToObsidian(enhanced: string): string {
  let result = enhanced;

  result = convertToggles(result);
  result = convertCallouts(result);
  result = convertPageMentions(result);
  result = convertPageLinks(result);
  result = convertUserMentions(result);
  result = convertDateMentions(result);
  result = removeUnknownBlocks(result);
  result = convertNotionMath(result);
  result = convertNotionTables(result);
  result = convertColorSpans(result);
  result = removeEmptyBlocks(result);
  result = unescapePipes(result);

  return result;
}

export function obsidianToNotionEnhanced(obsidian: string): string {
  let result = obsidian;

  result = convertTogglesToHtml(result);
  result = convertObsidianCallouts(result);

  return result;
}

function convertToggles(content: string): string {
  function replaceToggle(match: string): string {
    const m = /<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/s.exec(match);
    if (!m) return match;

    const title = m[1]!.trim();
    let body = m[2]!.trim();

    body = convertToggles(body);

    const indented = body
      .split("\n")
      .map((line) => (line ? `  ${line}` : ""))
      .join("\n")
      .trimEnd();

    return `${TOGGLE_START}\n- ${title}\n${indented}\n${TOGGLE_END}`;
  }

  return content.replace(NOTION_TOGGLE_RE, replaceToggle);
}

function convertCallouts(content: string): string {
  return content.replace(NOTION_CALLOUT_RE, (_match, body: string) => {
    const lines = body.trim().split("\n");
    const firstLine = lines[0] ?? "";

    const emojiMatch = /^([\p{Emoji}️‍]+)\s*(.*)/u.exec(firstLine);
    const type = emojiMatch ? emojiToCalloutType(emojiMatch[1]!) : "note";
    const title = emojiMatch ? emojiMatch[2]! : firstLine;
    const rest = lines.slice(1).join("\n").trim();

    const calloutTitle = title ? `> [!${type}] ${title}` : `> [!${type}]`;
    const calloutBody = rest
      ? "\n" +
        rest
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")
      : "";

    return calloutTitle + calloutBody;
  });
}

function convertPageMentions(content: string): string {
  return content.replace(NOTION_PAGE_MENTION_RE, (_match, _id: string, text: string) => {
    const cleaned = text.trim();
    return `[[${cleaned}]]`;
  });
}

function convertUserMentions(content: string): string {
  return content.replace(NOTION_USER_MENTION_RE, (_match, name: string) => `@${name}`);
}

function convertDateMentions(content: string): string {
  return content.replace(NOTION_DATE_MENTION_RE, (_match, start: string, end?: string) => {
    return end ? `${start} → ${end}` : start;
  });
}

function removeUnknownBlocks(content: string): string {
  return content.replace(NOTION_UNKNOWN_RE, "");
}

function convertTogglesToHtml(content: string): string {
  const startRe = new RegExp(escapeRegex(TOGGLE_START), "g");
  const endRe = new RegExp(escapeRegex(TOGGLE_END), "g");

  let result = content;
  let safety = 0;

  while (result.includes(TOGGLE_START) && safety++ < 100) {
    const startIdx = result.indexOf(TOGGLE_START);
    const endIdx = findMatchingEnd(result, startIdx + TOGGLE_START.length);
    if (endIdx === -1) break;

    const inner = result.slice(startIdx + TOGGLE_START.length, endIdx).trim();
    const titleMatch = /^- (.+)$/m.exec(inner);
    const title = titleMatch ? titleMatch[1]! : "";
    const body = inner
      .split("\n")
      .slice(1)
      .map((line) => line.replace(/^ {2}/, ""))
      .join("\n")
      .trim();

    const html = `<details>\n<summary>${title}</summary>\n\n${body}\n\n</details>`;
    result = result.slice(0, startIdx) + html + result.slice(endIdx + TOGGLE_END.length);
  }

  result = result.replace(startRe, "").replace(endRe, "");
  return result;
}

function findMatchingEnd(content: string, startFrom: number): number {
  let depth = 1;
  let pos = startFrom;

  while (pos < content.length && depth > 0) {
    const nextStart = content.indexOf(TOGGLE_START, pos);
    const nextEnd = content.indexOf(TOGGLE_END, pos);

    if (nextEnd === -1) return -1;

    if (nextStart !== -1 && nextStart < nextEnd) {
      depth++;
      pos = nextStart + TOGGLE_START.length;
    } else {
      depth--;
      if (depth === 0) return nextEnd;
      pos = nextEnd + TOGGLE_END.length;
    }
  }

  return -1;
}

function convertObsidianCallouts(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const headerMatch = /^> \[!(\w+)\]([-+])?\s*(.*)/.exec(lines[i]!);
    if (headerMatch) {
      const type = headerMatch[1]!;
      const title = headerMatch[3]!;
      const emoji = calloutTypeToEmoji(type) ?? "💡";
      const calloutTitle = title ? `${emoji} ${title}` : emoji;

      const bodyLines: string[] = [];
      i++;
      while (i < lines.length && lines[i]!.startsWith("> ")) {
        bodyLines.push(lines[i]!.slice(2));
        i++;
      }

      result.push("::: callout");
      result.push(calloutTitle);
      if (bodyLines.length > 0) {
        result.push(...bodyLines);
      }
      result.push(":::");
    } else {
      result.push(lines[i]!);
      i++;
    }
  }

  return result.join("\n");
}

const EMOJI_TYPE_MAP: Record<string, string> = {
  "💡": "tip",
  ℹ️: "info",
  "⚠️": "warning",
  "🔥": "danger",
  "✅": "success",
  "❌": "failure",
  "❓": "question",
  "📝": "note",
  "📌": "abstract",
  "🐛": "bug",
  "💬": "quote",
  "📋": "example",
};

const TYPE_EMOJI_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(EMOJI_TYPE_MAP).map(([k, v]) => [v, k]),
);

function emojiToCalloutType(emoji: string): string {
  return EMOJI_TYPE_MAP[emoji] ?? "note";
}

function calloutTypeToEmoji(type: string): string | undefined {
  return TYPE_EMOJI_MAP[type.toLowerCase()];
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NOTION_PAGE_LINK_RE = /<page url="[^"]*">([\s\S]*?)<\/page>/g;
const NOTION_COLOR_SPAN_RE = /<span color="([^"]+)">([\s\S]*?)<\/span>/g;
const NOTION_EMPTY_BLOCK_RE = /^<empty-block\/>\n?/gm;

function convertPageLinks(content: string): string {
  return content.replace(NOTION_PAGE_LINK_RE, (_match, text: string) => {
    const cleaned = text.replace(/\*\*/g, "").trim();
    return `[[${cleaned}]]`;
  });
}

function convertColorSpans(content: string): string {
  return content.replace(NOTION_COLOR_SPAN_RE, (_match, _color: string, text: string) => text);
}

function removeEmptyBlocks(content: string): string {
  return content.replace(NOTION_EMPTY_BLOCK_RE, "\n");
}

const NOTION_INLINE_MATH_RE = /\$`([^`]+)`\$/g;
const NOTION_BLOCK_MATH_RE = /\$\$\n```\n([\s\S]*?)\n```\n\$\$/g;

function convertNotionMath(content: string): string {
  let result = content.replace(NOTION_BLOCK_MATH_RE, (_match, eq: string) => {
    return `$$\n${eq.trim()}\n$$`;
  });
  result = result.replace(NOTION_INLINE_MATH_RE, (_match, eq: string) => `$${eq}$`);
  return result;
}

const NOTION_TABLE_RE = /<table[^>]*>([\s\S]*?)<\/table>/g;
const TABLE_ROW_RE = /<tr>([\s\S]*?)<\/tr>/g;
const TABLE_CELL_RE = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g;

function convertNotionTables(content: string): string {
  return content.replace(NOTION_TABLE_RE, (_match, tableBody: string) => {
    const rows: string[][] = [];
    let rowMatch: RegExpExecArray | null;
    const rowRe = new RegExp(TABLE_ROW_RE.source, TABLE_ROW_RE.flags);

    while ((rowMatch = rowRe.exec(tableBody)) !== null) {
      const cells: string[] = [];
      let cellMatch: RegExpExecArray | null;
      const cellRe = new RegExp(TABLE_CELL_RE.source, TABLE_CELL_RE.flags);
      while ((cellMatch = cellRe.exec(rowMatch[1]!)) !== null) {
        cells.push(cellMatch[1]!.trim());
      }
      rows.push(cells);
    }

    if (rows.length === 0) return _match;

    const colCount = Math.max(...rows.map((r) => r.length));
    const lines: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const padded = rows[i]!;
      while (padded.length < colCount) padded.push("");
      lines.push(`| ${padded.join(" | ")} |`);
      if (i === 0) {
        lines.push(`| ${padded.map(() => "---").join(" | ")} |`);
      }
    }

    return lines.join("\n");
  });
}

function unescapePipes(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let inTable = false;

  for (const line of lines) {
    if (/^\|.*\|$/.test(line.trim()) || /^\|[\s-|]+\|$/.test(line.trim())) {
      inTable = true;
      result.push(line);
    } else {
      if (inTable && line.trim() === "") {
        inTable = false;
      } else if (!/^\|/.test(line.trim())) {
        inTable = false;
      }
      result.push(inTable ? line : line.replace(/\\\|/g, "|"));
    }
  }

  return result.join("\n");
}
