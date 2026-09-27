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

/**
 * YAML 이 날짜로 읽은 값(`Date`)을 적힌 모양의 문자열로 되돌린다.
 *
 * gray-matter(js-yaml)는 따옴표 없는 `2026-07-14` 를 UTC 자정의 `Date` 로 읽는다. 그리고
 * 위 {@link unquoteFrontmatterDates} 때문에 pull 이 쓴 날짜는 모두 따옴표가 없다. 속성
 * 변환이 받는 값이 `Date` 면 날짜로 알아보지 못해 **조용히 빠지고**(`String(date)` 는
 * `Tue Jul 14 …`), 같은 날짜라도 한쪽만 따옴표가 있으면 «바뀐 값» 으로 보인다. 자정이면
 * 날짜만, 아니면 ISO 문자열로 돌려준다. 배열 · 객체(`{start, end}`) 안쪽도 같게 바꾼다.
 */
export function plainFrontmatterValue(value: unknown): unknown {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return String(value);
    const iso = value.toISOString();
    return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
  }
  if (Array.isArray(value)) return value.map(plainFrontmatterValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        plainFrontmatterValue(v),
      ]),
    );
  }
  return value;
}

/**
 * frontmatter 와 본문을 가른다. YAML 이 깨졌으면 «매번» 던진다.
 *
 * gray-matter 캐시를 쓰지 않는다(옵션 객체를 넘기면 캐시를 건너뛴다). gray-matter 는 파싱
 * «전에» 캐시에 자리를 만들어 두므로, 파싱이 실패하면 `data: {}` 인 자리가 남고 같은 문자열의
 * 다음 호출은 던지지 않고 그것을 돌려준다. push 는 실패한 항목을 한 번 더 시도하므로, 깨진
 * frontmatter 를 첫 시도에서 거절해도 재시도에서 «속성 없음» 으로 읽혀 행의 속성을 모두
 * 지우는 요청이 나간다. 본문은 변환 파이프라인(FrontmatterExtractor)과 같게 앞뒤 공백을 걷어 낸다.
 */
export function parseFrontmatter(content: string): {
  data: Record<string, unknown>;
  body: string;
} {
  const parsed = matter(content, {});
  return { data: parsed.data as Record<string, unknown>, body: parsed.content.trim() };
}
