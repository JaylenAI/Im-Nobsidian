/**
 * DB 속성의 «만드는 법» — Notion 이 돌려준 속성 정의에서 같은 속성을 다시 만드는 데 드는 것만 남긴다
 * (ADR-036). 사이드카가 이것을 적고, push 가 이것으로 DB 를 만든다.
 *
 * 남기지 않는 것: 속성 · 옵션 · 그룹의 id(DB 마다 다르다), 옵션 설명, relation 의 data source id 와 맞짝
 * 속성 id(만든 DB 에서 새로 정해진다). 키는 Notion 의 것 그대로다 — 만들 때 그대로 보낸다.
 *
 * 실측(2026-10-23, API 2025-09-03): formula 는 `prop("수") * 2` 처럼 다시 보낼 수 있는 식으로, rollup 은
 * 이름으로 온다.
 */
export type PropertyDefinition = Readonly<Record<string, unknown>>;

interface RawOption {
  readonly id?: string;
  readonly name?: string;
  readonly color?: string;
}

/** 이 속성을 다시 만드는 데 드는 타입별 설정. 타입 이름만으로 만들 수 있으면 undefined. */
export function propertyDefinitionOf(
  prop: Readonly<Record<string, unknown>>,
): PropertyDefinition | undefined {
  const type = prop.type;
  if (typeof type !== "string") return undefined;
  const body = prop[type] as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object") return undefined;

  switch (type) {
    case "number":
      return typeof body.format === "string" ? { format: body.format } : undefined;
    case "select":
    case "multi_select":
      return { options: optionsOf(body.options) };
    case "status": {
      const raw = Array.isArray(body.options) ? (body.options as RawOption[]) : [];
      const nameOf = new Map(raw.map((o) => [o.id, o.name]));
      const groups = Array.isArray(body.groups)
        ? (body.groups as Array<{ name?: string; color?: string; option_ids?: string[] }>).map(
            (g) => ({
              name: g.name ?? "",
              ...(g.color ? { color: g.color } : {}),
              options: (g.option_ids ?? [])
                .map((id) => nameOf.get(id))
                .filter((n): n is string => typeof n === "string"),
            }),
          )
        : [];
      return { options: optionsOf(raw), groups };
    }
    case "formula":
      return typeof body.expression === "string" ? { expression: body.expression } : undefined;
    case "relation": {
      if (typeof body.database_id !== "string") return undefined;
      const dual = body.dual_property as { synced_property_name?: string } | undefined;
      return {
        database_id: body.database_id.replace(/-/g, ""),
        type: body.type === "dual_property" ? "dual_property" : "single_property",
        ...(body.type === "dual_property" && dual?.synced_property_name
          ? { synced_property_name: dual.synced_property_name }
          : {}),
      };
    }
    case "rollup":
      return {
        relation_property_name: body.relation_property_name,
        rollup_property_name: body.rollup_property_name,
        function: body.function,
      };
    case "unique_id":
      return typeof body.prefix === "string" && body.prefix ? { prefix: body.prefix } : undefined;
    default:
      return undefined;
  }
}

function optionsOf(raw: unknown): Array<{ name: string; color?: string }> {
  if (!Array.isArray(raw)) return [];
  return (raw as RawOption[])
    .filter((o) => typeof o.name === "string" && o.name.length > 0)
    .map((o) => ({ name: o.name!, ...(o.color ? { color: o.color } : {}) }));
}
