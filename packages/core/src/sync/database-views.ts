/**
 * 사이드카의 보기를 새 DB 에 만들 요청으로 바꾼다(ADR-036) — I/O 없는 규칙만. 보내는 일은 `database-creator.ts`.
 *
 * 보기 설정은 속성을 id 로 가리킨다. 받아 온 DB 의 id → 사이드카의 속성 이름 → 새 DB 의 id 로 바꾼다.
 * 보기의 id 는 `}TfS` 처럼 풀린 꼴, 속성 목록의 id 는 `%7DTfS` 처럼 인코딩된 꼴로 온다 — 풀어서 맞춘다.
 *
 * 2026-10-23 실측(API 2025-09-03): `views.create` 는 `database_id` 와 `data_source_id` 를 함께 받고, 보낸 필터 ·
 * 정렬 · 그룹 · 날짜 속성 그대로 만든다. DB 의 마지막 보기는 지울 수 없다 — 만든 뒤에 기본 보기를 지운다.
 */
import type { ViewRequest } from "../types/view.js";
import type { SidecarSchema, SidecarSchemaView } from "./database-schema.js";

export interface ViewPlan {
  readonly requests: readonly ViewRequest[];
  /** 만들지 않는 보기와 이유. */
  readonly skipped: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
}

/** 값이 속성 id 인 키 — 필터 · 그룹 · 날짜 · 표지 · 지도 · 차트 축. */
const PROPERTY_ID_KEYS = new Set([
  "property",
  "property_id",
  "date_property_id",
  "end_date_property_id",
  "map_by",
  "x_axis_property_id",
  "y_axis_property_id",
]);

/** 열 목록 — 새 DB 에 없는 속성의 열은 빼고 보기는 만든다. */
const COLUMN_LIST_KEYS = new Set(["properties", "table_properties"]);

/** 대시보드는 다른 보기를 위젯으로 담는다 — 위젯은 옮기지 않는다. */
const UNSUPPORTED_TYPES: Readonly<Record<string, string>> = {
  dashboard: "대시보드의 위젯은 옮기지 않는다 — Notion 에서 다시 꾸미세요",
};

class MissingProperty extends Error {
  constructor(readonly propertyName: string) {
    super(propertyName);
  }
}

/**
 * 사이드카의 보기를 차례대로 요청으로 바꾼다.
 *
 * @param target 새 DB 의 속성(이름 → `{ id }`) — `dataSources.retrieve` 가 돌려준 꼴
 */
export function planViews(
  schema: SidecarSchema,
  target: Readonly<Record<string, { readonly id?: unknown }>>,
): ViewPlan {
  const nameOf = new Map<string, string>();
  for (const prop of schema.properties) if (prop.id) nameOf.set(decodeId(prop.id), prop.name);
  const newIdOf = (sourceId: string): string => {
    const name = nameOf.get(decodeId(sourceId));
    const id = name === undefined ? undefined : target[name]?.id;
    if (typeof id !== "string") throw new MissingProperty(name ?? sourceId);
    return decodeId(id);
  };

  const requests: ViewRequest[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const view of schema.views) {
    const unsupported = UNSUPPORTED_TYPES[view.type];
    if (unsupported) {
      skipped.push({ name: view.name, reason: unsupported });
      continue;
    }
    try {
      const request = requestOf(view, newIdOf);
      if (request) requests.push(request);
      else
        skipped.push({
          name: view.name,
          reason: "사이드카에 보기 설정이 없다 — 원래 DB 를 다시 pull 하면 적힌다",
        });
    } catch (error) {
      if (!(error instanceof MissingProperty)) throw error;
      skipped.push({
        name: view.name,
        reason: `새 DB 에 없는 속성(${error.propertyName})을 가리킨다`,
      });
    }
  }
  return { requests, skipped };
}

function requestOf(view: SidecarSchemaView, newIdOf: (id: string) => string): ViewRequest | null {
  const { filter, sorts, quickFilters, configuration } = view.config;
  if (!configuration || typeof configuration !== "object") return null;

  const remapped: Record<string, unknown> = {
    name: view.name,
    type: view.type,
  };
  if (filter !== undefined && filter !== null) remapped.filter = remap(filter, newIdOf);
  if (Array.isArray(sorts) && sorts.length > 0) {
    const kept = dropMissing(sorts, newIdOf);
    if (kept.length > 0) remapped.sorts = kept;
  }
  if (quickFilters && typeof quickFilters === "object") {
    const kept: Record<string, unknown> = {};
    for (const [id, condition] of Object.entries(quickFilters)) {
      try {
        kept[newIdOf(id)] = condition;
      } catch (error) {
        if (!(error instanceof MissingProperty)) throw error;
      }
    }
    if (Object.keys(kept).length > 0) remapped.quick_filters = kept;
  }
  remapped.configuration = acceptedByCreate(
    remap(configuration, newIdOf) as Record<string, unknown>,
  );
  return remapped as unknown as ViewRequest;
}

/**
 * 받아 온 보기 설정 중 `views.create` 가 거절하는 값을 같은 뜻의 받는 값으로 — 2026-10-23 전체 E2E 에서 보기
 * 306개가 이 둘 때문에만 만들어지지 않았다.
 *
 * - `frozen_column_index: -1` 은 「고정한 열 없음」 이다. 만들 때는 0 이상만 받는다 — 빼면 같은 뜻
 * - 표지 `page_content_first` 는 응답에만 있다(SDK 의 요청 타입은 `page_cover | page_content | property`).
 *   가장 가까운 `page_content` 로
 */
function acceptedByCreate(configuration: Record<string, unknown>): Record<string, unknown> {
  const out = { ...configuration };
  if (typeof out.frozen_column_index === "number" && out.frozen_column_index < 0) {
    delete out.frozen_column_index;
  }
  const cover = out.cover as Record<string, unknown> | undefined;
  if (cover?.type === "page_content_first") out.cover = { ...cover, type: "page_content" };
  return out;
}

/** 속성 id 를 새 DB 의 것으로. 없는 속성을 가리키면 {@link MissingProperty} — 열 목록만 그 열을 뺀다. */
function remap(value: unknown, newIdOf: (id: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => remap(item, newIdOf));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) continue;
    if (PROPERTY_ID_KEYS.has(key) && typeof item === "string") out[key] = newIdOf(item);
    else if (COLUMN_LIST_KEYS.has(key) && Array.isArray(item))
      out[key] = dropMissing(item, newIdOf);
    else out[key] = remap(item, newIdOf);
  }
  return out;
}

function dropMissing(items: readonly unknown[], newIdOf: (id: string) => string): unknown[] {
  const kept: unknown[] = [];
  for (const item of items) {
    try {
      kept.push(remap(item, newIdOf));
    } catch (error) {
      if (!(error instanceof MissingProperty)) throw error;
    }
  }
  return kept;
}

function decodeId(id: string): string {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}
