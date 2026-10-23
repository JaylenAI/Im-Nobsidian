import type { NotionClient } from "../notion/client.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { Config } from "../types/config.js";
import type { LocalChange } from "../types/sync.js";
import type { ViewRequest } from "../types/view.js";
import { compactNotionId } from "../utils/id.js";
import { getLogger } from "../utils/logger.js";
import {
  NOTION_DEFAULT_STATUS,
  parseSidecarSchema,
  planDatabaseSchema,
  relationRequest,
  type DatabaseSchemaPlan,
  type PlannedStatus,
  type SidecarSchema,
} from "./database-schema.js";
import { planViews } from "./database-views.js";
import {
  DISCOVERED_DBS_META_KEY,
  loadInaccessibleDbIds,
  loadLinkedDbMap,
  parseDiscoveredDbs,
} from "./discovered-databases.js";
import {
  ancestorFolders,
  folderContainer,
  folderNoteOf,
  parentFolderOf,
  type FolderLookup,
} from "./folder-container.js";
import { isDatabaseMode } from "./parent-mode.js";
import {
  PENDING_DATABASES_META_KEY,
  parsePendingDatabases,
  serializePendingDatabases,
} from "./remote-scan.js";
import type { VaultFS } from "./vault-fs.js";

/**
 * push 가 만든 DB — 사이드카의 DB(받아 온 곳, 하이픈 없는 id) → 만든 DB. 상태 메타에 둔다.
 * `.base` 임베드가 새 DB 를 가리키고(page-pusher), 같은 폴더를 두 번 만들지 않는다.
 */
export const CREATED_DBS_META_KEY = "created_dbs";

export interface CreatedDatabase {
  /** 만든 DB. null 이면 만드는 요청을 보냈는데 답을 받지 못했다 — 다음 push 가 부모에서 찾는다. */
  readonly databaseId: string | null;
  readonly dataSourceId: string | null;
  readonly folder: string;
  readonly parentPageId: string;
  readonly title: string;
  /** relation · rollup · formula 를 다 붙였나 — 아니면 다음 push 가 이어 붙인다. */
  readonly schemaDone: boolean;
  /** 사이드카의 보기를 다 만들었나 — 아니면 다음 push 가 이어 만든다. */
  readonly viewsDone?: boolean;
  /** DB 를 만들 때 Notion 이 넣은 기본 보기 — 사이드카의 보기를 만든 뒤 지운다. */
  readonly initialViewIds?: readonly string[];
}

/** 사이드카가 있고 Notion 에 아직 없는 DB 폴더. */
export interface NewDatabaseFolder {
  readonly folder: string;
  readonly schema: SidecarSchema;
}

export function loadCreatedDatabases(stateDb: IStateDB): Map<string, CreatedDatabase> {
  const raw = stateDb.getMeta(CREATED_DBS_META_KEY);
  if (!raw) return new Map();
  try {
    return new Map(Object.entries(JSON.parse(raw) as Record<string, CreatedDatabase>));
  } catch {
    return new Map();
  }
}

function saveCreatedDatabases(
  stateDb: IStateDB,
  created: ReadonlyMap<string, CreatedDatabase>,
): void {
  stateDb.setMeta(CREATED_DBS_META_KEY, JSON.stringify(Object.fromEntries(created)));
}

const SIDECAR_RE = /\.notion\.json$/i;

/**
 * 새 루트로 올린 DB 폴더를 Notion DB 로 만든다(ADR-036).
 *
 * 1. {@link newDatabaseFolders} — 새 노트가 든 폴더 가운데 사이드카가 있고, 그 DB 를 이 볼트가 모르는 폴더.
 * 2. {@link create} — 폴더의 자리를 마련할 때(`FolderPlacement.prepareFolders`) 부모 페이지 아래에 만들고,
 *    자동 발견 목록에 적는다. 그 폴더의 노트는 행으로 간다(`pushCreateRow`).
 * 3. {@link completeSchemas} — 이번에 만든 DB 가 모두 생긴 뒤 relation → rollup → formula 를 붙인다.
 * 4. {@link completeViews} — 속성이 다 붙은 뒤 사이드카의 보기를 만들고 기본 보기를 지운다.
 *
 * 🔴 사이드카가 가리키는 DB 에는 쓰지 않는다 — 받아 온 곳(다른 루트 · 사용자의 실제 워크스페이스)일 수 있다.
 */
export class DatabaseCreator {
  /** 이번 push 가 만든 DB 폴더. */
  private readonly createdNow = new Set<string>();

  constructor(
    private readonly config: Config,
    private readonly stateDb: IStateDB,
    private readonly notionClient: NotionClient,
    private readonly vaultFs: VaultFS,
  ) {}

  get enabled(): boolean {
    return this.config.sync.createDatabases !== false && !isDatabaseMode(this.config);
  }

  /** push 마다 새로 센다. */
  reset(): void {
    this.createdNow.clear();
  }

  /** 이번 push 가 만든 DB 수. */
  get createdCount(): number {
    return this.createdNow.size;
  }

  /**
   * Notion DB 로 만들 폴더 — 사이드카가 있고, 자리가 없는(DB · 페이지가 아닌) 폴더. 예전 push 가 폴더 페이지로
   * 올린 DB 폴더는 DB 로 바꾸지 않는다.
   *
   * @param includeEmpty 새 노트가 없는 DB 폴더(행이 없는 DB)도 — 범위를 좁힌 push 는 범위 밖을 만들지 않는다.
   */
  async newDatabaseFolders(
    changes: readonly LocalChange[],
    lookup: FolderLookup,
    includeEmpty: boolean,
  ): Promise<Map<string, NewDatabaseFolder>> {
    const found = new Map<string, NewDatabaseFolder>();
    if (!this.enabled) return found;
    const candidates = new Set<string>();
    for (const change of changes) {
      if (change.type !== "created" && change.type !== "moved") continue;
      for (const folder of ancestorFolders(change.path)) {
        if (!folderContainer(folder, lookup)) candidates.add(folder);
      }
    }
    if (candidates.size === 0 && !includeEmpty) return found;

    const known = this.knownDatabaseIds();
    const created = loadCreatedDatabases(this.stateDb);
    for (const file of await this.vaultFs.listNonMarkdownFiles()) {
      if (!SIDECAR_RE.test(file.path)) continue;
      const folder = parentFolderOf(file.path);
      if (found.has(folder)) continue;
      if (!candidates.has(folder) && !(includeEmpty && !folderContainer(folder, lookup))) continue;
      const schema = await this.readSidecar(file.path);
      if (!schema) continue;
      const entry = created.get(schema.databaseId);
      // 만든 적이 있으면 그 폴더의 자리가 이미 있다. 만드는 요청이 끝나지 않은 것만 다시 본다.
      if (entry && entry.databaseId !== null) continue;
      if (!entry && known.has(schema.databaseId)) continue;
      found.set(folder, { folder, schema });
    }
    return found;
  }

  /**
   * 폴더의 DB 를 부모 페이지 아래에 만들고 자동 발견 목록에 적는다. 만드는 요청은 다시 보내지 않는다 —
   * 그 앞에 자리를 적어 두고, 답을 잃었으면 다음 push 가 부모에서 같은 제목의 DB 를 찾아 삼는다.
   */
  async create(target: NewDatabaseFolder, parentPageId: string): Promise<void> {
    const source = target.schema.databaseId;
    const plan = planDatabaseSchema(target.schema);
    const title = target.schema.title || target.folder.slice(target.folder.lastIndexOf("/") + 1);
    const created = loadCreatedDatabases(this.stateDb);

    const unfinished = created.get(source);
    if (unfinished && unfinished.databaseId === null) {
      const adopted = await this.findUnfinished(unfinished.parentPageId, unfinished.title);
      if (adopted) {
        const dataSourceId = await this.notionClient.primaryDataSourceId(adopted);
        this.record(source, {
          ...unfinished,
          databaseId: adopted,
          dataSourceId,
          folder: target.folder,
        });
        this.register(adopted, target.folder, plan.titleProperty);
        getLogger().info(`[Im-Nobsidian] 앞선 요청이 만든 DB 를 삼음: ${target.folder}`);
        return;
      }
    }

    this.record(source, {
      databaseId: null,
      dataSourceId: null,
      folder: target.folder,
      parentPageId,
      title,
      schemaDone: false,
    });
    const { databaseId, dataSourceId } = await this.createWithFreePrefixes(
      parentPageId,
      title,
      target,
      plan,
    );
    this.record(source, {
      databaseId,
      dataSourceId,
      folder: target.folder,
      parentPageId,
      title,
      schemaDone: false,
    });
    this.register(databaseId, target.folder, plan.titleProperty);
    this.createdNow.add(target.folder);
    getLogger().info(`[Im-Nobsidian] DB 를 만듦: ${target.folder}`);

    for (const skip of plan.skipped) {
      getLogger().warn(
        `[Im-Nobsidian] DB 속성을 만들지 않음 (${target.folder} · ${skip.name}): ${skip.reason}`,
      );
    }
    for (const status of plan.statuses) {
      try {
        await this.addStatus(dataSourceId, status, target.folder);
      } catch (error) {
        getLogger().warn(
          `[Im-Nobsidian] status 속성을 더하지 못함 (${target.folder} · ${status.name}): ${messageOf(error)}`,
        );
      }
    }
  }

  /**
   * DB 를 만든다. unique_id 접두어는 워크스페이스에서 하나뿐이다(2026-10-23 실측: 409 conflict_error "Unique ID
   * prefix is already in use.") — 받아 온 DB 가 같은 워크스페이스에 있으면 늘 겹친다. 그러면 접두어 없이 만들고
   * 알린다.
   */
  private async createWithFreePrefixes(
    parentPageId: string,
    title: string,
    target: NewDatabaseFolder,
    plan: DatabaseSchemaPlan,
  ): Promise<{ databaseId: string; dataSourceId: string }> {
    const request = (properties: Record<string, unknown>) =>
      this.notionClient.createDatabase({
        parentPageId,
        title,
        isInline: target.schema.isInline,
        properties,
      });
    try {
      return await request(plan.initial);
    } catch (error) {
      if (statusOf(error) !== 409 || !/prefix/i.test(messageOf(error))) throw error;
      const prefixed = Object.keys(plan.initial).filter(
        (name) => (plan.initial[name] as { unique_id?: { prefix?: unknown } }).unique_id?.prefix,
      );
      if (prefixed.length === 0) throw error;
      getLogger().warn(
        `[Im-Nobsidian] unique_id 접두어가 워크스페이스에서 이미 쓰여 접두어 없이 만듦 (${target.folder} · ` +
          `${prefixed.join(", ")})`,
      );
      const properties = { ...plan.initial };
      for (const name of prefixed) properties[name] = { unique_id: { prefix: null } };
      return await request(properties);
    }
  }

  /**
   * status 를 더한다. 그룹은 API 가 정하지 못한다 — 기본 세 옵션이 원래 있었으면 기본으로 만들어 제 그룹에 두고
   * 나머지를 더한다(To-do 에 든다). 원래 그룹과 달라지는 옵션은 알린다.
   */
  private async addStatus(
    dataSourceId: string,
    status: PlannedStatus,
    folder: string,
  ): Promise<void> {
    const names = status.options.map((o) => o.name);
    const keepsDefaults = NOTION_DEFAULT_STATUS.every((n) => names.includes(n));
    let placed: ReadonlyMap<string, string>;
    if (keepsDefaults) {
      const after = await this.notionClient.updateDataSourceProperties(dataSourceId, {
        [status.name]: { status: {} },
      });
      const existing = optionsWithIds(after[status.name]);
      const extras = status.options.filter((o) => !NOTION_DEFAULT_STATUS.includes(o.name));
      placed = new Map([
        ["Not started", "To-do"],
        ["In progress", "In progress"],
        ["Done", "Complete"],
        ...extras.map((o) => [o.name, "To-do"] as const),
      ]);
      if (extras.length > 0) {
        await this.notionClient.updateDataSourceProperties(dataSourceId, {
          [status.name]: { status: { options: [...existing, ...extras] } },
        });
      }
    } else {
      await this.notionClient.updateDataSourceProperties(dataSourceId, {
        [status.name]: { status: { options: status.options } },
      });
      placed = new Map(names.map((n) => [n, "To-do"]));
    }
    const moved = (status.groups ?? []).flatMap((g) =>
      g.options
        .filter((o) => placed.has(o) && placed.get(o) !== g.name)
        .map((o) => `${o}(${g.name})`),
    );
    if (moved.length > 0) {
      getLogger().warn(
        `[Im-Nobsidian] status 그룹은 Notion API 가 정하지 못해 To-do 에 둠 (${folder} · ${status.name}): ` +
          `${moved.join(", ")} — Notion 에서 옮기세요`,
      );
    }
  }

  /**
   * 만든 DB 에 relation → rollup → formula 를 붙인다. 이번 push 가 만든 DB 가 모두 생긴 뒤에 부른다 —
   * relation 은 대상 DB 가, rollup 은 relation 이, formula 는 식이 가리키는 속성이 있어야 한다.
   *
   * dual relation 은 한쪽에서 한 번만 만든다. Notion 이 대상 DB 에 맞짝 속성을 만들므로, 그 이름을 사이드카의
   * 이름으로 바꾸고 대상 쪽 사이드카의 같은 relation 은 건너뛴다.
   *
   * Notion 이 거절한 속성(400)은 이유를 남기고 넘어간다. 그 밖의 실패는 다음 push 가 다시 붙인다.
   */
  async completeSchemas(): Promise<void> {
    const created = loadCreatedDatabases(this.stateDb);
    const work: Array<{
      source: string;
      dataSourceId: string;
      folder: string;
      plan: DatabaseSchemaPlan;
    }> = [];
    for (const [source, entry] of created) {
      if (entry.schemaDone || !entry.databaseId || !entry.dataSourceId) continue;
      const schema = await this.sidecarIn(entry.folder, source);
      if (!schema) {
        this.record(source, { ...entry, schemaDone: true });
        continue;
      }
      work.push({
        source,
        dataSourceId: entry.dataSourceId,
        folder: entry.folder,
        plan: planDatabaseSchema(schema),
      });
    }
    if (work.length === 0) return;

    const retry = new Set<string>();
    const handled = new Set<string>();
    const key = (source: string, name: string): string => `${source}\u0000${name}`;
    const attempt = async (
      item: (typeof work)[number],
      name: string,
      send: () => Promise<unknown>,
    ): Promise<boolean> => {
      try {
        await send();
        return true;
      } catch (error) {
        if (statusOf(error) !== 400) retry.add(item.source);
        getLogger().warn(
          `[Im-Nobsidian] DB 속성을 붙이지 못함 (${item.folder} · ${name}): ${messageOf(error)}`,
        );
        return false;
      }
    };

    for (const item of work) {
      for (const relation of item.plan.relations) {
        if (handled.has(key(item.source, relation.name))) continue;
        const target = await this.relationTarget(relation.targetDatabaseId, created);
        if (!target) {
          getLogger().warn(
            `[Im-Nobsidian] relation 을 만들지 않음 (${item.folder} · ${relation.name}): ` +
              `대상 DB 가 이 볼트에서 만든 · 받은 DB 가 아니다 — 다른 워크스페이스의 DB 에 속성을 더하지 않는다`,
          );
          continue;
        }
        await attempt(item, relation.name, async () => {
          const after = await this.notionClient.updateDataSourceProperties(item.dataSourceId, {
            [relation.name]: relationRequest(relation, target.dataSourceId),
          });
          if (!relation.dual || !relation.syncedName || target.source === null) return;
          handled.add(key(target.source, relation.syncedName));
          const synced = (
            after[relation.name]?.relation as { dual_property?: { synced_property_name?: string } }
          )?.dual_property?.synced_property_name;
          if (synced && synced !== relation.syncedName) {
            await this.notionClient.updateDataSourceProperties(target.dataSourceId, {
              [synced]: { name: relation.syncedName },
            });
          }
        });
      }
    }
    for (const item of work) {
      for (const [name, rollup] of item.plan.rollups) {
        await attempt(item, name, () =>
          this.notionClient.updateDataSourceProperties(item.dataSourceId, { [name]: { rollup } }),
        );
      }
    }
    for (const item of work) {
      const formulas = Object.entries(item.plan.formulas);
      if (formulas.length === 0) continue;
      // 한 번에 보내고, 거절되면 하나씩 — 식 하나가 틀려도 나머지는 붙는다.
      try {
        await this.notionClient.updateDataSourceProperties(item.dataSourceId, item.plan.formulas);
      } catch {
        for (const [name, formula] of formulas) {
          await attempt(item, name, () =>
            this.notionClient.updateDataSourceProperties(item.dataSourceId, { [name]: formula }),
          );
        }
      }
    }

    const latest = loadCreatedDatabases(this.stateDb);
    for (const item of work) {
      const entry = latest.get(item.source);
      if (entry && !retry.has(item.source)) latest.set(item.source, { ...entry, schemaDone: true });
    }
    saveCreatedDatabases(this.stateDb, latest);
  }

  /**
   * 속성을 다 붙인 DB 에 사이드카의 보기를 차례대로 만들고, Notion 이 넣은 기본 보기를 지운다. 이어 만들 때는
   * 이미 만든 보기(이름)를 건너뛴다 — 만드는 요청은 다시 보내면 보기가 둘 생긴다.
   */
  async completeViews(): Promise<void> {
    for (const [source, entry] of loadCreatedDatabases(this.stateDb)) {
      if (entry.viewsDone || !entry.schemaDone || !entry.databaseId || !entry.dataSourceId)
        continue;
      const schema = await this.sidecarIn(entry.folder, source);
      // pull 이 사이드카를 새 DB 로 고쳐 썼으면 원래 보기는 이제 없다 — 새 DB 의 보기가 곧 사이드카다.
      if (!schema || schema.databaseId !== source || schema.views.length === 0) {
        this.record(source, { ...entry, viewsDone: true });
        continue;
      }
      let done = false;
      try {
        done = await this.createViews(source, entry, schema);
      } catch (error) {
        getLogger().warn(
          `[Im-Nobsidian] 보기를 만들지 못함 (${entry.folder}) — 다음 push 가 이어 만든다: ${messageOf(error)}`,
        );
      }
      const latest = loadCreatedDatabases(this.stateDb).get(source);
      if (done && latest) this.record(source, { ...latest, viewsDone: true });
    }
  }

  /** @returns 다 만들었나 — false 면 다음 push 가 이어 만든다. */
  private async createViews(
    source: string,
    entry: CreatedDatabase,
    schema: SidecarSchema,
  ): Promise<boolean> {
    const databaseId = entry.databaseId!;
    const dataSourceId = entry.dataSourceId!;
    const views = await this.notionClient.listDatabaseViews(databaseId);
    const initial = entry.initialViewIds ?? views.map((v) => v.id);
    if (!entry.initialViewIds) this.record(source, { ...entry, initialViewIds: initial });
    const made = new Map<string, number>();
    for (const view of views) {
      if (!initial.includes(view.id)) made.set(view.name, (made.get(view.name) ?? 0) + 1);
    }

    const plan = planViews(schema, await this.notionClient.getDataSourceProperties(dataSourceId));
    for (const skip of plan.skipped) {
      getLogger().warn(
        `[Im-Nobsidian] 보기를 만들지 않음 (${entry.folder} · ${skip.name}): ${skip.reason}`,
      );
    }
    let count = [...made.values()].reduce((a, b) => a + b, 0);
    for (const request of plan.requests) {
      const already = made.get(request.name) ?? 0;
      if (already > 0) {
        made.set(request.name, already - 1);
        continue;
      }
      const sent = await this.sendView(entry.folder, databaseId, dataSourceId, request);
      if (sent === "retry") return false;
      if (sent === "made") count++;
    }
    if (count === 0) return true; // 하나도 못 만들었으면 기본 보기를 남긴다 — DB 에 보기가 없을 수는 없다.
    for (const id of initial) {
      try {
        await this.notionClient.deleteView(id);
      } catch (error) {
        if (statusOf(error) !== 404) {
          getLogger().warn(
            `[Im-Nobsidian] 기본 보기를 지우지 못함 (${entry.folder}): ${messageOf(error)}`,
          );
        }
      }
    }
    return true;
  }

  private async sendView(
    folder: string,
    databaseId: string,
    dataSourceId: string,
    request: ViewRequest,
  ): Promise<"made" | "refused" | "retry"> {
    try {
      await this.notionClient.createView({ databaseId, dataSourceId, request });
      return "made";
    } catch (error) {
      const refused = statusOf(error) === 400;
      getLogger().warn(
        `[Im-Nobsidian] 보기를 만들지 못함 (${folder} · ${request.name})` +
          `${refused ? "" : " — 다음 push 가 다시 만든다"}: ${messageOf(error)}`,
      );
      return refused ? "refused" : "retry";
    }
  }

  /**
   * 이번 push 가 만든 DB 의 부모 노트 — 부모 본문을 다시 보내야 DB 가 `.base` 임베드 자리에 선다. 만들 때는
   * 부모가 먼저 생기고 DB 는 그 끝에 붙는다.
   */
  parentNotesOfCreated(): string[] {
    const notes = new Set<string>();
    for (const folder of this.createdNow) {
      const parent = parentFolderOf(folder);
      if (!parent) continue;
      for (const path of [folderNoteOf(parent), `${parent}.md`]) {
        if (this.stateDb.getByPath(path)?.notionPageId) notes.add(path);
      }
    }
    return [...notes];
  }

  /** 사이드카의 DB(받아 온 곳)를 만든 DB 로 — 만든 적이 없으면 null. */
  createdFor(sourceDatabaseId: string): string | null {
    return (
      loadCreatedDatabases(this.stateDb).get(compactNotionId(sourceDatabaseId))?.databaseId ?? null
    );
  }

  /** 이 볼트가 아는 DB — 설정 · 자동 발견 · 접근 불가 · 링크드 · 만든 DB. 사이드카가 이것을 가리키면 새 DB 가 아니다. */
  private knownDatabaseIds(): Set<string> {
    const ids = new Set<string>();
    const add = (id: string | null | undefined): void => {
      if (id) ids.add(compactNotionId(id));
    };
    for (const db of this.config.notion.databases ?? []) add(db.databaseId);
    for (const db of parseDiscoveredDbs(this.stateDb.getMeta(DISCOVERED_DBS_META_KEY)))
      add(db.databaseId);
    for (const id of loadInaccessibleDbIds(this.stateDb)) add(id);
    for (const [container, original] of loadLinkedDbMap(this.stateDb)) {
      add(container);
      add(original);
    }
    for (const entry of loadCreatedDatabases(this.stateDb).values()) add(entry.databaseId);
    return ids;
  }

  /** relation 이 걸 대상 — 만든 DB, 아니면 이 볼트가 받는 DB. 그 밖은 null(다른 워크스페이스의 DB 일 수 있다). */
  private async relationTarget(
    targetSource: string,
    created: ReadonlyMap<string, CreatedDatabase>,
  ): Promise<{ dataSourceId: string; source: string | null } | null> {
    const made = created.get(targetSource);
    if (made?.dataSourceId) return { dataSourceId: made.dataSourceId, source: targetSource };
    const synced =
      (this.config.notion.databases ?? []).some(
        (d) => compactNotionId(d.databaseId) === targetSource,
      ) ||
      parseDiscoveredDbs(this.stateDb.getMeta(DISCOVERED_DBS_META_KEY)).some(
        (d) => compactNotionId(d.databaseId) === targetSource,
      );
    if (!synced) return null;
    const dataSourceId = await this.notionClient.primaryDataSourceId(targetSource);
    return dataSourceId ? { dataSourceId, source: null } : null;
  }

  /** 만드는 요청의 답을 잃은 DB — 부모의 같은 제목 DB 가운데 이 볼트가 모르는 것. */
  private async findUnfinished(parentPageId: string, title: string): Promise<string | null> {
    const known = this.knownDatabaseIds();
    for (const block of await this.notionClient.fetchAllChildren(parentPageId)) {
      if (block.type !== "child_database") continue;
      const childTitle = (block as { child_database?: { title?: string } }).child_database?.title;
      if (childTitle === title && !known.has(compactNotionId(block.id))) return block.id;
    }
    return null;
  }

  private record(source: string, entry: CreatedDatabase): void {
    const created = loadCreatedDatabases(this.stateDb);
    created.set(source, entry);
    saveCreatedDatabases(this.stateDb, created);
  }

  /**
   * 만든 DB 를 자동 발견 목록에 적는다 — 그 폴더의 노트가 행으로 가고, 다음 pull 이 이 폴더로 받는다.
   * 다음 pull 이 바뀐 것이 없어도 받게 대기에도 적는다 — `.base` · 사이드카가 새 DB 를 가리키게.
   */
  private register(databaseId: string, folder: string, titleProperty: string): void {
    const discovered = parseDiscoveredDbs(this.stateDb.getMeta(DISCOVERED_DBS_META_KEY));
    if (!discovered.some((d) => compactNotionId(d.databaseId) === compactNotionId(databaseId))) {
      discovered.push({ databaseId, localFolder: folder, titleProperty });
      this.stateDb.setMeta(DISCOVERED_DBS_META_KEY, JSON.stringify(discovered));
    }
    const pending = parsePendingDatabases(this.stateDb.getMeta(PENDING_DATABASES_META_KEY));
    pending.add(compactNotionId(databaseId));
    this.stateDb.setMeta(PENDING_DATABASES_META_KEY, serializePendingDatabases(pending));
  }

  private async readSidecar(path: string): Promise<SidecarSchema | null> {
    try {
      return parseSidecarSchema(await this.vaultFs.readFile(path));
    } catch {
      return null;
    }
  }

  /** 폴더의 사이드카 가운데 그 DB 의 것. pull 이 새 DB 로 고쳐 썼으면 그것도 받는다. */
  private async sidecarIn(folder: string, source: string): Promise<SidecarSchema | null> {
    let fallback: SidecarSchema | null = null;
    for (const file of await this.vaultFs.listNonMarkdownFiles()) {
      if (!SIDECAR_RE.test(file.path) || parentFolderOf(file.path) !== folder) continue;
      const schema = await this.readSidecar(file.path);
      if (schema?.databaseId === source) return schema;
      fallback ??= schema;
    }
    return fallback;
  }
}

/** 받은 status 속성의 옵션 — 다시 보낼 때 id 로 그대로 둔다. */
function optionsWithIds(prop: Record<string, unknown> | undefined): unknown[] {
  const options = (
    prop?.status as { options?: Array<{ id: string; name: string; color?: string }> }
  )?.options;
  return (options ?? []).map((o) => ({
    id: o.id,
    name: o.name,
    ...(o.color ? { color: o.color } : {}),
  }));
}

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
