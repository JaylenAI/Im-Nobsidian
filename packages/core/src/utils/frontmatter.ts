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

/** {@link splitFrontmatter} 의 결과. */
export interface FrontmatterSplit {
  /** frontmatter 의 키-값. frontmatter 가 없으면 빈 객체. */
  data: Record<string, unknown>;
  /**
   * frontmatter 다음 줄부터의 본문 — 앞뒤 공백을 그대로 둔다. frontmatter 가 없으면 입력 그대로다
   * (맨 앞 BOM 만 뗀다 — gray-matter 와 같다).
   */
  content: string;
  /** 입력이 frontmatter 로 시작했는가. 빈 frontmatter(`---` 두 줄)도 frontmatter 다. */
  hasFrontmatter: boolean;
}

/** 여는 줄 · 닫는 줄 — `---` 뿐인 줄(CRLF 허용). Obsidian 과 같다. */
const DELIMITER_LINE_RE = /^---\r?$/;

/**
 * 노트를 frontmatter 와 본문으로 가른다. 노트의 frontmatter 는 모두 여기서 읽는다 — gray-matter 를
 * 직접 부르지 않는다.
 *
 * Obsidian 과 같은 줄을 여닫는 줄로 본다(1.13.7 `getFrontMatterInfo`): 첫 줄이 `---` 뿐이고, 그
 * 뒤 `---` 뿐인 첫 줄에서 닫힌다. 그 사이 YAML 이 키-값일 때만 frontmatter 다 — Obsidian 도 키-값이
 * 아닌 YAML 은 속성으로 읽지 않는다. 아니면 frontmatter 가 없는 노트다 — 입력 전체가 본문이다.
 * gray-matter 를 그대로 부르면 셋이 틀린다.
 *
 * - **본문이 구분선(`---`)으로 시작하는 노트.** Notion 의 구분선으로 시작하는 페이지를 pull 하면
 *   이렇게 쓰인다. gray-matter 는 닫는 줄이 없으면 본문 전체를, 있으면 다음 구분선까지를 YAML 로
 *   읽어(글 · 목록이 된다) 본문에서 뺀다. push 가 그 페이지의 본문을 지우고 글자 단위 속성 블록을
 *   보냈다. 이 모듈은 그 구간을 본문으로 둔다.
 * - **첫 줄이 `---js` · `---javascript` 인 노트.** gray-matter 는 그 사이를 JavaScript 로 `eval`
 *   한다. pull 은 Notion 의 문단 `---js` 를 그대로 첫 줄로 쓰므로, 남의 Notion 페이지가 이 기기에서
 *   코드를 돌릴 수 있었다. 이 모듈은 첫 줄이 `---` 뿐일 때만 gray-matter 를 부른다.
 * - **캐시(S-13).** 옵션 없이 부르면 파싱 «전에» 캐시 자리를 만든다. 파싱이 실패하면 `data: {}` 인
 *   자리가 남아, 같은 글의 다음 호출은 던지지 않고 «frontmatter 없음» 을 돌려준다. 캐시가 돌려주는
 *   `data` 는 호출마다 같은 객체라, 고치면 같은 글을 가진 다른 노트에 샌다. 캐시는 비워지지도 않는다.
 *   이 모듈은 옵션 객체를 넘겨 캐시를 건너뛴다.
 *
 * YAML 이 깨졌으면 «매번» 던진다 — 읽지 못한 것을 «속성 없음» 으로 바꾸지 않는다. 받는 쪽이 정한다
 * (페이지 변환은 본문으로 보내고, 행은 만들지 않는다).
 */
export function splitFrontmatter(text: string): FrontmatterSplit {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const none: FrontmatterSplit = { data: {}, content: input, hasFrontmatter: false };
  const lines = input.split("\n");
  if (!DELIMITER_LINE_RE.test(lines[0]!)) return none;
  // gray-matter 는 `---` 로 «시작하는» 첫 줄에서 닫는다. 그 줄이 `---` 뿐이 아니면(`----` · `---x`)
  // Obsidian 은 더 내려가 닫지만, 그 사이는 키-값 YAML 일 수 없다(맨 앞 `---` 는 문서 구분이다).
  const close = lines.findIndex((line, i) => i > 0 && line.startsWith("---"));
  if (close === -1 || !DELIMITER_LINE_RE.test(lines[close]!)) return none;

  const data: unknown = matter(input, {}).data;
  if (!isYamlMapping(data)) return none;
  return { data, content: lines.slice(close + 1).join("\n"), hasFrontmatter: true };
}

/** YAML 이 키-값으로 읽혔는가. 글 · 목록 · 날짜(`Date`) · null 은 아니다. */
function isYamlMapping(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * frontmatter 와 앞뒤 공백을 걷은 본문. 본문은 변환 파이프라인(FrontmatterExtractor)과 같다.
 * YAML 이 깨졌으면 «매번» 던진다({@link splitFrontmatter}).
 */
export function parseFrontmatter(content: string): {
  data: Record<string, unknown>;
  body: string;
} {
  const { data, content: body } = splitFrontmatter(content);
  return { data, body: body.trim() };
}
