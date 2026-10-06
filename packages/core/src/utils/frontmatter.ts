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
  const astral = maskAstralCharacters(data);
  const out = matter.stringify(
    { content } as unknown as Parameters<typeof matter.stringify>[0],
    astral.data,
  );
  return unquoteFrontmatterDates(mapFrontmatter(out, astral.unmask));
}

/** 사용 영역(U+E000–U+F8FF). js-yaml 3 이 «찍을 수 있는» 문자로 보는 BMP 문자다. */
const PRIVATE_USE_FIRST = 0xe000;
const PRIVATE_USE_LAST = 0xf8ff;
const ASTRAL_RE = /[\u{10000}-\u{10FFFF}]/gu;

/**
 * BMP 밖 문자(이모지 등)를 frontmatter 에 없는 사용 영역 문자로 잠시 바꾼다(F-i).
 *
 * gray-matter 가 쓰는 js-yaml 3 은 BMP 밖 문자를 «찍을 수 없는» 문자로 보고 `icon: "\U0001F680"` 처럼
 * 이스케이프해 적는다. 값은 같지만 사람이 읽을 수 없고, Obsidian 이 적는 `icon: 🚀` 와 글자가 달라 왕복마다
 * 다른 글이 된다. 찍을 수 있는 문자로 바꿔 적게 하면 js-yaml 이 따옴표 · 스타일을 그 문자가 없는 것처럼
 * 고르고(js-yaml 4 와 같다), 적은 뒤 되돌린다. 바꿀 문자가 모자라면 바꾸지 않는다 — 이스케이프로 적힐 뿐
 * 값은 같다.
 */
function maskAstralCharacters(data: Record<string, unknown>): {
  data: Record<string, unknown>;
  unmask: (text: string) => string;
} {
  const strings: string[] = [];
  collectStrings(data, strings);
  const astral = new Set(strings.flatMap((s) => s.match(ASTRAL_RE) ?? []));
  const none = { data, unmask: (text: string) => text };
  if (astral.size === 0) return none;

  const used = new Set(strings.flatMap((s) => [...s]));
  const toMask = new Map<string, string>();
  let next = PRIVATE_USE_FIRST;
  for (const char of astral) {
    while (next <= PRIVATE_USE_LAST && used.has(String.fromCharCode(next))) next++;
    if (next > PRIVATE_USE_LAST) return none;
    toMask.set(char, String.fromCharCode(next++));
  }
  const fromMask = new Map([...toMask].map(([char, mask]) => [mask, char]));
  const masks = new RegExp(`[${[...fromMask.keys()].join("")}]`, "g");
  return {
    data: mapStrings(data, (s) => s.replace(ASTRAL_RE, (char) => toMask.get(char)!)) as Record<
      string,
      unknown
    >,
    unmask: (text) => text.replace(masks, (mask) => fromMask.get(mask)!),
  };
}

/** 키와 값의 모든 글자를 모은다 — 배열 · 객체 안쪽까지. */
function collectStrings(value: unknown, into: string[]): void {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, into));
  else if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      into.push(key);
      collectStrings(item, into);
    }
  }
}

/** 키와 값의 글자를 바꾼 사본. 글자가 아닌 값(`Date` · 수 · null)은 그대로 둔다. */
function mapStrings(value: unknown, map: (s: string) => string): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [map(key), mapStrings(item, map)]),
    );
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

/** frontmatter 영역에만 `map` 을 적용한다 — 본문은 그대로 둔다. */
function mapFrontmatter(out: string, map: (frontmatter: string) => string): string {
  if (!out.startsWith("---\n")) return out;
  const close = out.indexOf("\n---\n", 3);
  if (close === -1) return out;
  const fmEnd = close + "\n---\n".length;
  return map(out.slice(0, fmEnd)) + out.slice(fmEnd);
}

const QUOTED_DATE_LINE_RE =
  /^([ \t]*[^:\n]+:[ \t]*)'(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?)'([ \t]*)$/gm;

/**
 * js-yaml 은 `2026-07-14` 평문이 YAML timestamp 로 재해석되는 것을 막으려 작은따옴표로
 * 감싸지만, Obsidian 저작 관행(그리고 Obsidian 의 해석)은 따옴표 없는 날짜다 — 왕복 시
 * `created: 2026-07-14` 가 `created: '2026-07-14'` 로 변해 가짜 diff 를 만든다(D3).
 * 의미가 동일하므로 프론트매터 영역에 한해 원 표기로 되돌린다.
 *
 * 초가 없는 날짜시각(`2026-07-14T09:30` — Obsidian 날짜시각 속성의 모양, F-08)도 같다. js-yaml 3 은 `:` 가
 * 든 글을 모두 따옴표로 감싸지만, 이 모양은 YAML timestamp 가 아니라(초가 있어야 한다) 따옴표가 없어도
 * 글로 읽힌다. 초가 있는 시각은 따옴표가 없으면 UTC 의 날짜로 읽히므로 그대로 둔다.
 */
function unquoteFrontmatterDates(out: string): string {
  return mapFrontmatter(out, (fm) => fm.replace(QUOTED_DATE_LINE_RE, "$1$2$3"));
}

/**
 * `data` 를 frontmatter 에 적을 YAML 줄들 — {@link stringifyFrontmatter} 와 같은 규칙(이모지 · 날짜의
 * 따옴표)으로. 비었으면 빈 배열.
 */
export function frontmatterLines(data: Record<string, unknown>): string[] {
  const out = stringifyFrontmatter("", data);
  if (!out.startsWith("---\n")) return [];
  const close = out.indexOf("\n---\n", 3);
  return close === -1 ? [] : out.slice(4, close).split("\n");
}

/**
 * YAML 줄들을 frontmatter 로 붙인 노트 — {@link stringifyFrontmatter} 가 적는 것과 같은 모양(여닫는 줄 ·
 * 본문 끝 줄바꿈)이다. 줄은 그대로 둔다 — 로컬 노트에서 살린 빈 줄 · 주석도. 빈 줄뿐이면 본문만.
 */
export function joinFrontmatter(lines: readonly string[], content: string): string {
  const newline = (text: string) => (text.endsWith("\n") ? text : `${text}\n`);
  return lines.some((line) => line.trim())
    ? `---\n${lines.join("\n")}\n---\n${newline(content)}`
    : newline(content);
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
 * 두 frontmatter 값이 같은가 — 글 · 수 · 참거짓 · null 은 엄격히, 목록 · 객체는 안쪽까지(객체의 키 차례는
 * 보지 않는다). YAML 이 `Date` 로 읽은 값은 {@link plainFrontmatterValue} 의 글자로 견준다.
 */
export function sameFrontmatterValue(a: unknown, b: unknown): boolean {
  const pa = plainFrontmatterValue(a);
  const pb = plainFrontmatterValue(b);
  if (pa === pb) return true;
  if (Array.isArray(pa) || Array.isArray(pb)) {
    return (
      Array.isArray(pa) &&
      Array.isArray(pb) &&
      pa.length === pb.length &&
      pa.every((item, i) => sameFrontmatterValue(item, pb[i]))
    );
  }
  if (pa === null || pb === null || typeof pa !== "object" || typeof pb !== "object") return false;
  const ra = pa as Record<string, unknown>;
  const rb = pb as Record<string, unknown>;
  const keys = Object.keys(ra);
  return (
    keys.length === Object.keys(rb).length &&
    keys.every((key) => Object.hasOwn(rb, key) && sameFrontmatterValue(ra[key], rb[key]))
  );
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
  const close = closingLineIndex(lines);
  if (close === -1) return none;

  const data: unknown = matter(input, {}).data;
  if (!isYamlMapping(data)) return none;
  return { data, content: lines.slice(close + 1).join("\n"), hasFrontmatter: true };
}

/**
 * 노트의 frontmatter 줄만 `lines` 로 바꾼다 — 여닫는 줄 · 본문 · 맨 앞 BOM 은 한 글자도 바꾸지 않는다.
 * 노트의 frontmatter 줄이 CRLF 면 바꾼 줄도 CRLF 다. 노트가 frontmatter 로 시작하지 않으면 null.
 *
 * {@link joinFrontmatter} 는 본문을 받아 새 노트를 짓는다 — 본문 끝 줄바꿈 · 닫는 줄 뒤를 그 모양으로
 * 맞춘다. 여기는 이미 있는 노트에서 frontmatter 만 고쳐 쓸 때 쓴다.
 */
export function replaceFrontmatterLines(note: string, lines: readonly string[]): string | null {
  const bom = note.charCodeAt(0) === 0xfeff ? note[0]! : "";
  const noteLines = note.slice(bom.length).split("\n");
  const close = closingLineIndex(noteLines);
  if (close === -1) return null;
  const crlf = noteLines.slice(1, close).some((line) => line.endsWith("\r"));
  const yaml = lines.map((line) => (crlf && !line.endsWith("\r") ? `${line}\r` : line));
  return bom + [noteLines[0]!, ...yaml, ...noteLines.slice(close)].join("\n");
}

/** frontmatter 를 닫는 줄의 차례 — `lines` 는 BOM 을 뗀 노트의 줄이다. frontmatter 로 시작하지 않으면 -1. */
function closingLineIndex(lines: readonly string[]): number {
  if (!DELIMITER_LINE_RE.test(lines[0]!)) return -1;
  // gray-matter 는 `---` 로 «시작하는» 첫 줄에서 닫는다. 그 줄이 `---` 뿐이 아니면(`----` · `---x`)
  // Obsidian 은 더 내려가 닫지만, 그 사이는 키-값 YAML 일 수 없다(맨 앞 `---` 는 문서 구분이다).
  const close = lines.findIndex((line, i) => i > 0 && line.startsWith("---"));
  return close !== -1 && DELIMITER_LINE_RE.test(lines[close]!) ? close : -1;
}

/** YAML 이 키-값으로 읽혔는가. 글 · 목록 · 날짜(`Date`) · null 은 아니다. */
function isYamlMapping(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
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

/**
 * 지난 동기화 사본(`baseSnapshot`)의 frontmatter. 사본이 없거나 YAML 이 깨져 읽지 못하면 null —
 * 모름이다. 비어 있는 것({})과 가른다.
 */
export function snapshotFrontmatter(snapshot: Buffer | null): Record<string, unknown> | null {
  if (!snapshot) return null;
  try {
    return parseFrontmatter(snapshot.toString("utf-8")).data;
  } catch {
    return null;
  }
}
