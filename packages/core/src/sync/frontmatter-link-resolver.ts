import matter from "gray-matter";
import { stringifyFrontmatter } from "../utils/frontmatter.js";

/** 대시 포함(8-4-4-4-12) 또는 대시 없는 32 hex Notion ID 전체 일치 패턴. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9a-f]{32}$/i;

/**
 * frontmatter 의 relation/people 속성에 박힌 원시 Notion UUID 를 `[[제목]]` 위키링크로 치환한다.
 *
 * 단일 패스 변환 시점에는 relation 대상 페이지가 아직 변환·등록되지 않아 propertyMapper 가
 * UUID 를 그대로 남긴다(예: `작가: 1c013b18-...`). pull 의 마지막 단계인 resolveNotionLinks 는
 * 인라인 DB 까지 모든 변환이 끝나 wikilink 맵이 **완성된 뒤** 실행되므로, 이 시점에 frontmatter
 * UUID 를 해소하면 단일 패스 순서 의존성을 부작용 없이 제거할 수 있다.
 *
 * 규칙:
 * - `idToTitle` 키는 대시 제거(clean) 와 대시 포함(raw) 양형식을 모두 담는다고 가정한다.
 * - 맵에 없는 UUID(미수집 타 DB 대상)는 무손실로 그대로 둔다.
 * - relation 은 스칼라·배열·중첩배열(rollup→relation) 모두 가능하므로 값을 재귀 순회한다.
 * - 해소된 항목이 0 이면 `content` 를 재직렬화하지 않고 원본을 그대로 반환해 churn 을 막는다.
 * - 직렬화는 sealed serializer(stringifyFrontmatter)만 거친다 — 변환 시점과 동일 직렬화기라
 *   미변경 키는 byte-identical 로 round-trip 되어 fixpoint 가 안정적이다.
 */
export function resolveFrontmatterRelations(
  content: string,
  idToTitle: Map<string, string>,
): { content: string; count: number } {
  if (!content.startsWith("---") || idToTitle.size === 0) {
    return { content, count: 0 };
  }

  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(content);
  } catch {
    // frontmatter 파싱 실패(예: 본문 선행 `---` 오인) 시 무손실 패스
    return { content, count: 0 };
  }

  const data = parsed.data as Record<string, unknown>;
  if (!data || Object.keys(data).length === 0) {
    return { content, count: 0 };
  }

  let count = 0;
  const resolveValue = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (!UUID_RE.test(value)) return value;
      const title = idToTitle.get(value.replace(/-/g, ""));
      if (!title) return value;
      count++;
      return `[[${title}]]`;
    }
    if (Array.isArray(value)) return value.map(resolveValue);
    return value;
  };

  // gray-matter 는 입력 문자열을 키로 파싱 결과를 캐시한다. `data` 를 in-place 로
  // 수정하면 동일 frontmatter 를 가진 다른 파일이 오염된 캐시 객체를 공유해
  // cross-file 오염이 발생한다. 반드시 새 객체에 결과를 담아 캐시를 건드리지 않는다.
  const resolved: Record<string, unknown> = {};
  for (const key of Object.keys(data)) {
    resolved[key] = resolveValue(data[key]);
  }

  if (count === 0) return { content, count: 0 };
  return { content: stringifyFrontmatter(parsed.content, resolved), count };
}
