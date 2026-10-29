import type { IStateDB } from "../state/state-db-interface.js";
import type { SyncRecord } from "../types/sync.js";
import type { VaultFS } from "./vault-fs.js";
import { rekeyRowFrontmatter } from "../converter/frontmatter-merge.js";
import {
  plainFrontmatterValue,
  replaceFrontmatterLines,
  sameFrontmatterValue,
  snapshotFrontmatter,
} from "../utils/frontmatter.js";
import { computeHash } from "../utils/hash.js";
import { normalizeNotionId, notionIdsEqual } from "../utils/id.js";
import { sourceKeyOf, type SchemaChange } from "./schema-ledger.js";

/** {@link rekeyTrackedRows} 가 한 일. */
export interface RekeyOutcome {
  /** 키를 바꾼 행 노트의 레코드 id. */
  readonly rewritten: readonly string[];
  /** Notion 에서 지운 속성이지만 올리지 않은 로컬 값이 있어 남긴 키 — 경로와 키. */
  readonly kept: ReadonlyArray<{ readonly path: string; readonly key: string }>;
  /** 읽거나 쓰지 못한 행 — 있으면 다음 pull 이 다시 한다. */
  readonly failed: number;
}

/**
 * Notion 에서 바꾸거나 지운 속성을 이 DB 의 추적 행 노트에 옮긴다(P3 · ADR-045) — 행 페이지는 그대로라 다시 받지
 * 않는 행도. 키 이름만 바꾸고 값은 로컬 것을 둔다. 지난 동기화 사본(baseSnapshot)도 같이 바꾼다 — 사본이 옛 키를
 * 들고 있으면 다음 push 가 새 키를 «바뀐 값» 으로 보낸다.
 *
 * 지운 속성의 키는 로컬 값이 지난 동기화 그대로일 때만 뺀다. 올리지 않은 편집이면 로컬 키로 남기고 알린다 — 그
 * 값을 받을 열이 Notion 에 없다.
 *
 * @param pages 이번 조회의 행 — 행이 사는 data source 를 이것으로 안다.
 * @param soleSource 데이터 소스가 하나뿐인 DB 의 그 소스 — 조회에 없던 추적 행(조회 필터 밖)도 그 소스로 본다.
 */
export async function rekeyTrackedRows(
  stateDb: Pick<IStateDB, "getAll" | "updateHash" | "updateStatCache" | "transaction">,
  vaultFs: Pick<VaultFS, "readFile" | "writeFile" | "exists" | "getFileStat" | "excludesPath">,
  databaseId: string,
  pages: ReadonlyArray<{ readonly id: string; readonly parent?: unknown }>,
  changes: ReadonlyMap<string, SchemaChange>,
  soleSource: string | null,
): Promise<RekeyOutcome> {
  const sourceOf = new Map(
    pages.map((page) => [normalizeNotionId(page.id), sourceKeyOf(page, databaseId)]),
  );
  const rewritten: string[] = [];
  let failed = 0;
  const kept: Array<{ path: string; key: string }> = [];
  for (const record of stateDb.getAll()) {
    if (
      record.fileType !== "db-row" ||
      record.notionPageId === null ||
      record.notionParentId === null ||
      !notionIdsEqual(record.notionParentId, databaseId) ||
      (vaultFs.excludesPath?.(record.obsidianPath) ?? false)
    ) {
      continue;
    }
    const source = sourceOf.get(normalizeNotionId(record.notionPageId)) ?? soleSource;
    const change = source === null ? undefined : changes.get(source);
    if (!change || (change.renamed.size === 0 && change.removed.size === 0)) continue;
    try {
      const outcome = await rekeyRow(stateDb, vaultFs, record, change);
      if (outcome.wrote) rewritten.push(record.id);
      kept.push(...outcome.kept.map((key) => ({ path: record.obsidianPath, key })));
    } catch {
      failed++;
    }
  }
  return { rewritten, kept, failed };
}

async function rekeyRow(
  stateDb: Pick<IStateDB, "updateHash" | "updateStatCache" | "transaction">,
  vaultFs: Pick<VaultFS, "readFile" | "writeFile" | "exists" | "getFileStat">,
  record: SyncRecord,
  change: SchemaChange,
): Promise<{ wrote: boolean; kept: string[] }> {
  if (!(await vaultFs.exists(record.obsidianPath))) return { wrote: false, kept: [] };
  const local = await vaultFs.readFile(record.obsidianPath);
  const snapshot = record.baseSnapshot ? record.baseSnapshot.toString("utf-8") : null;
  const base = snapshotFrontmatter(record.baseSnapshot);
  const unmodified = computeHash(local) === record.contentHash;

  const kept: string[] = [];
  const dropLocal = (key: string, value: unknown): boolean => {
    if (!change.removed.has(key)) return false;
    if (
      unmodified ||
      (base !== null && sameFrontmatterValue(plainFrontmatterValue(base[key]), value))
    ) {
      return true;
    }
    kept.push(key);
    return false;
  };
  const nextLocal = rekeyed(local, change, dropLocal);
  const nextSnapshot =
    snapshot === null ? null : rekeyed(snapshot, change, (key) => change.removed.has(key));
  if (nextLocal === null && nextSnapshot === null) return { wrote: false, kept };

  if (nextLocal !== null) await vaultFs.writeFile(record.obsidianPath, nextLocal);
  // 손대지 않은 노트는 고쳐 쓴 그대로가 동기화 사본이다. 고친 노트는 사본만 새 키로 — 그 편집은 다음 push 가 올린다.
  const synced = unmodified ? (nextLocal ?? local) : (nextSnapshot ?? snapshot);
  const stat =
    unmodified && nextLocal !== null ? await vaultFs.getFileStat(record.obsidianPath) : null;
  if (synced !== null) {
    stateDb.transaction(() => {
      stateDb.updateHash(record.id, computeHash(synced), Buffer.from(synced, "utf-8"));
      if (stat) stateDb.updateStatCache(record.id, stat.mtime, stat.size);
    });
  }
  return { wrote: nextLocal !== null, kept };
}

function rekeyed(
  note: string,
  change: SchemaChange,
  dropped: (key: string, value: unknown) => boolean,
): string | null {
  const lines = rekeyRowFrontmatter(note, change.renamed, dropped);
  return lines === null ? null : replaceFrontmatterLines(note, lines);
}
