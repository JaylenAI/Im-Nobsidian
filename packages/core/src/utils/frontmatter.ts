import matter from "gray-matter";

/**
 * gray-matter 의 `matter.stringify(file, data)` 는 `file` 이 **문자열**이면 내부에서
 * `matter(file)` 로 본문을 먼저 파싱한다. 본문이 `---` 로 시작하면(Notion divider,
 * 수평선, `---` 로 여는 구획 등) 그 `---…---` 블록을 frontmatter 로 오인해 YAML 로
 * 파싱하다 throw 하고, 결과적으로 frontmatter 생성이 통째로 스킵되어 **속성이 유실**된다.
 *
 * 객체 형태(`{ content }`)로 넘기면 이 재파싱을 건너뛰므로 본문이 무엇으로 시작하든
 * 안전하다. 모든 frontmatter 직렬화는 반드시 이 함수를 거쳐 footgun 을 한 곳에 봉인한다.
 */
export function stringifyFrontmatter(content: string, data: Record<string, unknown>): string {
  const out = matter.stringify(
    { content } as unknown as Parameters<typeof matter.stringify>[0],
    data,
  );
  return unquoteFrontmatterDates(out);
}

const QUOTED_DATE_LINE_RE = /^([ \t]*[^:\n]+:[ \t]*)'(\d{4}-\d{2}-\d{2})'([ \t]*)$/gm;

/**
 * js-yaml 은 `2026-07-14` 평문이 YAML timestamp 로 재해석되는 것을 막으려 작은따옴표로
 * 감싸지만, Obsidian 저작 관행(그리고 Obsidian 의 해석)은 따옴표 없는 날짜다 — 왕복 시
 * `created: 2026-07-14` 가 `created: '2026-07-14'` 로 변해 가짜 diff 를 만든다(D3).
 * 의미가 동일하므로 프론트매터 영역에 한해 원 표기로 되돌린다.
 */
function unquoteFrontmatterDates(out: string): string {
  if (!out.startsWith("---\n")) return out;
  const close = out.indexOf("\n---\n", 3);
  if (close === -1) return out;
  const fmEnd = close + "\n---\n".length;
  const fm = out.slice(0, fmEnd).replace(QUOTED_DATE_LINE_RE, "$1$2$3");
  return fm + out.slice(fmEnd);
}
