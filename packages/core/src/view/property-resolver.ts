import type { BasePropertySchema } from "../types/view.js";

/**
 * 속성 id → 프론트매터 키 해소.
 *
 * Notion `views.retrieve` 는 RAW 속성 id(예: `[jiM`)를 주지만 `databases.retrieve` 스키마는
 * URL-인코딩된 id(예: `%5BjiM`)를 준다. 디코드 후 비교하지 않으면 title 외 모든 속성
 * (cover/order/sort/groupBy/filter)이 매칭에 실패해 조용히 사라진다.
 *
 * `.base` 생성기와 사이드카 생성기가 같은 규칙을 써야 하므로 여기 한 곳에 둔다.
 */
export function resolvePropertyName(
  propertyId: string,
  schema: Record<string, BasePropertySchema>,
): string | undefined {
  const target = decodePropertyId(propertyId);
  for (const [name, prop] of Object.entries(schema)) {
    if (decodePropertyId(prop.id) === target) return name;
  }
  // Notion 필터는 id 대신 속성 **이름**으로 오기도 한다(사용자가 만든 필터의 흔한 형태).
  return schema[propertyId] ? propertyId : undefined;
}

function decodePropertyId(id: string): string {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}
