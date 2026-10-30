/**
 * 행을 다른 DB 로 옮기면 Notion 이 대상 DB 에 더하는 열 — 옮기기 전에 알린다(결정 D13).
 *
 * 2026-10-30 실측(API 2025-09-03, `pages.move` 를 data source 로):
 *   - 값이 있는 속성 가운데 대상 DB 에 같은 이름이 없는 것이 그 이름의 열로 더해진다
 *   - 같은 이름이 다른 타입이면 `이름 1` 로 더해진다(`Same` select → multi_select 인 DB 에 `Same 1`)
 *   - 빈 값(빈 글 · 빈 목록 · 없는 수 · 거짓 체크박스)은 더하지 않는다
 *   - Notion 이 값을 정하는 속성(수식 · 만든 시각 …)과 제목은 더하지 않는다
 */

/** Notion 이 값을 정하는 속성 — 옮겨도 대상 DB 에 열로 따라가지 않는다(수식 · 만든 시각 실측). */
const COMPUTED_TYPES: ReadonlySet<string> = new Set([
  "formula",
  "rollup",
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
  "unique_id",
  "button",
  "verification",
]);

/** Notion 이 돌려준 속성 값(`{ type, [type]: 값 }`)에 값이 있는가. */
export function hasPropertyValue(property: unknown): boolean {
  if (!property || typeof property !== "object") return false;
  const { type } = property as { type?: unknown };
  if (typeof type !== "string") return false;
  const value = (property as Record<string, unknown>)[type];
  if (value === null || value === undefined) return false;
  if (type === "checkbox") return value === true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

/**
 * 이 행을 대상 DB 로 옮기면 더해질 열 이름 — 대상 스키마의 이름 차례가 아니라 행의 속성 차례.
 *
 * @param rowProperties 지금 행의 속성(Notion 이 돌려준 모양).
 * @param target 대상 DB 의 스키마 — 이름 → 타입.
 */
export function columnsAddedByMove(
  rowProperties: Readonly<Record<string, unknown>>,
  target: Readonly<Record<string, { readonly type: string }>>,
): string[] {
  const added: string[] = [];
  for (const [name, property] of Object.entries(rowProperties)) {
    const type = (property as { type?: unknown } | null)?.type;
    if (typeof type !== "string" || type === "title" || COMPUTED_TYPES.has(type)) continue;
    if (!hasPropertyValue(property)) continue;
    const existing = target[name];
    if (!existing) added.push(name);
    else if (existing.type !== type) added.push(`${name} 1`);
  }
  return added;
}
