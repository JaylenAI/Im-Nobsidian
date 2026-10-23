/**
 * 사이드카(`<DB>.notion.json`)를 읽어 Notion DB 를 만들 요청으로 바꾼다(ADR-036) — I/O 없는 규칙만.
 * 만드는 차례와 상태는 `database-creator.ts` 가 맡는다.
 *
 * 차례가 있는 까닭(2026-10-23 실측):
 * - status 는 DB 를 만든 뒤 data source 갱신으로 더한다. 옵션마다 `group` 으로 그룹을 정한다(API 2026-06-22 ·
 *   실측: 새 속성 · 기본 옵션에 더하기 · 옮기기 모두 된다). 그룹 셋의 이름 · 차례는 바꿀 수 없다.
 * - relation 은 대상 DB 가 있어야 하고, rollup 은 그 relation 이, formula 는 식이 가리키는 속성이 있어야 한다.
 */
import { DEFAULT_TITLE_PROPERTY } from "../types/config.js";
import { compactNotionId } from "../utils/id.js";
import { SIDECAR_GENERATOR } from "../view/sidecar-generator.js";

/** 사이드카에서 읽은 DB 하나. v1(옵션 이름만)과 v2(설정까지)를 같은 모양으로 읽는다. */
export interface SidecarSchema {
  readonly version: number;
  /** 사이드카를 쓴 DB(받아 온 곳) — 하이픈 없는 id. 여기에 쓰지 않는다. */
  readonly databaseId: string;
  readonly title: string;
  readonly isInline: boolean;
  readonly properties: readonly SidecarSchemaProperty[];
  /** 받아 온 DB 의 보기 — 차례대로. 속성 id 는 받아 온 DB 의 것이다. */
  readonly views: readonly SidecarSchemaView[];
  /** DB 의 아이콘 · 커버 · 설명 · 제목 표시 — 사이드카에 적힌 것만. */
  readonly appearance: {
    readonly icon?: string;
    readonly cover?: string;
    readonly description?: string;
    readonly showTitle: boolean;
  };
}

export interface SidecarSchemaProperty {
  readonly name: string;
  /** 받아 온 DB 의 속성 id(인코딩된 꼴) — 보기 설정이 이 id 로 속성을 가리킨다. */
  readonly id?: string;
  readonly type: string;
  readonly options?: readonly string[];
  readonly definition?: Readonly<Record<string, unknown>>;
}

/** 사이드카의 보기 하나 — `config` 는 사이드카에 적힌 그대로(`filter` · `sorts` · `configuration` …). */
export interface SidecarSchemaView {
  readonly name: string;
  readonly type: string;
  readonly config: Readonly<Record<string, unknown>>;
}

/** status 의 그룹 — Notion 이 정해 두고 이름을 바꾸지 못하게 한다. 옵션의 `group` 은 이 가운데 하나다. */
export const NOTION_STATUS_GROUPS: readonly string[] = ["To-do", "In progress", "Complete"];

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
  "place",
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
  if (s.generator !== SIDECAR_GENERATOR || typeof s.databaseId !== "string") return null;
  if (!Array.isArray(s.properties)) return null;
  const properties = (s.properties as Array<Record<string, unknown>>)
    .filter((p) => typeof p.name === "string" && typeof p.type === "string")
    .map((p): SidecarSchemaProperty => ({
      name: p.name as string,
      ...(typeof p.id === "string" ? { id: p.id } : {}),
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
    appearance: appearanceOf(s.appearance),
    properties,
    views: Array.isArray(s.views)
      ? (s.views as Array<Record<string, unknown>>)
          .filter((v) => typeof v.name === "string" && typeof v.notionType === "string")
          .map((v) => ({
            name: v.name as string,
            type: v.notionType as string,
            config:
              v.config && typeof v.config === "object" ? (v.config as Record<string, unknown>) : {},
          }))
      : [],
  };
}

function appearanceOf(raw: unknown): SidecarSchema["appearance"] {
  const a = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const text = (key: string) => (typeof a[key] === "string" && a[key] ? { [key]: a[key] } : {});
  return {
    ...text("icon"),
    ...text("cover"),
    ...text("description"),
    showTitle: a.showTitle !== false,
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
    titleProperty = DEFAULT_TITLE_PROPERTY;
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
