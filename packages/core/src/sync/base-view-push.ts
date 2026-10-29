import type { IStateDB } from "../state/state-db-interface.js";
import type { DatabaseMeta } from "../notion/client.js";
import type { FailedOperation, ViewEdit } from "../types/sync.js";
import type { BasePropertySchema, ViewConfig, ViewUpdateRequest } from "../types/view.js";
import type { VaultFS } from "./vault-fs.js";
import { isNotionObjectNotFound } from "../notion/client.js";
import { RANGE_END_SUFFIX } from "../notion/property-mapper.js";
import { basesFilterToNotion } from "../view/bases-filter-to-notion.js";
import { computeHash } from "../utils/hash.js";
import {
  changedFields,
  matchViews,
  pushableOf,
  readBaseFile,
  restSignature,
  viewFingerprint,
  type BaseViewRecord,
  type PushableView,
} from "./base-view-record.js";
import { DbBaseFiles, type DbBaseFile } from "./db-base-files.js";
import { decodePropertyId } from "../view/property-resolver.js";
import { BASES_TITLE, notionTimestampOf } from "../view/bases-file-properties.js";

/**
 * 볼트에서 고친 `.base` 의 보기를 Notion 보기로(P4 · ADR-046) — 이름 · 열(보이는 것과 차례) · 정렬 · 필터.
 *
 * pull 이 쓴 보기 기록({@link BaseViewRecord})과 견준다. 기록이 없는 `.base`(직접 만든 것)는 Notion 보기에서 온 것이
 * 아니라 건드리지 않는다. 그 사이 Notion 에서도 그 보기를 고쳤으면 어느 쪽이 맞는지 몰라 올리지 않는다.
 *
 * 보기 하나는 통째로 올리거나 올리지 않는다 — 열은 올리고 필터는 못 올리면 Notion 보기가 볼트의 어느 상태와도 다르다.
 * 보기 추가 · 삭제 · 타입 · 그룹 · 수식처럼 올리지 않는 것을 고쳤으면 `.base` 를 계속 붙잡아 둔다 — 다음 pull 이 덮어쓰면
 * 그 고침이 사라진다.
 */

/** `configuration.properties` 항목 가운데 보낼 수 있는 키(`ViewPropertyConfigRequest`). */
const PROPERTY_REQUEST_KEYS = [
  "property_id",
  "visible",
  "width",
  "wrap",
  "status_show_as",
  "card_property_width_mode",
  "date_format",
  "time_format",
] as const;

/** 열을 바꿀 때 함께 보내야 하는 보기 설정 — 빠지면 400(보드의 `group_by`, 2026-10-29 실측). */
const REQUIRED_CONFIGURATION_KEYS = ["group_by", "date_property_id"] as const;

export interface PlannedViewEdit {
  readonly viewId: string;
  readonly request: ViewUpdateRequest;
  readonly edit: ViewEdit;
  /** 올린 뒤의 기록 — 볼트의 값으로(지문은 올린 뒤 다시 받는다). */
  readonly record: BaseViewRecord;
}

export interface PlannedBaseFile {
  readonly databaseId: string;
  readonly path: string;
  readonly base: DbBaseFile;
  /** 고친 `.base` 의 해시 — 모두 올렸으면 기록으로 둔다. */
  readonly hash: string;
  /** 고친 것을 모두 올릴 수 있다 — 거절한 보기도, 올리지 않는 고침도 없다. */
  readonly complete: boolean;
  readonly views: readonly PlannedViewEdit[];
}

export interface ViewEditPlan {
  readonly planned: readonly PlannedBaseFile[];
  readonly refused: readonly FailedOperation[];
}

export interface ViewEditOutcome {
  readonly applied: readonly ViewEdit[];
  readonly failed: readonly FailedOperation[];
}

type Built =
  | { readonly ok: true; readonly request: ViewUpdateRequest }
  | { readonly ok: false; readonly error: string };

export class BaseViewEdits {
  private readonly bases: DbBaseFiles;

  constructor(
    stateDb: Pick<IStateDB, "getMeta" | "setMeta">,
    private readonly vaultFs: Pick<VaultFS, "readFile">,
    private readonly notionClient: {
      getDatabaseMeta(databaseId: string): Promise<DatabaseMeta>;
      getDatabaseSchemaFull(
        databaseId: string,
        from?: DatabaseMeta,
      ): Promise<Record<string, BasePropertySchema>>;
      getView(viewId: string): Promise<ViewConfig | null>;
      updateView(viewId: string, request: ViewUpdateRequest): Promise<void>;
    },
  ) {
    this.bases = new DbBaseFiles(stateDb);
  }

  /** 고친 `.base` 를 찾아 보낼 것을 정한다 — Notion 은 고친 보기만 읽는다. */
  async plan(inScope: (path: string) => boolean = () => true): Promise<ViewEditPlan> {
    const planned: PlannedBaseFile[] = [];
    const refused: FailedOperation[] = [];
    const refuse = (path: string, error: string): void => {
      refused.push({
        path,
        operation: "update",
        error: `.base 의 보기를 Notion 에 올리지 않았습니다 — ${error}`,
      });
    };
    for (const [databaseId, base] of this.bases.all()) {
      if (!base.views || !inScope(base.basePath)) continue;
      const content = await this.vaultFs.readFile(base.basePath).catch(() => null);
      if (content === null) continue;
      const hash = computeHash(content);
      if (hash === base.hash) continue;

      const parsed = readBaseFile(content);
      if (!parsed) {
        refuse(base.basePath, "YAML 로 읽을 수 없습니다");
        continue;
      }
      const matched = matchViews(base.views, parsed.views);
      const edits = parsed.views.flatMap((view, i) => {
        const record = matched[i];
        if (!record) return [];
        const edited = pushableOf(view);
        const changed = changedFields(record, edited);
        return changed.length > 0 ? [{ record, edited, changed }] : [];
      });
      if (edits.length === 0) continue; // 올리지 않는 것만 고쳤다 — pull 이 붙잡아 두고 알린다

      const meta = await this.notionClient.getDatabaseMeta(databaseId);
      if (meta.dataSources.length > 1) {
        refuse(base.basePath, "데이터 소스가 여럿인 DB 의 보기는 Notion 에서 바꾸세요");
        continue;
      }
      const schema = await this.notionClient.getDatabaseSchemaFull(databaseId, meta);

      const views: PlannedViewEdit[] = [];
      let allPlanned = true;
      for (const { record, edited, changed } of edits) {
        const label = `보기 '${record.name}'`;
        let live: ViewConfig | null;
        try {
          live = await this.notionClient.getView(record.viewId);
        } catch (error) {
          if (!isNotionObjectNotFound(error)) throw error;
          live = null;
        }
        if (!live) {
          refuse(base.basePath, `${label}: Notion 에서 지운 보기입니다`);
          allPlanned = false;
          continue;
        }
        if (viewFingerprint(live) !== record.notion) {
          refuse(
            base.basePath,
            `${label}: 그 사이 Notion 에서도 이 보기를 고쳤습니다. 고친 내용을 옮겨 적고 이 파일을 지운 뒤 pull 하면 새로 받습니다`,
          );
          allPlanned = false;
          continue;
        }
        const built = buildRequest(record, edited, changed, live, schema);
        if (!built.ok) {
          refuse(base.basePath, `${label}: ${built.error}`);
          allPlanned = false;
          continue;
        }
        views.push({
          viewId: record.viewId,
          request: built.request,
          edit: {
            path: base.basePath,
            view: edited.name,
            ...(edited.name !== record.name ? { from: record.name } : {}),
            changed,
          },
          record: {
            viewId: record.viewId,
            type: record.type,
            ...edited,
            ...(record.lossyFilter && !changed.includes("filter") ? { lossyFilter: true } : {}),
            notion: record.notion,
          },
        });
      }
      if (views.length === 0) continue;
      planned.push({
        databaseId,
        path: base.basePath,
        base,
        hash,
        complete:
          allPlanned &&
          matched.filter(Boolean).length === base.views.length &&
          restSignature(parsed, matched) === base.rest,
        views,
      });
    }
    return { planned, refused };
  }

  async apply(planned: readonly PlannedBaseFile[]): Promise<ViewEditOutcome> {
    const applied: ViewEdit[] = [];
    const failed: FailedOperation[] = [];
    for (const file of planned) {
      const records = new Map(file.base.views!.map((record) => [record.viewId, record]));
      let allApplied = true;
      for (const view of file.views) {
        try {
          await this.notionClient.updateView(view.viewId, view.request);
        } catch (error) {
          allApplied = false;
          failed.push({
            path: file.path,
            operation: "update",
            error: `보기 '${view.edit.view}' 를 Notion 에 올리지 못했습니다: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
          continue;
        }
        applied.push(view.edit);
        // 올린 뒤의 지문 — 다음 push 가 «그 사이 Notion 에서 고침» 으로 여기지 않는다. 받지 못하면 옛 지문을 두어
        // 다음 push 가 충돌로 거절한다(덮어쓰기보다 낫다).
        const after = await this.notionClient.getView(view.viewId).catch(() => null);
        records.set(view.viewId, {
          ...view.record,
          notion: after ? viewFingerprint(after) : view.record.notion,
        });
      }
      this.bases.set(file.databaseId, {
        ...file.base,
        views: file.base.views!.map((record) => records.get(record.viewId) ?? record),
        // 고친 것을 모두 올렸으면 이 파일은 이제 pull 이 쓴 것과 같은 뜻이다 — 다음 pull 이 Notion 의 모습으로 다시 쓴다.
        // 남은 것이 있으면 계속 붙잡아 둔다.
        ...(file.complete && allApplied ? { hash: file.hash } : {}),
      });
    }
    return { applied, failed };
  }
}

/** 고친 값 → `views.update` 요청. 하나라도 옮기지 못하면 보기 전체를 거절한다. */
export function buildRequest(
  record: BaseViewRecord,
  edited: PushableView,
  changed: readonly string[],
  live: ViewConfig,
  schema: Readonly<Record<string, BasePropertySchema>>,
): Built {
  const request: {
    name?: string;
    filter?: unknown;
    sorts?: unknown[] | null;
    configuration?: Record<string, unknown>;
  } = {};
  try {
    if (changed.includes("name")) {
      if (!edited.name.trim()) throw new Error("보기 이름이 비었습니다");
      request.name = edited.name;
    }
    if (changed.includes("columns")) request.configuration = columnsOf(edited, live, schema);
    if (changed.includes("sort")) {
      request.sorts = edited.sort
        ? edited.sort.map((s) => ({
            property: propertyIdOf(s.property, schema, "정렬"),
            direction: s.direction === "DESC" ? "descending" : "ascending",
          }))
        : null;
    }
    if (changed.includes("filter")) {
      if (record.lossyFilter) {
        throw new Error(
          "Notion 필터에 볼트로 옮기지 못한 조건이 있어 볼트의 필터로 덮지 않습니다. 필터는 Notion 에서 고치세요",
        );
      }
      if (edited.filters === undefined) {
        request.filter = null;
      } else {
        const converted = basesFilterToNotion(edited.filters, schema);
        if (!converted.ok) throw new Error(`필터 — ${converted.error}`);
        request.filter = converted.filter;
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, request };
}

/**
 * `.base` 의 열 목록 → Notion `configuration`. 제목 열은 맨 앞(Bases 의 `file.name`), 그다음 볼트의 차례대로 보이는 열,
 * 나머지는 숨긴다. 폭 · 줄바꿈 같은 Notion 쪽 설정은 지금 값을 둔다.
 */
function columnsOf(
  edited: PushableView,
  live: ViewConfig,
  schema: Readonly<Record<string, BasePropertySchema>>,
): Record<string, unknown> {
  if (!edited.order) throw new Error("열 목록(order)을 지운 보기는 올리지 않습니다");
  const configuration = (live.configuration ?? {}) as Record<string, unknown>;
  const liveEntries = (
    Array.isArray(configuration["properties"]) ? configuration["properties"] : []
  ) as Array<Record<string, unknown>>;
  const entryOf = (id: string): Record<string, unknown> => {
    const found = liveEntries.find(
      (entry) => decodePropertyId(String(entry["property_id"])) === id,
    );
    const out: Record<string, unknown> = { property_id: id };
    for (const key of PROPERTY_REQUEST_KEYS) {
      if (found && key !== "property_id" && found[key] !== undefined && found[key] !== null) {
        out[key] = found[key];
      }
    }
    return out;
  };

  const title = Object.values(schema).find((prop) => prop.type === "title");
  const shown: string[] = [];
  for (const column of edited.order) {
    if (column === BASES_TITLE) continue;
    if (isRangeEnd(column, schema)) continue; // 기간의 끝 — 시작 열과 한 Notion 속성이다
    const id = propertyIdOf(column, schema, "열");
    if (title && id === decodePropertyId(title.id)) continue;
    if (!shown.includes(id)) shown.push(id);
  }
  const titleId = title ? decodePropertyId(title.id) : undefined;
  const properties = [
    ...(titleId ? [entryOf(titleId)] : []),
    ...shown.map((id) => ({ ...entryOf(id), visible: true })),
    ...liveEntries
      .map((entry) => decodePropertyId(String(entry["property_id"])))
      .filter((id) => id !== titleId && !shown.includes(id))
      .map((id) => ({ ...entryOf(id), visible: false })),
  ];
  return {
    type: configuration["type"] ?? live.type,
    ...Object.fromEntries(
      REQUIRED_CONFIGURATION_KEYS.filter((key) => configuration[key] !== undefined).map((key) => [
        key,
        configuration[key],
      ]),
    ),
    properties,
  };
}

/** 열 · 정렬의 이름 → Notion 속성 id. 파일 속성 · 수식은 Notion 속성이 아니다. */
function propertyIdOf(
  column: string,
  schema: Readonly<Record<string, BasePropertySchema>>,
  where: string,
): string {
  if (column === BASES_TITLE) {
    const title = Object.values(schema).find((prop) => prop.type === "title");
    if (title) return decodePropertyId(title.id);
  }
  if (notionTimestampOf(column)) {
    throw new Error(
      `${where} '${column}' — Notion 보기는 만든 · 고친 시각 정렬을 API 로 받지 않습니다. Notion 에서 바꾸세요`,
    );
  }
  const prop = Object.hasOwn(schema, column) ? schema[column] : undefined;
  if (!prop) throw new Error(`${where} '${column}' 은 이 DB 의 Notion 속성이 아닙니다`);
  return decodePropertyId(prop.id);
}

/** pull 이 기간의 끝을 따로 쓴 열(`마감_end`) — 그 이름의 속성이 따로 없을 때만. */
function isRangeEnd(column: string, schema: Readonly<Record<string, BasePropertySchema>>): boolean {
  if (!column.endsWith(RANGE_END_SUFFIX) || Object.hasOwn(schema, column)) return false;
  const start = column.slice(0, -RANGE_END_SUFFIX.length);
  return Object.hasOwn(schema, start) && schema[start]!.type === "date";
}
