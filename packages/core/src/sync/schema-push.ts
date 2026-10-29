import type { IStateDB } from "../state/state-db-interface.js";
import type { DatabaseMeta } from "../notion/client.js";
import type { FailedOperation, LocalChange, PropertyRename, SyncRecord } from "../types/sync.js";
import type { VaultFS } from "./vault-fs.js";
import { DECORATION_KEYS } from "../notion/decoration-values.js";
import { rekeyRowFrontmatter } from "../converter/frontmatter-merge.js";
import {
  isEmptyFrontmatterValue,
  plainFrontmatterValue,
  replaceFrontmatterLines,
  sameFrontmatterValue,
  snapshotFrontmatter,
  splitFrontmatter,
} from "../utils/frontmatter.js";
import { computeHash } from "../utils/hash.js";
import { compactNotionId, notionIdsEqual } from "../utils/id.js";
import { getLogger } from "../utils/logger.js";
import { SchemaLedger } from "./schema-ledger.js";

/**
 * 볼트에서 바꾼 DB 속성 이름을 Notion 의 열 이름으로(P3 · ADR-045).
 *
 * Obsidian 의 «속성 이름 바꾸기» 는 그 키를 가진 모든 노트의 frontmatter 키를 바꾼다. 예전 push 는 이것을 «옛 키를 비우고
 * 모르는 새 키를 더함» 으로 읽어, Notion 의 그 열을 모든 행에서 비웠다 — 새 키는 DB 에 없는 속성이라 보내지 않았다.
 * 그래서 행을 올리기 전에 이름 바꾸기를 알아보고 열의 이름을 속성 id 로 바꾼다. 행의 값은 그대로다.
 *
 * 이름 바꾸기로 보는 것 — 한 DB 폴더에서:
 *  - 옛 키 A 가 DB 속성이고, 바뀐 행 모두에서 A 가 사라졌으며, 지난 동기화 때 A 에 값이 있던 행 모두에 새 키 B 가 생겼다.
 *  - 그중 한 행이라도 B 의 값이 A 의 지난 값과 같다 — 이름을 바꾼 뒤 값까지 고친 행이 있어도 된다. 그 값은 이름을 바꾼
 *    다음 보통 push 가 새 이름으로 보낸다. 행이 하나뿐이고 값까지 고쳤으면 «A 를 지우고 로컬 키 B 를 더함» 과 가를 수
 *    없어 이름 바꾸기로 보지 않는다.
 *  - 이 DB 의 어느 행 노트에도 A 가 남아 있지 않고, 바뀌지 않은 행에 B 가 없다.
 *  - B 는 그 data source 에 없는 이름이다 — 있는 이름으로 바꾸면 Notion 은 200 을 주고 말없이 `B 1` 로 바꾼다(실측).
 *    B 가 이미 있으면 값을 옮긴 것이라 보통 push 가 한다.
 */

/** 바꿀 이름 하나 — {@link VaultSchemaRenames.plan}. */
export interface PlannedRename extends PropertyRename {
  readonly databaseId: string;
  readonly dataSourceId: string;
  readonly propertyId: string;
  /** 그 키를 바꾼 행(이번 push 의 바뀐 행). */
  readonly rows: readonly SyncRecord[];
}

export interface RenamePlan {
  readonly planned: readonly PlannedRename[];
  /** 이름 바꾸기로 보이지만 Notion 에 옮길 수 없어 올리지 않을 행 — 올리면 그 열의 값을 비운다. */
  readonly refused: readonly FailedOperation[];
}

export interface RenameOutcome {
  readonly applied: readonly PropertyRename[];
  /** 이름 바꾸기 말고는 바뀐 것이 없어 동기화를 마친 행. */
  readonly settled: ReadonlySet<string>;
  /** 열 이름을 바꾸지 못해 올리지 않을 행. */
  readonly failed: readonly FailedOperation[];
}

interface Row {
  readonly record: SyncRecord;
  readonly base: Readonly<Record<string, unknown>>;
  readonly current: Readonly<Record<string, unknown>>;
}

/** frontmatter 에서 속성이 아닌 키 — 행 제목과 아이콘 · 커버. */
const NOT_PROPERTIES: ReadonlySet<string> = new Set(["title", ...DECORATION_KEYS]);

export class VaultSchemaRenames {
  private readonly ledger: SchemaLedger;

  constructor(
    private readonly stateDb: Pick<
      IStateDB,
      "getAll" | "getByPath" | "getMeta" | "setMeta" | "updateHash" | "transaction"
    >,
    private readonly vaultFs: Pick<VaultFS, "readFile">,
    private readonly notionClient: {
      getDatabaseMeta(databaseId: string): Promise<DatabaseMeta>;
      updateDataSourceProperties(
        dataSourceId: string,
        properties: Record<string, unknown>,
      ): Promise<Record<string, Record<string, unknown>>>;
    },
  ) {
    this.ledger = new SchemaLedger(stateDb);
  }

  /** 이번 push 의 바뀐 행에서 이름 바꾸기를 찾는다 — Notion 은 그런 DB 만 읽고, 쓰지 않는다. */
  async plan(changes: readonly LocalChange[]): Promise<RenamePlan> {
    const byDatabase = new Map<string, Row[]>();
    for (const change of changes) {
      if (change.type !== "modified") continue;
      const row = await this.changedRow(change.path);
      if (!row) continue;
      const key = compactNotionId(row.record.notionParentId!);
      byDatabase.set(key, [...(byDatabase.get(key) ?? []), row]);
    }

    const planned: PlannedRename[] = [];
    const refused: FailedOperation[] = [];
    for (const rows of byDatabase.values()) {
      const databaseId = rows[0]!.record.notionParentId!;
      const pairs = await this.localRenames(databaseId, rows);
      if (pairs.length === 0) continue;
      const meta = await this.notionClient.getDatabaseMeta(databaseId);
      for (const [from, to] of pairs) {
        const carrying = rows.filter((row) => Object.hasOwn(row.current, to));
        const folder = folderOf(carrying[0]!.record.obsidianPath);
        const owners = meta.dataSources.filter(
          (ds) => (ds.properties as Record<string, unknown> | undefined)?.[from] !== undefined,
        );
        if (owners.length === 0) continue; // DB 속성이 아니다 — 로컬 키의 이름을 바꾼 것
        const owner = owners[0]!;
        const ownProps = owner.properties as Record<string, { id?: string }>;
        if (Object.hasOwn(ownProps, to)) continue; // 있는 열로 값을 옮긴 것 — 보통 push
        const propertyId = ownProps[from]?.id;
        if (owners.length > 1 || typeof propertyId !== "string") {
          const error =
            `속성 이름 「${from}」 → 「${to}」 를 Notion 에 옮길 수 없어 올리지 않았습니다 — 이 DB 의 데이터 소스 ` +
            `여럿에 「${from}」 이 있습니다. Notion 에서 바꾸세요`;
          refused.push(
            ...carrying.map((row) => ({
              path: row.record.obsidianPath,
              operation: "update" as const,
              error,
            })),
          );
          continue;
        }
        planned.push({
          databaseId,
          dataSourceId: owner.id,
          propertyId,
          folder,
          from,
          to,
          rows: carrying.map((row) => row.record),
        });
      }
    }
    return { planned, refused };
  }

  /**
   * 열 이름을 바꾸고, 그 행들의 동기화 사본도 새 키로 — 사본이 옛 키를 들고 있으면 행 push 가 옛 열을 비운다. 이름
   * 바꾸기 말고 바뀐 것이 없는 행은 동기화를 마친 것으로 적는다.
   */
  async apply(planned: readonly PlannedRename[]): Promise<RenameOutcome> {
    const applied: PropertyRename[] = [];
    const settled = new Set<string>();
    const failed: FailedOperation[] = [];
    for (const rename of planned) {
      try {
        const after = await this.notionClient.updateDataSourceProperties(rename.dataSourceId, {
          [rename.propertyId]: { name: rename.to },
        });
        if (after[rename.to]?.id !== rename.propertyId) {
          getLogger().warn(
            `[Im-Nobsidian] 속성 이름 「${rename.from}」 → 「${rename.to}」: Notion 이 다른 이름을 붙였습니다 — Notion 에서 확인하세요`,
          );
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        for (const record of rename.rows) {
          failed.push({
            path: record.obsidianPath,
            operation: "update",
            error: `속성 이름 「${rename.from}」 → 「${rename.to}」 를 Notion 에서 바꾸지 못해 올리지 않았습니다: ${reason}`,
          });
        }
        continue;
      }
      applied.push({ folder: rename.folder, from: rename.from, to: rename.to });
      this.noteRenamed(rename);
      for (const record of rename.rows) {
        if (await this.rekeySnapshot(record, rename)) settled.add(record.obsidianPath);
      }
    }
    return { applied, settled, failed };
  }

  /** 바뀐 행 노트 — 지난 동기화 사본이 있는 DB 행만. */
  private async changedRow(path: string): Promise<Row | null> {
    const record = this.stateDb.getByPath(path);
    if (record?.fileType !== "db-row" || !record.notionParentId) return null;
    const base = snapshotFrontmatter(record.baseSnapshot);
    if (base === null) return null;
    try {
      const current = splitFrontmatter(await this.vaultFs.readFile(path)).data;
      return { record, base, current };
    } catch {
      return null;
    }
  }

  /** 바뀐 행이 말하는 이름 바꾸기 — 옛 키 → 새 키. 한 키를 두 갈래로 읽을 수 있으면 뺀다. */
  private async localRenames(
    databaseId: string,
    rows: readonly Row[],
  ): Promise<Array<readonly [string, string]>> {
    const candidates = new Map<string, Set<string>>();
    for (const { base, current } of rows) {
      for (const from of Object.keys(base)) {
        if (NOT_PROPERTIES.has(from) || Object.hasOwn(current, from)) continue;
        const value = plainFrontmatterValue(base[from]);
        if (isEmptyFrontmatterValue(value)) continue;
        for (const to of Object.keys(current)) {
          if (NOT_PROPERTIES.has(to) || Object.hasOwn(base, to)) continue;
          if (!sameFrontmatterValue(value, plainFrontmatterValue(current[to]))) continue;
          candidates.set(from, new Set([...(candidates.get(from) ?? []), to]));
        }
      }
    }

    const pairs: Array<readonly [string, string]> = [];
    const targets = new Map<string, number>();
    for (const [from, tos] of candidates) {
      const consistent = [...tos].filter((to) =>
        rows.every(
          ({ base, current }) =>
            !Object.hasOwn(current, from) &&
            (isEmptyFrontmatterValue(plainFrontmatterValue(base[from])) ||
              Object.hasOwn(current, to)),
        ),
      );
      if (consistent.length !== 1) continue;
      pairs.push([from, consistent[0]!]);
      targets.set(consistent[0]!, (targets.get(consistent[0]!) ?? 0) + 1);
    }
    const unique = pairs.filter(([, to]) => targets.get(to) === 1);
    if (unique.length === 0) return [];

    // 이번에 바뀌지 않은 행 — 옛 키가 남았거나 새 키를 이미 쓰면 이름 바꾸기가 아니다.
    const changed = new Set(rows.map((row) => row.record.id));
    const others = this.stateDb
      .getAll()
      .filter(
        (record) =>
          record.fileType === "db-row" &&
          record.notionParentId !== null &&
          notionIdsEqual(record.notionParentId, databaseId) &&
          !changed.has(record.id),
      );
    const keysOf = await Promise.all(others.map((record) => this.keysOf(record)));
    return unique.filter(([from, to]) =>
      keysOf.every((keys) => keys !== null && !keys.has(from) && !keys.has(to)),
    );
  }

  /** 행 노트에 지금 적힌 키 — 읽지 못하면 null(그 DB 의 이름 바꾸기는 보지 않는다). */
  private async keysOf(record: SyncRecord): Promise<Set<string> | null> {
    try {
      const data = splitFrontmatter(await this.vaultFs.readFile(record.obsidianPath)).data;
      return new Set(Object.keys(data).filter((key) => !isEmptyFrontmatterValue(data[key])));
    } catch {
      return null;
    }
  }

  /** 그 행의 사본을 새 키로 — 노트가 사본과 같아졌으면 true(동기화를 마쳤다). */
  private async rekeySnapshot(record: SyncRecord, rename: PlannedRename): Promise<boolean> {
    const snapshot = record.baseSnapshot?.toString("utf-8");
    if (snapshot === undefined) return false;
    const lines = rekeyRowFrontmatter(snapshot, new Map([[rename.from, rename.to]]), () => false);
    const next = lines === null ? null : replaceFrontmatterLines(snapshot, lines);
    if (next === null) return false;
    let local: string | null = null;
    try {
      local = await this.vaultFs.readFile(record.obsidianPath);
    } catch {
      // 읽지 못하면 사본만 고친다 — 행 push 가 다시 견준다.
    }
    const synced = local !== null && sameRow(local, next);
    const content = synced ? local! : next;
    this.stateDb.transaction(() => {
      this.stateDb.updateHash(record.id, computeHash(content), Buffer.from(content, "utf-8"));
    });
    return synced;
  }

  /** 지난 pull 이 본 스키마에도 새 이름을 적는다 — 다음 pull 이 이 이름 바꾸기를 Notion 의 것으로 다시 옮기지 않게. */
  private noteRenamed(rename: PlannedRename): void {
    const seen = this.ledger.get(rename.databaseId);
    const source = compactNotionId(rename.dataSourceId);
    const known = seen?.[source]?.[rename.propertyId];
    if (!seen || !known) return;
    this.ledger.set(rename.databaseId, {
      [source]: { ...seen[source], [rename.propertyId]: { ...known, name: rename.to } },
    });
  }
}

/** 두 노트가 frontmatter 값 · 본문 모두 같은가 — 적은 모양(따옴표 · 차례)은 보지 않는다. */
function sameRow(a: string, b: string): boolean {
  const left = splitFrontmatter(a);
  const right = splitFrontmatter(b);
  const keys = Object.keys(left.data);
  return (
    left.content === right.content &&
    keys.length === Object.keys(right.data).length &&
    keys.every((key) => sameFrontmatterValue(left.data[key], right.data[key]))
  );
}

function folderOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at);
}
