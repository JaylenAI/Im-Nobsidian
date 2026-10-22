import { splitFrontmatter, stringifyFrontmatter } from "../utils/frontmatter.js";
import { isNotionId } from "../utils/id.js";

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
  if (idToTitle.size === 0) {
    return { content, count: 0 };
  }

  let parsed: ReturnType<typeof splitFrontmatter>;
  try {
    parsed = splitFrontmatter(content);
  } catch {
    // 깨진 frontmatter 는 건드리지 않는다(무손실 패스)
    return { content, count: 0 };
  }

  const data = parsed.data;
  if (Object.keys(data).length === 0) {
    return { content, count: 0 };
  }

  let count = 0;
  const resolveValue = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (!isNotionId(value)) return value;
      const title = idToTitle.get(value.replace(/-/g, ""));
      if (!title) return value;
      count++;
      return `[[${title}]]`;
    }
    if (Array.isArray(value)) return value.map(resolveValue);
    return value;
  };

  // 읽은 값을 고치지 않고 새 객체에 담는다 — 해소가 0 건이면 원본을 그대로 돌려준다.
  const resolved: Record<string, unknown> = {};
  for (const key of Object.keys(data)) {
    resolved[key] = resolveValue(data[key]);
  }

  if (count === 0) return { content, count: 0 };
  return { content: stringifyFrontmatter(parsed.content, resolved), count };
}
