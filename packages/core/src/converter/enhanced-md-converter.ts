const NOTION_CALLOUT_RE = /^::: callout\n([\s\S]*?)\n:::/gm;
const NOTION_CALLOUT_TAG_RE = /<callout[^>]*>\n?([\s\S]*?)<\/callout>/g;
const NOTION_TOGGLE_RE = /[\t ]*<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/gs;
const NOTION_PAGE_MENTION_RE = /<mention-page id="([^"]+)">([\s\S]*?)<\/mention-page>/g;
const NOTION_USER_MENTION_RE = /<mention-user id="[^"]*">([^<]*)<\/mention-user>/g;
const NOTION_DATE_MENTION_RE = /<mention-date start="([^"]*)"(?: end="([^"]*)")?[^>]*\/>/g;
const NOTION_UNKNOWN_RE = /<unknown id="([^"]*)"([^>]*)\/>/g;
const NOTION_UNKNOWN_URL_RE = /<unknown url="([^"]*)"([^>]*)\/>/g;

const NOTION_AUDIO_RE = /[\t ]*<audio src="([^"]*)">([\s\S]*?)<\/audio>/g;
const NOTION_VIDEO_RE = /[\t ]*<video src="([^"]*)">([\s\S]*?)<\/video>/g;
const NOTION_PDF_RE = /[\t ]*<pdf src="([^"]*)">([\s\S]*?)<\/pdf>/g;
const NOTION_FILE_RE = /[\t ]*<file src="([^"]*)">([\s\S]*?)<\/file>/g;
const NOTION_TAB_RE = /<tab title="([^"]*)">([\s\S]*?)<\/tab>/g;
const NOTION_UNDERLINE_RE = /<span underline="true">([\s\S]*?)<\/span>/g;

const TOGGLE_START = "%%im-nobsidian:toggle:start%%";
const TOGGLE_END = "%%im-nobsidian:toggle:end%%";

export function notionEnhancedToObsidian(enhanced: string): string {
  let result = enhanced;

  result = convertSyncedBlockRef(result);
  result = normalizeCodeBlockToggles(result);
  result = convertToggles(result);
  result = convertCallouts(result);
  result = convertPageMentions(result);
  result = convertPageLinks(result);
  result = convertUserMentions(result);
  result = convertDateMentions(result);
  result = convertMediaTags(result);
  result = convertTabBlocks(result);
  result = preserveUnknownBlocks(result);
  result = convertNotionMath(result);
  result = convertNotionTables(result);
  result = convertColorSpans(result);
  result = convertUnderlineSpans(result);
  result = convertColumnBlocks(result);
  result = convertDatabaseBlocks(result);
  result = cleanInlineColorAttrs(result);
  result = removeEmptyBlocks(result);
  result = unescapePipes(result);
  result = unescapeNotionChars(result);
  result = ensureCalloutContinuity(result);

  return result;
}

export function obsidianToNotionEnhanced(obsidian: string): string {
  let result = obsidian;

  result = convertTogglesToHtml(result);
  result = restoreTabBlocks(result);
  result = convertObsidianCallouts(result);
  result = restoreMediaTags(result);
  result = restoreUnknownBlocks(result);
  result = restoreColorSpans(result);
  result = restoreUnderlineSpans(result);

  return result;
}

function normalizeCodeBlockToggles(content: string): string {
  return content.replace(
    /^- (.+)\n\t```(\w*)\n([\s\S]*?)\n\t```$/gm,
    (_match, title: string, lang: string, body: string) => {
      const langTag = lang ? lang : "";
      return `<details>\n<summary>${title.trim()}</summary>\n\`\`\`${langTag}\n${body}\n\`\`\`\n</details>`;
    },
  );
}

function convertToggles(content: string): string {
  function replaceToggle(match: string): string {
    const m = /[\t ]*<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/s.exec(match);
    if (!m) return match;

    const title = m[1]!.trim();
    let body = m[2]!.trim();

    body = convertToggles(body);

    const calloutBody = body
      .split("\n")
      .map((line) => (line ? `> ${line}` : ">"))
      .join("\n");
    return `> [!toggle]- ${title}\n${calloutBody}`;
  }

  return content.replace(NOTION_TOGGLE_RE, replaceToggle);
}

function calloutBodyToObsidian(body: string): string {
  const lines = body
    .split("\n")
    .map((l) => l.replace(/^\t/, ""))
    .filter((l, i, arr) => !(i === 0 && l === "") && !(i === arr.length - 1 && l === ""));
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
        .map((line) => (line.trim() ? `> ${line}` : ">"))
        .join("\n")
    : "";

  return calloutTitle + calloutBody;
}

function convertCallouts(content: string): string {
  let result = content.replace(NOTION_CALLOUT_TAG_RE, (_match, body: string) =>
    calloutBodyToObsidian(body),
  );
  result = result.replace(NOTION_CALLOUT_RE, (_match, body: string) => calloutBodyToObsidian(body));
  return result;
}

function convertPageMentions(content: string): string {
  let result = content.replace(NOTION_PAGE_MENTION_RE, (_match, _id: string, text: string) => {
    const cleaned = text.trim();
    return `[[${cleaned}]]`;
  });
  result = result.replace(
    /<mention-page\s+url="https?:\/\/(?:www\.)?notion\.so\/([a-f0-9]{32})"[^>]*\/>/g,
    (_match, id: string) => `[[notion:${id}]]`,
  );
  return result;
}

function convertUserMentions(content: string): string {
  return content.replace(NOTION_USER_MENTION_RE, (_match, name: string) => `@${name}`);
}

function convertDateMentions(content: string): string {
  return content.replace(NOTION_DATE_MENTION_RE, (_match, start: string, end?: string) => {
    return end ? `${start} → ${end}` : start;
  });
}

// 2D: <unknown> → 보존 마커 (삭제 대신 보존)
function preserveUnknownBlocks(content: string): string {
  let result = content.replace(NOTION_UNKNOWN_RE, (_match, id: string, attrs: string) => {
    const typeMatch = /type="([^"]*)"/.exec(attrs);
    const altMatch = /alt="([^"]*)"/.exec(attrs);
    const blockType = altMatch?.[1] ?? typeMatch?.[1] ?? "unknown";
    return `%%im-nobsidian:unknown:id=${id}&type=${blockType}%%`;
  });
  result = result.replace(NOTION_UNKNOWN_URL_RE, (_match, url: string, attrs: string) => {
    const altMatch = /alt="([^"]*)"/.exec(attrs);
    const blockType = altMatch?.[1] ?? "bookmark";
    return `%%im-nobsidian:unknown:id=${encodeURIComponent(url)}&type=${blockType}%%`;
  });
  return result;
}

function convertSyncedBlockRef(content: string): string {
  let result = content.replace(
    /<synced_block_reference[^>]*>[\s\S]*?<\/synced_block_reference>/g,
    (match) => {
      const inner = match
        .replace(/<synced_block_reference[^>]*>\n?/, "")
        .replace(/<\/synced_block_reference>/, "")
        .split("\n")
        .map((l) => l.replace(/^\t/, ""))
        .join("\n")
        .trim();
      return inner;
    },
  );
  result = result.replace(
    /<synced_block[^>]*>\n?([\s\S]*?)<\/synced_block>/g,
    (_match, inner: string) => inner.trim(),
  );
  return result;
}

// 2A: 미디어 태그 → Obsidian 마크다운
function convertMediaTags(content: string): string {
  let result = content;

  result = result.replace(NOTION_AUDIO_RE, (_match, src: string, caption: string) => {
    const cap = caption.trim();
    return cap ? `[🔊 ${cap}](${src})` : `[🔊 audio](${src})`;
  });

  result = result.replace(NOTION_VIDEO_RE, (_match, src: string, caption: string) => {
    const cap = caption.trim();
    return cap ? `[🎬 ${cap}](${src})` : `[🎬 video](${src})`;
  });

  result = result.replace(NOTION_PDF_RE, (_match, src: string, caption: string) => {
    const cap = caption.trim();
    return cap ? `[📄 ${cap}](${src})` : `[📄 pdf](${src})`;
  });

  result = result.replace(NOTION_FILE_RE, (_match, src: string, caption: string) => {
    const cap = caption.trim();
    return cap ? `[📎 ${cap}](${src})` : `[📎 file](${src})`;
  });

  return result;
}

// 2B: <tab> → 보존 마커
function convertTabBlocks(content: string): string {
  return content.replace(NOTION_TAB_RE, (_match, title: string, body: string) => {
    const trimmed = body.trim();
    const indented = trimmed
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    return `> [!tab] ${title}\n${indented}`;
  });
}

// 2C: <span underline> → 보존 마커
function convertUnderlineSpans(content: string): string {
  return content.replace(NOTION_UNDERLINE_RE, (_match, text: string) => {
    return `%%im-nobsidian:underline%%${text}%%/underline%%`;
  });
}

function convertTogglesToHtml(content: string): string {
  const calloutToggleRe = /^> \[!toggle\]-\s*(.+)\n((?:>.*\n?)*)/gm;

  let result = content;
  let prev = "";
  let safety = 0;
  while (result !== prev && safety++ < 100) {
    prev = result;
    result = result.replace(calloutToggleRe, (_match, title: string, body: string) => {
      const bodyText = body
        .split("\n")
        .map((line) => line.replace(/^>\s?/, ""))
        .join("\n")
        .trim();
      return `<details>\n<summary>${title.trim()}</summary>\n\n${bodyText}\n\n</details>`;
    });
  }

  const startRe = new RegExp(escapeRegex(TOGGLE_START), "g");
  const endRe = new RegExp(escapeRegex(TOGGLE_END), "g");

  safety = 0;
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
const NOTION_EMPTY_BLOCK_RE = /^(?:>[\t ]*)*[\t ]*<empty-block\/>\n?/gm;

function convertPageLinks(content: string): string {
  return content.replace(NOTION_PAGE_LINK_RE, (_match, text: string) => {
    const cleaned = text.replace(/\*\*/g, "").trim();
    return `[[${cleaned}]]`;
  });
}

// 2C: <span color> → 보존 마커 (색상 제거 대신 보존)
function convertColorSpans(content: string): string {
  return content.replace(
    NOTION_COLOR_SPAN_RE,
    (_match, color: string, text: string) => `%%im-nobsidian:color:${color}%%${text}%%/color%%`,
  );
}

function convertDatabaseBlocks(content: string): string {
  return content.replace(
    /<database[^>]*>([\s\S]*?)<\/database>/g,
    (_match, title: string) => `**${title.trim()}** *(Notion DB)*`,
  );
}

function cleanInlineColorAttrs(content: string): string {
  return content.replace(/\s*\{color="[^"]*"\}/g, "");
}

function convertColumnBlocks(content: string): string {
  return content.replace(/<columns>\n?([\s\S]*?)<\/columns>/g, (_match, inner: string) => {
    return inner
      .replace(/\t?<column>\n?/g, "")
      .replace(/\t?<\/column>\n?/g, "")
      .trim();
  });
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
  result = result.replace(/\\\$([^$]+?)\\\$/g, (_match, inner: string) => {
    const unescaped = inner.replace(/\\\^/g, "^").replace(/\\~/g, "~");
    return `$${unescaped}$`;
  });
  return result;
}

function unescapeNotionChars(content: string): string {
  return content.replace(/\\~/g, "~").replace(/\\\^/g, "^");
}

const NOTION_TABLE_RE = /<table[^>]*>([\s\S]*?)<\/table>/g;
const TABLE_ROW_RE = /<tr>([\s\S]*?)<\/tr>/g;
const TABLE_CELL_RE = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g;

function isAlignmentRow(cells: string[]): boolean {
  return cells.every((c) => /^:?-{2,}:?$/.test(c.trim()));
}

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
      if (!isAlignmentRow(cells)) {
        rows.push(cells);
      }
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

// ─── Push 방향: 보존 마커 → Enhanced MD 복원 ───

const OBSIDIAN_MEDIA_AUDIO_RE = /\[🔊\s*([^\]]*)\]\(([^)]+)\)/g;
const OBSIDIAN_MEDIA_VIDEO_RE = /\[🎬\s*([^\]]*)\]\(([^)]+)\)/g;
const OBSIDIAN_MEDIA_PDF_RE = /\[📄\s*([^\]]*)\]\(([^)]+)\)/g;
const OBSIDIAN_MEDIA_FILE_RE = /\[📎\s*([^\]]*)\]\(([^)]+)\)/g;

function restoreMediaTags(content: string): string {
  let result = content;

  result = result.replace(OBSIDIAN_MEDIA_AUDIO_RE, (_match, caption: string, src: string) => {
    return `<audio src="${src}">${caption}</audio>`;
  });

  result = result.replace(OBSIDIAN_MEDIA_VIDEO_RE, (_match, caption: string, src: string) => {
    return `<video src="${src}">${caption}</video>`;
  });

  result = result.replace(OBSIDIAN_MEDIA_PDF_RE, (_match, caption: string, src: string) => {
    return `<pdf src="${src}">${caption}</pdf>`;
  });

  result = result.replace(OBSIDIAN_MEDIA_FILE_RE, (_match, caption: string, src: string) => {
    return `<file src="${src}">${caption}</file>`;
  });

  return result;
}

const OBSIDIAN_TAB_RE = /^> \[!tab\]\s*(.+)\n((?:> .*\n?)*)/gm;

function restoreTabBlocks(content: string): string {
  return content.replace(OBSIDIAN_TAB_RE, (_match, title: string, body: string) => {
    const unquoted = body
      .split("\n")
      .map((line) => line.replace(/^> /, ""))
      .join("\n")
      .trim();
    return `<tab title="${title}">${unquoted}</tab>`;
  });
}

const OBSIDIAN_UNKNOWN_RE = /%%im-nobsidian:unknown:id=([^&]+)&type=([^%]+)%%/g;

function restoreUnknownBlocks(content: string): string {
  return content.replace(OBSIDIAN_UNKNOWN_RE, (_match, id: string, type: string) => {
    const decoded = decodeURIComponent(id);
    if (decoded.startsWith("http")) {
      return `<unknown url="${decoded}" alt="${type}"/>`;
    }
    return `<unknown id="${id}" type="${type}"/>`;
  });
}

const OBSIDIAN_COLOR_RE = /%%im-nobsidian:color:([^%]+)%%([\s\S]*?)%%\/color%%/g;

function restoreColorSpans(content: string): string {
  return content.replace(OBSIDIAN_COLOR_RE, (_match, color: string, text: string) => {
    return `<span color="${color}">${text}</span>`;
  });
}

const OBSIDIAN_UNDERLINE_RE = /%%im-nobsidian:underline%%([\s\S]*?)%%\/underline%%/g;

function restoreUnderlineSpans(content: string): string {
  return content.replace(OBSIDIAN_UNDERLINE_RE, (_match, text: string) => {
    return `<span underline="true">${text}</span>`;
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

function ensureCalloutContinuity(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "" && i > 0 && i < lines.length - 1) {
      const prev = result[result.length - 1] ?? "";
      const next = lines[i + 1] ?? "";
      if (/^>/.test(prev) && /^>/.test(next) && !/^> \[!/.test(next)) {
        result.push(">");
        continue;
      }
    }
    result.push(line);
  }
  return result.join("\n");
}
