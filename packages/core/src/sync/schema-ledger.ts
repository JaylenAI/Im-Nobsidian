import type { IStateDB } from "../state/state-db-interface.js";
import type { DatabaseMeta } from "../notion/client.js";
import { RANGE_END_SUFFIX, mayHaveRangeEnd } from "../notion/property-mapper.js";
import { compactNotionId } from "../utils/id.js";

/**
 * DB 마다 지난 pull 이 본 속성 스키마(P3 · ADR-045). Notion 에서 속성 이름을 바꾸면 행 노트에는 옛 키가 «로컬 키» 로
 * 남았다 — 행 페이지의 수정 시각은 그대로라(2026-10-29 실측) 그 행을 다시 받지 않았고, 다시 받아도 옛 이름이 무엇이었는지
 * 몰랐다. 속성 id 는 이름 · 타입을 바꿔도 그대로다(실측) — 그래서 id 로 견준다.
 */
export const DB_SCHEMAS_META_KEY = "db_schemas";

/** 한 data source 의 속성 — 속성 id → 이름 · 타입. 제목 속성은 뺀다(행 노트에서는 `title` 키다). */
export type SourceSchema = Readonly<
  Record<string, { readonly name: string; readonly type: string }>
>;

/** DB 의 data source(하이픈 없는 id) → 그 소스의 속성. 속성 id 는 소스마다 따로 붙는다. */
export type DatabaseSchemaSeen = Readonly<Record<string, SourceSchema>>;

/** 한 data source 에서 지난번 뒤 바뀐 속성 — 행 노트의 키로 적는다. */
export interface SchemaChange {
  /** 옛 키 → 새 키. 날짜 속성은 범위 끝 키(`…_end`)도 함께. */
  readonly renamed: ReadonlyMap<string, string>;
  /** Notion 에서 지운 속성의 키. */
  readonly removed: ReadonlySet<string>;
  /** 새로 생기거나 타입이 바뀐 속성의 키 — 행이 그대로여도 값을 다시 받는다. */
  readonly refreshed: ReadonlySet<string>;
}

/**
 * 받은 DB 의 속성을 소스마다 — 읽지 못한 소스는 뺀다(모르는 것을 «지웠다» 로 보지 않는다). 소스가 없는 옛 DB 는 DB id
 * 하나로. 읽은 소스가 하나도 없으면 null.
 */
export function seenSchemaOf(meta: DatabaseMeta): DatabaseSchemaSeen | null {
  const seen: Record<string, SourceSchema> = {};
  if (meta.dataSources.length === 0) {
    if (Object.keys(meta.properties).length > 0) {
      seen[compactNotionId(meta.databaseId)] = schemaOf(meta.properties);
    }
  } else {
    for (const ds of meta.dataSources) {
      if (ds.properties) seen[compactNotionId(ds.id)] = schemaOf(ds.properties);
    }
  }
  return Object.keys(seen).length > 0 ? seen : null;
}

/** 행이 사는 data source — 부모가 data source 가 아니면(옛 DB) null. */
export function dataSourceIdOf(page: { readonly parent?: unknown }): string | null {
  const parent = page.parent as { type?: string; data_source_id?: string } | undefined;
  return parent?.type === "data_source_id" && parent.data_source_id ? parent.data_source_id : null;
}

/** 행이 사는 data source — {@link seenSchemaOf} 의 키. 옛 DB 의 행은 DB id. */
export function sourceKeyOf(page: { readonly parent?: unknown }, databaseId: string): string {
  return compactNotionId(dataSourceIdOf(page) ?? databaseId);
}

function schemaOf(properties: Readonly<Record<string, unknown>>): SourceSchema {
  const schema: Record<string, { name: string; type: string }> = {};
  for (const [name, raw] of Object.entries(properties)) {
    const prop = raw as { id?: unknown; type?: unknown } | null;
    if (typeof prop?.id !== "string" || typeof prop.type !== "string") continue;
    if (prop.type === "title") continue;
    schema[prop.id] = { name, type: prop.type };
  }
  return schema;
}

/** 지난번에 본 속성과 지금 속성을 id 로 견준다. */
export function diffSourceSchema(before: SourceSchema, after: SourceSchema): SchemaChange {
  const renamed = new Map<string, string>();
  const removed = new Set<string>();
  const refreshed = new Set<string>();
  const withEnd = (name: string, type: string): string[] =>
    mayHaveRangeEnd(type) ? [name, name + RANGE_END_SUFFIX] : [name];

  for (const [id, old] of Object.entries(before)) {
    const now = after[id];
    if (!now) {
      for (const key of withEnd(old.name, old.type)) removed.add(key);
      continue;
    }
    if (now.name !== old.name) {
      renamed.set(old.name, now.name);
      if (mayHaveRangeEnd(old.type) && mayHaveRangeEnd(now.type)) {
        renamed.set(old.name + RANGE_END_SUFFIX, now.name + RANGE_END_SUFFIX);
      }
    }
    if (now.type !== old.type) for (const key of withEnd(now.name, now.type)) refreshed.add(key);
  }
  for (const [id, now] of Object.entries(after)) {
    if (!before[id]) for (const key of withEnd(now.name, now.type)) refreshed.add(key);
  }
  return { renamed, removed, refreshed };
}

export function isEmptySchemaChange(change: SchemaChange): boolean {
  return change.renamed.size === 0 && change.removed.size === 0 && change.refreshed.size === 0;
}

/** 상태 메타에 둔 DB 마다의 스키마. 깨졌거나 없으면 비어 있다 — 이번에 본 것부터 다시 쌓는다. */
export class SchemaLedger {
  constructor(private readonly stateDb: Pick<IStateDB, "getMeta" | "setMeta">) {}

  get(databaseId: string): DatabaseSchemaSeen | undefined {
    return this.load()[compactNotionId(databaseId)];
  }

  /** 이번에 본 소스로 바꾼다 — 이번에 읽지 못한 소스는 지난번 것을 둔다. */
  set(databaseId: string, seen: DatabaseSchemaSeen): void {
    const all = this.load();
    const key = compactNotionId(databaseId);
    const next = { ...all[key], ...seen };
    if (JSON.stringify(all[key]) === JSON.stringify(next)) return;
    all[key] = next;
    this.stateDb.setMeta(DB_SCHEMAS_META_KEY, JSON.stringify(all));
  }

  private load(): Record<string, DatabaseSchemaSeen> {
    const raw = this.stateDb.getMeta(DB_SCHEMAS_META_KEY);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, DatabaseSchemaSeen>)
        : {};
    } catch {
      return {};
    }
  }
}
