import type { ViewConfig } from "../types/view.js";
import type { WrittenBasesView } from "../view/base-file-generator.js";
import { parseFrontmatter } from "../utils/frontmatter.js";
import { computeHash } from "../utils/hash.js";

/**
 * pull 이 `.base` 에 쓴 보기 하나의 기록 — push 가 볼트에서 고친 보기를 이것과 견줘 Notion 보기에 올린다(ADR-046).
 *
 * 견주는 값(이름 · 열 · 정렬 · 필터)은 쓴 글자가 아니라 **YAML 로 읽은 값**이다. Obsidian 은 보기를 고치면 `.base` 를
 * 통째로 다시 쓴다 — 주석이 사라지고 키 차례 · 따옴표가 바뀐다(1.13.7 실측). 읽은 값으로 견줘야 그런 차이를 고친 것으로
 * 보지 않는다.
 */
export interface BaseViewRecord {
  readonly viewId: string;
  /** Bases 보기 타입 — 이름을 바꾼 보기를 자리로 찾을 때 같은 타입인지 본다. */
  readonly type: string;
  readonly name: string;
  readonly order?: readonly string[];
  readonly sort?: readonly BasesSort[];
  readonly filters?: unknown;
  /** Notion 필터에 `.base` 로 옮기지 못한 조건이 있었다 — 볼트의 필터로 덮으면 그 조건이 사라진다. */
  readonly lossyFilter?: true;
  /** 그때 Notion 보기의 지문({@link viewFingerprint}) — 그 사이 Notion 에서도 고쳤는지 가른다. */
  readonly notion: string;
}

export interface BasesSort {
  readonly property: string;
  readonly direction: string;
}

/** 보기에서 Notion 에 올리는 값. */
export interface PushableView {
  readonly name: string;
  readonly order?: readonly string[];
  readonly sort?: readonly BasesSort[];
  readonly filters?: unknown;
}

/** 올리는 값 하나 — 결과(`ViewEdit.changed`)에도 이 이름으로 적는다. */
export type PushableField = "name" | "columns" | "sort" | "filter";

/** `.base` 보기에서 Notion 에 올리는 키 — 나머지는 {@link restSignature} 가 지킨다. */
const PUSHABLE_KEYS: readonly string[] = ["name", "order", "sort", "filters"];

/** 읽은 `.base` — 보기 말고의 키와 보기들. */
export interface ParsedBaseFile {
  readonly doc: Readonly<Record<string, unknown>>;
  readonly views: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

/** `.base` 를 YAML 로 읽는다. 읽지 못하거나 `views` 가 목록이 아니면 null. */
export function readBaseFile(text: string): ParsedBaseFile | null {
  let doc: Record<string, unknown>;
  try {
    doc = parseFrontmatter(`---\n${text}\n---\n`).data;
  } catch {
    return null;
  }
  const views = doc["views"] ?? [];
  if (!Array.isArray(views)) return null;
  if (views.some((view) => !view || typeof view !== "object" || Array.isArray(view))) return null;
  return { doc, views: views as Array<Record<string, unknown>> };
}

/** 보기의 올리는 값 — 열 · 정렬의 `note.` 는 떼고(Obsidian 이 붙이기도 한다), 빈 목록은 없는 것으로. */
export function pushableOf(view: Readonly<Record<string, unknown>>): PushableView {
  const order = Array.isArray(view["order"]) ? view["order"].map((c) => columnName(c)) : [];
  const sort = Array.isArray(view["sort"])
    ? (view["sort"] as unknown[]).map((s) => {
        const entry = (s ?? {}) as Record<string, unknown>;
        return {
          property: columnName(entry["property"]),
          direction: String(entry["direction"] ?? "ASC").toUpperCase(),
        };
      })
    : [];
  return {
    name: typeof view["name"] === "string" ? view["name"] : "",
    ...(order.length > 0 ? { order } : {}),
    ...(sort.length > 0 ? { sort } : {}),
    ...(view["filters"] !== undefined && view["filters"] !== null
      ? { filters: view["filters"] }
      : {}),
  };
}

/** 고친 값 — 기록과 볼트의 보기를 견준다. */
export function changedFields(
  record: PushableView,
  edited: PushableView,
): readonly PushableField[] {
  const changed: PushableField[] = [];
  if (record.name !== edited.name) changed.push("name");
  if (canonical(record.order) !== canonical(edited.order)) changed.push("columns");
  if (canonical(record.sort) !== canonical(edited.sort)) changed.push("sort");
  if (canonical(record.filters) !== canonical(edited.filters)) changed.push("filter");
  return changed;
}

/** 열 이름 — `note.점수` 와 `점수` 는 같은 열이다. */
export function columnName(raw: unknown): string {
  const name = String(raw ?? "");
  return name.startsWith("note.") ? name.slice("note.".length) : name;
}

/**
 * `.base` 의 보기들을 기록과 잇는다 — 이름이 같은 것끼리, 남은 것은 같은 자리 · 같은 타입끼리(이름을 바꾼 보기).
 * 돌려주는 목록은 `views` 와 같은 차례이고, 기록과 잇지 못한 보기(볼트에서 더한 보기)는 undefined 다.
 */
export function matchViews(
  records: readonly BaseViewRecord[],
  views: ParsedBaseFile["views"],
): Array<BaseViewRecord | undefined> {
  const used = new Set<string>();
  const out: Array<BaseViewRecord | undefined> = views.map((view) => {
    const found = records.find((r) => !used.has(r.viewId) && r.name === view["name"]);
    if (found) used.add(found.viewId);
    return found;
  });
  views.forEach((view, i) => {
    if (out[i]) return;
    const record = records[i];
    if (record && !used.has(record.viewId) && record.type === view["type"]) {
      used.add(record.viewId);
      out[i] = record;
    }
  });
  return out;
}

/**
 * 올리지 않는 것들의 지문 — 보기 말고의 키, 보기마다 올리는 값을 뺀 나머지, 기록과 잇지 못한 보기. pull 이 쓴 것과
 * 같으면 볼트에서 고친 것은 모두 Notion 에 올라가 다음 pull 이 `.base` 를 다시 써도 잃는 것이 없다.
 */
export function restSignature(
  parsed: ParsedBaseFile,
  matched: ReadonlyArray<BaseViewRecord | undefined>,
): string {
  const without = (from: Readonly<Record<string, unknown>>, keys: readonly string[]) =>
    Object.fromEntries(Object.entries(from).filter(([key]) => !keys.includes(key)));
  const views: Record<string, unknown> = {};
  parsed.views.forEach((view, i) => {
    const key = matched[i] ? `id:${matched[i]!.viewId}` : `new:${String(view["name"])}`;
    views[key] = without(view, PUSHABLE_KEYS);
  });
  return computeHash(canonical({ doc: without(parsed.doc, ["views"]), views }));
}

/**
 * Notion 보기의 지문 — pull 이 본 것과 push 할 때 본 것이 같은가. 이름 · 타입 · 필터 · 정렬 · 설정 원본을 견준다.
 */
export function viewFingerprint(view: ViewConfig): string {
  return computeHash(
    canonical({
      name: view.name,
      type: view.type,
      filter: view.filter ?? null,
      sorts: view.sorts ?? null,
      configuration: view.configuration ?? null,
    }),
  );
}

/** pull 이 쓴 `.base` 의 보기 기록과 나머지 지문. 쓴 내용을 읽지 못하면 null(기록하지 않는다). */
export function recordBaseViews(
  content: string,
  written: readonly WrittenBasesView[],
  views: readonly ViewConfig[],
): { readonly views: BaseViewRecord[]; readonly rest: string } | null {
  const parsed = readBaseFile(content);
  if (!parsed || written.length !== parsed.views.length) return null;
  const byId = new Map(views.map((view) => [view.id, view]));
  const records: BaseViewRecord[] = [];
  for (const [i, source] of written.entries()) {
    const view = byId.get(source.viewId);
    if (!view) return null;
    records.push({
      viewId: source.viewId,
      type: String(parsed.views[i]!["type"]),
      ...pushableOf(parsed.views[i]!),
      ...(source.lossyFilter ? { lossyFilter: true as const } : {}),
      notion: viewFingerprint(view),
    });
  }
  return { views: records, rest: restSignature(parsed, records) };
}

/** 키 차례에 상관없는 JSON — 값이 같으면 글자도 같다. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
