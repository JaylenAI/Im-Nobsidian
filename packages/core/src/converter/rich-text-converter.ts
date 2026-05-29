/**
 * Notion rich_text → Markdown 인라인 변환 (순수 함수).
 *
 * 블록 변환(block-converter)에서 분리해 단위 테스트 가능하게 한다. 인라인 서식,
 * 수식, 멘션, 색상 보존 마커 등 rich_text 한 배열을 마크다운 문자열로 환원하는
 * 책임만 가진다(SRP). Notion API·notion-to-md 에 의존하지 않는다.
 */
import { spacedMarker, SPACED_END } from "../constants/markers.js";

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
    date?: { start: string; end?: string | null };
    user?: { id: string; name?: string };
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
        text = `${spacedMarker(`color:${color}`)}${text}${SPACED_END}`;
      }

      return text;
    })
    .join("");
}

/**
 * 멘션을 마크다운으로 환원한다. page·database 는 위키링크, date 는 날짜 문자열,
 * user 는 `@이름`. 그 외(link_preview·template_mention·custom_emoji 등)는 빈 문자열로
 * 버리면 본문이 소실되므로 Notion 이 채워주는 plain_text(예: URL, "@오늘")로 보존한다.
 */
export function formatMention(
  mention: NonNullable<RichTextAnnotated["mention"]>,
  plainText: string,
): string {
  switch (mention.type) {
    case "page":
      return mention.page ? `[[${mention.page.id}]]` : plainText;
    case "date": {
      if (!mention.date) return plainText;
      const start = mention.date.start;
      return mention.date.end ? `${start} → ${mention.date.end}` : start;
    }
    case "user":
      return mention.user?.name ? `@${mention.user.name}` : plainText || "@user";
    case "database":
      return mention.database ? `[[${mention.database.id}]]` : plainText;
    default:
      return plainText;
  }
}
