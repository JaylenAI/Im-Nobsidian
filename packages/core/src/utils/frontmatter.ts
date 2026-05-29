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
  return matter.stringify({ content } as unknown as Parameters<typeof matter.stringify>[0], data);
}
