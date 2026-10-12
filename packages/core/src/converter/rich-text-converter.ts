/**
 * Notion rich_text → Markdown 인라인 변환 (순수 함수).
 *
 * 블록 변환(block-converter)에서 분리해 단위 테스트 가능하게 한다. 인라인 서식,
 * 수식, 멘션, 색상 보존 마커 등 rich_text 한 배열을 마크다운 문자열로 환원하는
 * 책임만 가진다(SRP). Notion API·notion-to-md 에 의존하지 않는다.
 */
import { compactMarker } from "../constants/markers.js";
import { compactNotionId } from "../utils/id.js";
import { dateMentionText, userMentionText } from "./mention.js";

/** caption 등 서식 없는 rich_text 의 최소 형태. */
export type RichTextItem = { plain_text: string; href?: string | null };

/** annotations·equation·mention 까지 담은 완전한 rich_text 형태. */
export interface RichTextAnnotated extends RichTextItem {
  annotations?: Record<string, unknown>;
  type?: string;
  equation?: { expression: string };
  mention?: {
    type: string;
    page?: { id: string };
    date?: { start: string; end?: string | null; time_zone?: string | null };
    /** `type` 은 `person` · `bot`. */
    user?: { id: string; name?: string; type?: string };
    database?: { id: string };
  };
}

/** rich_text 배열을 서식 없는 평문으로 환원한다(caption 등에 사용). */
export function richTextToPlain(richText: RichTextItem[] | undefined): string {
  if (!richText) return "";
  return richText.map((t) => t.plain_text).join("");
}

/**
 * rich_text 배열을 마크다운으로 환원한다. 인라인 코드/굵게/기울임/취소선/밑줄/링크/
 * 색상(보존 마커)/수식/멘션을 모두 처리한다.
 */
export function richTextToMarkdown(richText: RichTextAnnotated[] | undefined): string {
  if (!richText) return "";
  return richText
    .map((t) => {
      if (t.type === "equation" && t.equation) {
        return `$${t.equation.expression}$`;
      }

      if (t.type === "mention" && t.mention) {
        return formatMention(t.mention, t.plain_text);
      }

      let text = t.plain_text;
      const a = t.annotations;
      if (a?.code) text = `\`${text}\``;
      if (a?.bold) text = `**${text}**`;
      if (a?.italic) text = `*${text}*`;
      if (a?.strikethrough) text = `~~${text}~~`;
      if (a?.underline) text = `<u>${text}</u>`;
      if (t.href) text = `[${text}](${t.href})`;

      const color = a?.color as string | undefined;
      if (color && color !== "default") {
        // 압축형 정본(`%%im-nobsidian:color:X%%text%%/color%%`)으로 통일한다.
        // enhanced-md-converter 의 restoreColorSpans 가 이 형태만 인식하므로, 공백형을
        // 내보내면 블록 폴백 경로의 색상이 push 시 silent 손실된다(rank15/I3).
        text = `${compactMarker(`color:${color}`)}${text}%%/color%%`;
      }

      return text;
    })
    .join("");
}

/**
 * 멘션을 마크다운으로 환원한다. page·database 는 위키링크, 사람 · 날짜는 Markdown API 로 받은 것과
 * 같은 짝 마커(`mention.ts`) — push 가 멘션으로 되돌린다. 짝 마커로 싣지 못하는 사용자 · 날짜는 예전처럼
 * `@이름` · 날짜 글로 둔다. 봇은 글로 둔다 — Markdown API 는 봇 멘션을 아예 내보내지 않는다(실측
 * 2026-10-12). 그 외(link_preview·template_mention·custom_emoji 등)는 빈 문자열로 버리면 본문이
 * 소실되므로 Notion 이 채워주는 plain_text(예: URL, "@오늘")로 보존한다.
 */
export function formatMention(
  mention: NonNullable<RichTextAnnotated["mention"]>,
  plainText: string,
): string {
  switch (mention.type) {
    case "page":
      // 블록 폴백 경로도 markdown-api 경로(convertPageMentions)와 동일한 정규형
      // `[[notion:<32hex>]]` 로 내보낸다. 과거의 `[[<하이픈 id>]]` 는 오케스트레이터의
      // 멘션 해소 정규식과 맞지 않아 제목으로 복원되지 못하고 고아 위키링크로 남았다(rank20/I3).
      return mention.page ? `[[notion:${compactNotionId(mention.page.id)}]]` : plainText;
    case "date": {
      if (!mention.date) return plainText;
      const marked = dateMentionText(mention.date);
      if (marked !== null) return marked;
      const start = mention.date.start;
      return mention.date.end ? `${start} → ${mention.date.end}` : start;
    }
    case "user": {
      const user = mention.user;
      const marked =
        user && user.type !== "bot" ? userMentionText(user.id, user.name ?? undefined) : null;
      if (marked !== null) return marked;
      return user?.name ? `@${user.name}` : plainText || "@user";
    }
    case "database":
      return mention.database ? `[[notion:${compactNotionId(mention.database.id)}]]` : plainText;
    default:
      return plainText;
  }
}

/**
 * 멘션 조각을 볼트 글({@link formatMention})을 담은 글 조각으로 바꾼다 — 블록 폴백(notion-to-md)이 받는
 * 블록에 쓴다. notion-to-md 의 기본 렌더는 멘션을 보이는 글(`@이름` · `2026-09-26T09:00:00.000+09:00` ·
 * 제목 링크)로만 내려, 그 노트를 push 하면 Notion 의 멘션이 글 · 링크가 됐다(A3). 서식은 그대로 둔다.
 * 볼트 글이 보이는 글과 같은 멘션(봇 · 그 밖의 종류)은 건드리지 않는다.
 */
export function markMentions<T extends RichTextAnnotated>(richText: readonly T[]): T[] {
  return richText.map((t) => {
    if (t.type !== "mention" || !t.mention) return t;
    const text = formatMention(t.mention, t.plain_text);
    if (text === t.plain_text) return t;
    return {
      ...t,
      type: "text",
      text: { content: text, link: null },
      mention: undefined,
      plain_text: text,
      href: null,
    };
  });
}
