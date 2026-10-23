/**
 * 사이드카(`<DB>.notion.json`)를 읽어 Notion DB 를 만들 요청으로 바꾼다(ADR-036) — I/O 없는 규칙만.
 * 만드는 차례와 상태는 `database-creator.ts` 가 맡는다.
 *
 * 차례가 있는 까닭(2026-10-23 실측):
 * - status 는 DB 를 만든 뒤 data source 갱신으로 더한다. 그룹은 API 가 정하지 못한다 — 새 옵션은 늘 To-do 에
 *   들고, 기본 세 옵션({@link NOTION_DEFAULT_STATUS})만 제 그룹에 든다. 옵션 이름도 바꿀 수 없다.
 * - relation 은 대상 DB 가 있어야 하고, rollup 은 그 relation 이, formula 는 식이 가리키는 속성이 있어야 한다.
 */
import { compactNotionId } from "../utils/id.js";

/** 사이드카에서 읽은 DB 하나. v1(옵션 이름만)과 v2(설정까지)를 같은 모양으로 읽는다. */
export interface SidecarSchema {
  readonly version: number;
  /** 사이드카를 쓴 DB(받아 온 곳) — 하이픈 없는 id. 여기에 쓰지 않는다. */
  readonly databaseId: string;
  readonly title: string;
  readonly isInline: boolean;
  readonly properties: readonly SidecarSchemaProperty[];
}

export interface SidecarSchemaProperty {
  readonly name: string;
  readonly type: string;
  readonly options?: readonly string[];
  readonly definition?: Readonly<Record<string, unknown>>;
}

/** Notion 이 status 를 만들 때 넣는 옵션 — 이것만 To-do · In progress · Complete 에 나뉘어 든다. */
export const NOTION_DEFAULT_STATUS: readonly string[] = ["Not started", "In progress", "Done"];

/** DB 를 만든 뒤 더할 status. */
export interface PlannedStatus {
  readonly name: string;
  readonly options: ReadonlyArray<{ readonly name: string; readonly color?: string }>;
  /** 원래 그룹 → 옵션 이름. v1 사이드카면 없다. */
  readonly groups?: ReadonlyArray<{ readonly name: string; readonly options: readonly string[] }>;
}

/** 대상 DB 가 생긴 뒤 붙일 relation. */
export interface PlannedRelation {
  readonly name: string;
  /** 사이드카에 적힌 대상 DB(받아 온 곳의 id, 하이픈 없음). */
  readonly targetDatabaseId: string;
  readonly dual: boolean;
  /** dual 의 맞짝 속성 이름(대상 DB 쪽). */
  readonly syncedName?: string;
}

export interface DatabaseSchemaPlan {
  readonly titleProperty: string;
  /** `databases.create` 의 `initial_data_source.properties`. */
  readonly initial: Record<string, unknown>;
  /** 만든 뒤 바로 더할 status. */
  readonly statuses: readonly PlannedStatus[];
  readonly relations: readonly PlannedRelation[];
  /** relation 이 생긴 뒤 — 이름 → rollup 정의. */
  readonly rollups: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  /** 마지막 — 이름 → formula 요청. */
  readonly formulas: Record<string, unknown>;
  /** 만들지 않는 속성과 이유. */
  readonly skipped: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
}

/** 설정 없이 타입 이름만으로 만드는 속성. */
const PLAIN_TYPES = new Set([
  "rich_text",
  "date",
  "people",
  "files",
  "checkbox",
  "url",
  "email",
  "phone_number",
  "created_time",
  "last_edited_time",
  "created_by",
  "last_edited_by",
]);

/** 사이드카를 읽는다. im-nobsidian 이 쓴 사이드카가 아니거나 읽을 수 없으면 null. */
export function parseSidecarSchema(text: string): SidecarSchema | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (s.generator !== "im-nobsidian" || typeof s.databaseId !== "string") return null;
  if (!Array.isArray(s.properties)) return null;
  const properties = (s.properties as Array<Record<string, unknown>>)
    .filter((p) => typeof p.name === "string" && typeof p.type === "string")
    .map((p): SidecarSchemaProperty => ({
      name: p.name as string,
      type: p.type as string,
      ...(Array.isArray(p.options) ? { options: p.options as string[] } : {}),
      ...(p.definition && typeof p.definition === "object"
        ? { definition: p.definition as Record<string, unknown> }
        : {}),
    }));
  return {
    version: typeof s.schemaVersion === "number" ? s.schemaVersion : 1,
    databaseId: compactNotionId(s.databaseId),
    title: typeof s.databaseName === "string" ? s.databaseName : "",
    isInline: s.isInline === true,
    properties,
  };
}

/** 사이드카의 스키마를 만드는 차례대로 나눈다. */
export function planDatabaseSchema(schema: SidecarSchema): DatabaseSchemaPlan {
  const initial: Record<string, unknown> = {};
  const statuses: PlannedStatus[] = [];
  const relations: PlannedRelation[] = [];
  const rollups = new Map<string, Readonly<Record<string, unknown>>>();
  const formulas: Record<string, unknown> = {};
  const skipped: Array<{ name: string; reason: string }> = [];
  const v1 = `사이드카 v${schema.version} 에는 설정이 없다 — 원래 DB 를 다시 pull 하면 적힌다`;

  let titleProperty = "";
  for (const prop of schema.properties) {
    const def = prop.definition;
    switch (prop.type) {
      case "title":
        if (titleProperty) {
          skipped.push({ name: prop.name, reason: "제목 속성이 둘이다" });
          break;
        }
        titleProperty = prop.name;
        initial[prop.name] = { title: {} };
        break;
      case "number":
        initial[prop.name] = {
          number: typeof def?.format === "string" ? { format: def.format } : {},
        };
        break;
      case "select":
      case "multi_select":
        initial[prop.name] = { [prop.type]: { options: optionsOf(prop) } };
        break;
      case "unique_id":
        initial[prop.name] = {
          unique_id: { prefix: typeof def?.prefix === "string" ? def.prefix : null },
        };
        break;
      case "status":
        statuses.push({
          name: prop.name,
          options: optionsOf(prop),
          ...(Array.isArray(def?.groups) ? { groups: def.groups as PlannedStatus["groups"] } : {}),
        });
        break;
      case "relation":
        if (typeof def?.database_id !== "string") {
          skipped.push({ name: prop.name, reason: v1 });
          break;
        }
        relations.push({
          name: prop.name,
          targetDatabaseId: compactNotionId(def.database_id),
          dual: def.type === "dual_property",
          ...(typeof def.synced_property_name === "string"
            ? { syncedName: def.synced_property_name }
            : {}),
        });
        break;
      case "rollup":
        if (typeof def?.relation_property_name !== "string") {
          skipped.push({ name: prop.name, reason: v1 });
          break;
        }
        rollups.set(prop.name, def);
        break;
      case "formula":
        if (typeof def?.expression !== "string") {
          skipped.push({ name: prop.name, reason: v1 });
          break;
        }
        formulas[prop.name] = { formula: { expression: def.expression } };
        break;
      default:
        if (PLAIN_TYPES.has(prop.type)) initial[prop.name] = { [prop.type]: {} };
        else
          skipped.push({
            name: prop.name,
            reason: `Notion API 가 만들지 못하는 속성(${prop.type})`,
          });
    }
  }
  // 제목 없는 DB 는 없다 — 사이드카가 비었어도 Notion 의 기본 이름으로 만든다.
  if (!titleProperty) {
    titleProperty = "Name";
    initial[titleProperty] = { title: {} };
  }
  return { titleProperty, initial, statuses, relations, rollups, formulas, skipped };
}

/** relation 요청 — 대상 DB 의 data source 로 건다. */
export function relationRequest(relation: PlannedRelation, targetDataSourceId: string): unknown {
  return relation.dual
    ? { relation: { data_source_id: targetDataSourceId, type: "dual_property", dual_property: {} } }
    : {
        relation: {
          data_source_id: targetDataSourceId,
          type: "single_property",
          single_property: {},
        },
      };
}

function optionsOf(prop: SidecarSchemaProperty): Array<{ name: string; color?: string }> {
  const fromDefinition = prop.definition?.options;
  if (Array.isArray(fromDefinition)) {
    return (fromDefinition as Array<{ name?: unknown; color?: unknown }>)
      .filter((o): o is { name: string; color?: unknown } => typeof o.name === "string")
      .map((o) => ({ name: o.name, ...(typeof o.color === "string" ? { color: o.color } : {}) }));
  }
  return (prop.options ?? []).map((name) => ({ name }));
}
