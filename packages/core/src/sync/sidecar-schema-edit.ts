import type { IStateDB } from "../state/state-db-interface.js";
import type { DatabaseMeta } from "../notion/client.js";
import type { FailedOperation, SchemaEdit } from "../types/sync.js";
import type { SidecarProperty } from "../view/sidecar-generator.js";
import type { VaultFS } from "./vault-fs.js";
import { SIDECAR_GENERATOR } from "../view/sidecar-generator.js";
import { computeHash } from "../utils/hash.js";
import { compactNotionId } from "../utils/id.js";
import { SchemaLedger, seenSchemaOf } from "./schema-ledger.js";
import { SidecarBases, type SidecarBase } from "./sidecar-bases.js";

/**
 * 볼트에서 고친 사이드카(`<db>.notion.json`)의 속성을 Notion DB 의 열로(P3 · ADR-045) — 더하기 · 지우기 · 이름 · 타입 ·
 * 수식 · 숫자 형식 · 선택 옵션.
 *
 * ADR-036 결정 3(사이드카의 DB 에는 쓰지 않는다)을 이 볼트가 동기화하는 DB 로만 푼다 — pull 이 쓴 사이드카 기록
 * ({@link SidecarBases})이 있는 DB 다. 다른 볼트 · 루트에서 가져온 사이드카는 기록이 없어 여전히 새 DB 를 만든다.
 *
 * 지난 기록과 속성 id 로 견준다. Notion 에서도 그 사이 속성이 바뀌었으면 어느 쪽이 맞는지 몰라 올리지 않는다. 행 노트의
 * 키는 다음 pull 이 Notion 을 따라 옮긴다(`schema-follow.ts`) — 여기서는 볼트의 행을 고치지 않는다.
 *
 * 선택 옵션의 이름을 바꾼 것({@link OptionRename})은 API 로 바로 바꿀 수 없다 — 옵션 id 와 새 이름을 보내도 200 인데
 * 이름은 그대로다(2025-09-03 · 2026-03-11 실측, 색만 바뀐다). 그래서 새 이름을 더하고, 옛 값을 가진 Notion 행을 새 이름으로
 * 옮긴 뒤 옛 옵션을 지운다 — 그냥 지우면 그 값을 가진 행이 빈 값이 된다.
 */

/** 사이드카에서 설정을 고칠 수 있는 타입 — 그 밖의 설정(relation · rollup · status …)은 Notion 에서 바꾼다. */
const DEFINABLE_TYPES: ReadonlySet<string> = new Set([
  "formula",
  "number",
  "select",
  "multi_select",
]);

/** 사이드카에서 이름을 바꾼 선택 옵션 — 같은 자리의 옵션 이름이 바뀌었다({@link renamedOptions}). */
export interface OptionRename {
  readonly propertyId: string;
  readonly type: "select" | "multi_select";
  readonly from: string;
  readonly to: string;
}

export interface PlannedSchemaEdit {
  readonly databaseId: string;
  readonly dataSourceId: string;
  readonly path: string;
  /** 고친 사이드카의 해시 — 올린 뒤 기록으로 둔다. */
  readonly hash: string;
  /** 고친 사이드카의 속성 — 올린 뒤 새 기록이다(더한 속성의 id 는 Notion 이 준 것으로). */
  readonly properties: readonly SidecarProperty[];
  readonly payload: Record<string, unknown>;
  /** 옵션 이름을 바꿨으면 먼저 보낼 것 — 새 이름과 옛 이름이 함께 있다. 행을 옮긴 뒤 `payload` 로 옛 이름을 지운다. */
  readonly staged?: Record<string, unknown>;
  readonly optionRenames?: readonly OptionRename[];
  readonly edit: SchemaEdit;
  /** 지난 pull 이 본 스키마가 없으면 지금 것 — 다음 pull 이 이 변경을 행 노트에 옮기도록 먼저 적는다. */
  readonly seen: ReturnType<typeof seenSchemaOf>;
}

export interface SchemaEditPlan {
  readonly planned: readonly PlannedSchemaEdit[];
  readonly refused: readonly FailedOperation[];
}

export interface SchemaEditOutcome {
  readonly applied: readonly SchemaEdit[];
  readonly failed: readonly FailedOperation[];
}

type Diff =
  | {
      readonly ok: true;
      readonly payload: Record<string, unknown>;
      readonly staged?: Record<string, unknown>;
      readonly optionRenames?: readonly OptionRename[];
      readonly edit: Omit<SchemaEdit, "path">;
    }
  | { readonly ok: false; readonly error: string };

export class SidecarSchemaEdits {
  private readonly bases: SidecarBases;
  private readonly ledger: SchemaLedger;

  constructor(
    stateDb: Pick<IStateDB, "getMeta" | "setMeta">,
    private readonly vaultFs: Pick<VaultFS, "readFile">,
    private readonly notionClient: {
      getDatabaseMeta(databaseId: string): Promise<DatabaseMeta>;
      updateDataSourceProperties(
        dataSourceId: string,
        properties: Record<string, unknown>,
      ): Promise<Record<string, Record<string, unknown>>>;
      queryAllDatabasePages(
        databaseId: string,
        filter?: unknown,
      ): Promise<ReadonlyArray<{ id: string; properties: Record<string, unknown> }>>;
      updatePageProperties(pageId: string, properties: Record<string, unknown>): Promise<unknown>;
    },
  ) {
    this.bases = new SidecarBases(stateDb);
    this.ledger = new SchemaLedger(stateDb);
  }

  /** 고친 사이드카를 찾아 보낼 것을 정한다 — Notion 은 고친 것의 DB 만 읽는다. */
  async plan(inScope: (path: string) => boolean = () => true): Promise<SchemaEditPlan> {
    const planned: PlannedSchemaEdit[] = [];
    const refused: FailedOperation[] = [];
    const refuse = (path: string, error: string): void => {
      refused.push({
        path,
        operation: "update",
        error: `사이드카를 Notion 에 올리지 않았습니다 — ${error}`,
      });
    };
    for (const [databaseId, base] of this.bases.entries()) {
      if (!inScope(base.path)) continue;
      const content = await this.vaultFs.readFile(base.path).catch(() => null);
      if (content === null) continue;
      const hash = computeHash(content);
      if (hash === base.hash) continue;

      let edited: unknown;
      try {
        edited = JSON.parse(content);
      } catch {
        refuse(base.path, "JSON 으로 읽을 수 없습니다");
        continue;
      }
      const sidecar = edited as { generator?: unknown; databaseId?: unknown; properties?: unknown };
      if (sidecar.generator !== SIDECAR_GENERATOR) continue; // 사용자가 다른 것으로 바꾼 파일
      if (
        typeof sidecar.databaseId !== "string" ||
        compactNotionId(sidecar.databaseId) !== databaseId
      ) {
        refuse(base.path, "databaseId 를 바꿀 수 없습니다");
        continue;
      }
      const properties = parseProperties(sidecar.properties);
      if (properties === null) {
        refuse(base.path, "properties 는 name · type 이 있는 항목의 목록이어야 합니다");
        continue;
      }
      const diff = diffSidecarProperties(base.properties, properties);
      if (!diff.ok) {
        refuse(base.path, diff.error);
        continue;
      }
      if (Object.keys(diff.payload).length === 0) continue; // 속성 말고 다른 곳(보기 · 꾸밈)을 고쳤다

      const meta = await this.notionClient.getDatabaseMeta(databaseId);
      if (meta.dataSources.length !== 1) {
        refuse(
          base.path,
          "데이터 소스가 여럿인 DB 의 속성은 사이드카로 바꾸지 않습니다. Notion 에서 바꾸세요",
        );
        continue;
      }
      const source = meta.dataSources[0]!;
      const live = (source.properties ?? meta.properties) as Record<string, unknown>;
      if (!sameSchema(base.properties, live)) {
        refuse(
          base.path,
          "그 사이 Notion 에서도 속성이 바뀌었습니다. 고친 내용을 옮겨 적고 이 파일을 지운 뒤 pull 하면 새로 받습니다",
        );
        continue;
      }
      planned.push({
        databaseId,
        dataSourceId: source.id,
        path: base.path,
        hash,
        properties,
        payload: diff.payload,
        ...(diff.staged ? { staged: diff.staged, optionRenames: diff.optionRenames } : {}),
        edit: { path: base.path, ...diff.edit },
        seen: this.ledger.get(databaseId) ? null : seenSchemaOf(meta),
      });
    }
    return { planned, refused };
  }

  async apply(planned: readonly PlannedSchemaEdit[]): Promise<SchemaEditOutcome> {
    const applied: SchemaEdit[] = [];
    const failed: FailedOperation[] = [];
    for (const edit of planned) {
      // 지난 pull 이 본 스키마가 없으면 지금 것을 먼저 — 다음 pull 이 «처음 본 스키마» 로 여겨 행 키를 옮기지 않는다.
      if (edit.seen) this.ledger.set(edit.databaseId, edit.seen);
      let after: Record<string, Record<string, unknown>>;
      try {
        if (edit.staged) {
          await this.notionClient.updateDataSourceProperties(edit.dataSourceId, edit.staged);
          for (const rename of edit.optionRenames ?? []) {
            await this.moveOptionValues(edit.databaseId, rename);
          }
        }
        after = await this.notionClient.updateDataSourceProperties(edit.dataSourceId, edit.payload);
      } catch (error) {
        failed.push({
          path: edit.path,
          operation: "update",
          error: `사이드카의 속성을 Notion 에 올리지 못했습니다: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        continue;
      }
      this.bases.set(edit.databaseId, {
        path: edit.path,
        hash: edit.hash,
        properties: edit.properties.map((prop) => {
          const id = prop.id ?? after[prop.name]?.["id"];
          return typeof id === "string" ? { ...prop, id } : prop;
        }),
      } satisfies SidecarBase);
      applied.push(edit.edit);
    }
    return { applied, failed };
  }

  /**
   * 옛 옵션 값을 가진 Notion 행을 새 이름으로 옮긴다. 중간에 멈추면 두 이름이 다 남는다 — 사이드카 기록을 고치지 않아
   * 다음 push 가 같은 이름 바꾸기를 다시 해 남은 행을 마저 옮긴다.
   */
  private async moveOptionValues(databaseId: string, rename: OptionRename): Promise<void> {
    const { propertyId, type, from, to } = rename;
    const filter =
      type === "select"
        ? { property: propertyId, select: { equals: from } }
        : { property: propertyId, multi_select: { contains: from } };
    const rows = await this.notionClient.queryAllDatabasePages(databaseId, filter);
    for (const row of rows) {
      let value: unknown;
      if (type === "select") {
        value = { name: to };
      } else {
        const current = Object.values(row.properties).find(
          (prop) => (prop as { id?: unknown } | null)?.id === propertyId,
        ) as { multi_select?: Array<{ name?: string }> } | undefined;
        const names = (current?.multi_select ?? []).map((option) =>
          option.name === from ? to : (option.name ?? ""),
        );
        value = [...new Set(names.filter((name) => name.length > 0))].map((name) => ({ name }));
      }
      await this.notionClient.updatePageProperties(row.id, { [propertyId]: { [type]: value } });
    }
  }
}

/**
 * 볼트에서 사이드카의 속성을 고쳤는가 — push 가 올릴 것(또는 거절할 것)이 있다. 보기 · 꾸밈만 고친 것은 올리지 않으므로
 * 아니다 — pull 이 Notion 의 지금 모습으로 덮어쓴다. 읽을 수 없는 JSON 은 고치는 중으로 본다.
 */
export function sidecarPropertiesEdited(content: string, base: SidecarBase): boolean {
  let parsed: { properties?: unknown };
  try {
    parsed = JSON.parse(content) as { properties?: unknown };
  } catch {
    return true;
  }
  const properties = parseProperties(parsed.properties);
  if (properties === null) return true;
  const diff = diffSidecarProperties(base.properties, properties);
  return !diff.ok || Object.keys(diff.payload).length > 0;
}

/** 고친 사이드카의 속성 — id 는 더한 속성이면 없다. 모양이 틀리면 null. */
function parseProperties(value: unknown): SidecarProperty[] | null {
  if (!Array.isArray(value)) return null;
  const out: SidecarProperty[] = [];
  for (const item of value) {
    const prop = item as Partial<SidecarProperty> | null;
    if (
      !prop ||
      typeof prop !== "object" ||
      typeof prop.name !== "string" ||
      prop.name.trim() === "" ||
      typeof prop.type !== "string" ||
      (prop.id !== undefined && typeof prop.id !== "string") ||
      (prop.options !== undefined &&
        !(Array.isArray(prop.options) && prop.options.every((o) => typeof o === "string"))) ||
      (prop.definition !== undefined &&
        (typeof prop.definition !== "object" ||
          prop.definition === null ||
          Array.isArray(prop.definition)))
    ) {
      return null;
    }
    out.push(prop as SidecarProperty);
  }
  return out;
}

/**
 * 지난 기록과 고친 속성을 id 로 견줘 `dataSources.update` 에 보낼 것을 만든다(순수). 있던 속성은 id 로, 더한 속성은
 * 이름으로 보낸다 — 속성 id 는 이름 · 타입을 바꿔도 그대로다(실측).
 */
export function diffSidecarProperties(
  base: readonly SidecarProperty[],
  edited: readonly SidecarProperty[],
): Diff {
  const fail = (error: string): Diff => ({ ok: false, error });
  const byId = new Map(base.map((prop) => [prop.id, prop]));
  const payload: Record<string, unknown> = {};
  const edit = {
    added: [] as string[],
    removed: [] as string[],
    renamed: [] as Array<readonly [string, string]>,
    retyped: [] as Array<readonly [string, string]>,
    redefined: [] as string[],
    renamedOptions: [] as Array<readonly [string, string, string]>,
  };
  const droppedOptions: Array<readonly [string, readonly string[]]> = [];
  const optionRenames: OptionRename[] = [];
  const staged: Record<string, unknown> = {};

  const names = new Set<string>();
  const seenIds = new Set<string>();
  for (const prop of edited) {
    if (names.has(prop.name)) return fail(`속성 이름 「${prop.name}」 이 둘입니다`);
    names.add(prop.name);
    const old = prop.id === undefined ? undefined : byId.get(prop.id);
    if (prop.id !== undefined && !old) {
      return fail(`「${prop.name}」 의 id 를 모릅니다 — 새 속성은 id 를 적지 마세요`);
    }
    if (old && seenIds.has(old.id)) return fail(`「${prop.name}」 의 id 가 둘입니다`);

    if (!old) {
      if (prop.type === "title") return fail("제목 속성은 더할 수 없습니다");
      payload[prop.name] = { [prop.type]: definitionOf(prop, undefined) };
      edit.added.push(prop.name);
      continue;
    }
    seenIds.add(old.id);
    const change: Record<string, unknown> = {};
    if (prop.name !== old.name) {
      change["name"] = prop.name;
      edit.renamed.push([old.name, prop.name]);
    }
    if (prop.type !== old.type) {
      if (old.type === "title" || prop.type === "title") {
        return fail("제목 속성의 타입은 바꿀 수 없습니다");
      }
      change[prop.type] = definitionOf(prop, undefined);
      edit.retyped.push([prop.name, prop.type]);
    } else if (!sameDefinition(prop, old)) {
      if (!DEFINABLE_TYPES.has(prop.type)) {
        return fail(
          `「${prop.name}」(${prop.type}) 의 설정은 사이드카에서 바꿀 수 없습니다. Notion 에서 바꾸세요`,
        );
      }
      edit.redefined.push(prop.name);
      const isSelect = prop.type === "select" || prop.type === "multi_select";
      const before = isSelect ? optionNamesOf(old) : [];
      const after = isSelect ? sentOptionNamesOf(prop, old) : [];
      const renames = renamedOptions(before, after);
      change[prop.type] = definitionOf(prop, old, renames);
      const dropped = before.filter(
        (name) => !after.includes(name) && !renames.some(([from]) => from === name),
      );
      if (dropped.length > 0) droppedOptions.push([prop.name, dropped]);
      if (renames.length > 0) {
        const type = prop.type as OptionRename["type"];
        const final = (change[type] as { options?: unknown[] } | undefined)?.options ?? [];
        const known = (old.definition?.["options"] as Array<{ name?: string }> | undefined) ?? [];
        staged[old.id] = {
          ...change,
          [type]: {
            ...(change[type] as object),
            options: [
              ...final,
              ...renames.map(([from]) => known.find((o) => o.name === from) ?? { name: from }),
            ],
          },
        };
        for (const [from, to] of renames) {
          optionRenames.push({ propertyId: old.id, type, from, to });
          edit.renamedOptions.push([prop.name, from, to]);
        }
      }
    }
    if (Object.keys(change).length > 0) payload[old.id] = change;
  }

  for (const old of base) {
    if (seenIds.has(old.id)) continue;
    if (old.type === "title") return fail("제목 속성은 지울 수 없습니다");
    payload[old.id] = null;
    edit.removed.push(old.name);
  }
  const kept = base.filter((p) => p.type !== "title").length;
  if (kept >= 2 && edit.removed.length === kept && edit.added.length === 0) {
    return fail("제목 말고 모든 속성을 지우는 것은 받지 않습니다 — 정말이면 Notion 에서 지우세요");
  }
  const { renamedOptions: renamedOptionList, ...rest } = edit;
  return {
    ok: true,
    payload,
    // 먼저 보낼 것 — 옵션 이름을 바꾼 속성만 새 이름 · 옛 이름을 함께, 나머지는 마지막 것과 같다.
    ...(optionRenames.length > 0 ? { staged: { ...payload, ...staged }, optionRenames } : {}),
    edit: {
      ...rest,
      ...(droppedOptions.length > 0 ? { droppedOptions } : {}),
      ...(renamedOptionList.length > 0 ? { renamedOptions: renamedOptionList } : {}),
    },
  };
}

/** 지난 기록의 옵션 이름 — 목록(`options`)이 없으면 설정에서. */
function optionNamesOf(prop: SidecarProperty): string[] {
  if (prop.options) return [...prop.options];
  const options = prop.definition?.["options"];
  return Array.isArray(options)
    ? options
        .map((o) => (o as { name?: unknown }).name)
        .filter((n): n is string => typeof n === "string")
    : [];
}

/** 보낼 옵션 이름 — 설정을 고쳤으면 설정의 것({@link definitionOf} 가 설정을 그대로 보낸다), 아니면 목록. */
function sentOptionNamesOf(prop: SidecarProperty, old: SidecarProperty): string[] {
  if (sameJson(prop.definition, old.definition)) return [...(prop.options ?? [])];
  return optionNamesOf({ ...prop, options: undefined });
}

/**
 * 같은 자리의 옵션 이름이 바뀌었으면 이름을 바꾼 것으로 본다 — 옛 이름이 목록에서 사라지고 새 이름이 처음 보일 때만.
 * 옵션을 지우거나 더해 자리가 밀리면 어느 자리의 이름도 이 조건을 맞추지 않는다(지운 것 · 더한 것으로 남는다).
 */
export function renamedOptions(
  before: readonly string[],
  after: readonly string[],
): Array<readonly [string, string]> {
  const renames: Array<readonly [string, string]> = [];
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    const from = before[i]!;
    const to = after[i]!;
    if (from !== to && !after.includes(from) && !before.includes(to)) renames.push([from, to]);
  }
  return renames;
}

/** 보낼 타입별 설정 — 옵션 이름만 고쳤으면 그 이름으로, 지난 옵션의 색은 그대로(이름을 바꾼 옵션은 옛 옵션의 색). */
function definitionOf(
  prop: SidecarProperty,
  old: SidecarProperty | undefined,
  renames: ReadonlyArray<readonly [string, string]> = [],
): unknown {
  if (!DEFINABLE_TYPES.has(prop.type)) return {};
  const definition = prop.definition ?? {};
  if (
    old &&
    (prop.type === "select" || prop.type === "multi_select") &&
    sameJson(prop.definition, old.definition) &&
    !sameJson(prop.options, old.options)
  ) {
    const known = (old.definition?.["options"] as Array<{ name?: string }> | undefined) ?? [];
    const renamedFrom = new Map(renames.map(([from, to]) => [to, from]));
    return {
      options: (prop.options ?? []).map((name) => {
        const from = renamedFrom.get(name);
        if (from === undefined) return known.find((o) => o.name === name) ?? { name };
        const color = (known.find((o) => o.name === from) as { color?: unknown } | undefined)
          ?.color;
        return color === undefined ? { name } : { name, color };
      }),
    };
  }
  return definition;
}

function sameDefinition(a: SidecarProperty, b: SidecarProperty): boolean {
  return sameJson(a.definition, b.definition) && sameJson(a.options, b.options);
}

/** 지난 기록의 id · 이름 · 타입이 Notion 의 지금 속성과 같은가. */
function sameSchema(base: readonly SidecarProperty[], live: Record<string, unknown>): boolean {
  const liveById = new Map<string, { name: string; type: unknown }>();
  for (const [name, raw] of Object.entries(live)) {
    const prop = raw as { id?: unknown; type?: unknown } | null;
    if (typeof prop?.id === "string") liveById.set(prop.id, { name, type: prop.type });
  }
  return (
    liveById.size === base.length &&
    base.every((prop) => {
      const now = liveById.get(prop.id);
      return now?.name === prop.name && now.type === prop.type;
    })
  );
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
