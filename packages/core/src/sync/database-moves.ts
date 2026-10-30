/**
 * 볼트에서 옮기거나 이름을 바꾼 DB 폴더를 Notion 의 DB 에도 반영한다(ADR-047).
 *
 * 예전에는 볼트 쪽 자리만 바꿨다(ADR-041) — Notion 의 DB 는 옛 부모 아래 옛 이름으로 남았다. `databases.update` 의
 * `parent` 로 DB 를 옮길 수 있다(2026-10-30 실측, DB id · 행 · 보기 그대로). 노트 이동(이동 WAL)처럼 옮겨 적을 때
 * «마지막으로 Notion 에 반영한 폴더» 를 메타({@link DB_MOVES_META_KEY})에 적고, 반영을 마치면 지운다 — 끊겨도 다음
 * push 가 마저 옮긴다.
 *
 * 🔴 볼트가 아는 페이지(루트 · 추적하는 페이지) 아래의 DB 만 옮긴다. 블록 안(토글 · 열)의 DB 나 루트 밖 워크스페이스의
 * DB(`databases` 선반에 받은 것)는 사용자가 다른 곳에 둔 것이라 볼트 쪽 자리만 바꾼다.
 */
import type { IStateDB } from "../state/state-db-interface.js";
import type { FailedOperation } from "../types/sync.js";
import { compactNotionId, notionIdsEqual } from "../utils/id.js";
import { getLogger } from "../utils/logger.js";
import { sanitizeFileName } from "../utils/sanitize.js";
import { ROOT_DATABASES_FOLDER } from "./discovered-databases.js";
import { folderContainer, parentFolderOf, type FolderLookup } from "./folder-container.js";
import { addPendingDatabases } from "./remote-scan.js";

export const DB_MOVES_META_KEY = "db_moves_pending";

/** Notion 에 반영할 DB 폴더 이동 — `from` 은 마지막으로 Notion 에 반영한 폴더. */
export interface PendingDatabaseMove {
  readonly databaseId: string;
  readonly from: string;
  readonly to: string;
}

export function loadDatabaseMoves(stateDb: Pick<IStateDB, "getMeta">): PendingDatabaseMove[] {
  const raw = stateDb.getMeta(DB_MOVES_META_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (m): m is PendingDatabaseMove =>
            typeof m?.databaseId === "string" &&
            typeof m?.from === "string" &&
            typeof m?.to === "string",
        )
      : [];
  } catch {
    return [];
  }
}

function saveDatabaseMoves(
  stateDb: Pick<IStateDB, "setMeta">,
  moves: readonly PendingDatabaseMove[],
): void {
  stateDb.setMeta(DB_MOVES_META_KEY, JSON.stringify(moves));
}

/**
 * 이번에 옮겨 적는 DB 폴더를 반영할 이동으로 적는다 — 앞서 반영하지 못한 이동이 있으면 그 출발 폴더를 지킨다. 마지막으로
 * 반영한 자리로 되돌아왔으면 반영할 것이 없어 지운다. 상태 DB 트랜잭션 안에서 부른다.
 */
export function recordDatabaseMoves(
  stateDb: Pick<IStateDB, "getMeta" | "setMeta">,
  moves: readonly PendingDatabaseMove[],
): void {
  if (moves.length === 0) return;
  saveDatabaseMoves(stateDb, mergeDatabaseMoves(loadDatabaseMoves(stateDb), moves));
}

/** 적어 둔 이동에 새 이동을 겹친다 — 같은 DB 는 처음 출발 폴더에서 마지막 자리로, 제자리면 뺀다. */
export function mergeDatabaseMoves(
  recorded: readonly PendingDatabaseMove[],
  moves: readonly PendingDatabaseMove[],
): PendingDatabaseMove[] {
  const pending = [...recorded];
  for (const move of moves) {
    const index = pending.findIndex((p) => notionIdsEqual(p.databaseId, move.databaseId));
    const from = index >= 0 ? pending[index]!.from : move.from;
    if (index >= 0) pending.splice(index, 1);
    if (from !== move.to)
      pending.push({ databaseId: compactNotionId(move.databaseId), from, to: move.to });
  }
  return pending;
}

/** DB 의 지금 자리를 읽고 바꾸는 요청. */
export interface DatabasePlacementClient {
  getDatabasePlacement(databaseId: string): Promise<{
    readonly parentType: string;
    readonly pageId: string | null;
    readonly title: string;
  }>;
  updateDatabasePlacement(
    databaseId: string,
    change: { readonly parentPageId?: string; readonly title?: string },
  ): Promise<void>;
}

/** 옮긴 DB 폴더의 새 부모 폴더 자리를 마련한다 — 새 폴더면 페이지를 만든다. 둘 수 없으면 까닭을 던진다. */
export interface DatabaseMoveTarget {
  readonly rootPageId: string;
  ensureFolderPage(folder: string): Promise<void>;
  folderLookup(): FolderLookup;
  folderMoveRefusal(folder: string, lookup: FolderLookup): string | null;
}

/** 반영한 DB 이동 하나. */
export interface AppliedDatabaseMove {
  readonly from: string;
  readonly to: string;
  /** Notion 의 DB 를 옮기거나 이름을 바꿨나 — 아니면 볼트 쪽 자리만 바뀐다(부모가 볼트 밖). */
  readonly inNotion: boolean;
}

export class DatabaseMover {
  constructor(
    private readonly stateDb: IStateDB,
    private readonly client: DatabasePlacementClient,
    private readonly target: DatabaseMoveTarget,
  ) {}

  /** 반영할 DB 이동 — dry-run 이 보인다. */
  pending(): PendingDatabaseMove[] {
    return loadDatabaseMoves(this.stateDb);
  }

  /**
   * 적어 둔 DB 이동을 Notion 에 반영한다 — 얕은 것부터. 실패는 폴더마다 까닭과 함께 남기고 다음 push 가 다시 한다.
   *
   * @param inScope 범위를 좁힌 push 는 그 범위 안의 폴더만.
   */
  async apply(
    inScope: (folder: string) => boolean,
    failed: FailedOperation[],
  ): Promise<AppliedDatabaseMove[]> {
    const applied: AppliedDatabaseMove[] = [];
    const moves = this.pending()
      .filter((move) => inScope(move.to))
      .sort((a, b) => a.to.split("/").length - b.to.split("/").length);
    for (const move of moves) {
      try {
        const inNotion = await this.applyOne(move);
        if (inNotion !== null) applied.push({ from: move.from, to: move.to, inNotion });
        this.settle(move);
      } catch (error) {
        failed.push({
          path: move.to,
          operation: "move",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return applied;
  }

  /** @returns Notion 에서 옮겼나(true) · 볼트 쪽만(false) · 반영할 것이 없어졌나(null). */
  private async applyOne(move: PendingDatabaseMove): Promise<boolean | null> {
    const lookup = this.target.folderLookup();
    const at = lookup.databaseAt(move.to);
    // 그 사이 다시 옮겼거나 DB 를 놓았다 — 새 이동이 따로 적힌다.
    if (!at || !notionIdsEqual(at, move.databaseId)) return null;

    const current = await this.client.getDatabasePlacement(move.databaseId);
    if (!current.pageId || !this.tracksPage(current.pageId)) {
      getLogger().info(
        `[Im-Nobsidian] DB 폴더를 옮김: ${move.from} → ${move.to} — Notion 의 DB 는 볼트가 받지 않는 곳에 있어 그대로 둠`,
      );
      return false;
    }

    const parentPageId = await this.parentPageOf(move.to);
    const fromName = folderName(move.from);
    const toName = folderName(move.to);
    // 폴더 이름이 DB 제목을 따르던 때만 제목을 바꾼다 — 받은 폴더 이름은 제목을 파일 이름으로 다듬은 것이다.
    const renames = fromName !== toName && sanitizeFileName(current.title) === fromName;
    const moves = !notionIdsEqual(current.pageId, parentPageId);
    if (!moves && !renames) return true;

    await this.client.updateDatabasePlacement(move.databaseId, {
      ...(moves ? { parentPageId } : {}),
      ...(renames ? { title: toName } : {}),
    });
    // 다음 pull 이 사이드카 · `.base` 를 새 자리 · 이름으로 다시 쓴다.
    addPendingDatabases(this.stateDb, [move.databaseId]);
    getLogger().info(
      `[Im-Nobsidian] Notion 의 DB 를 옮김: ${move.from} → ${move.to}${moves ? "" : " (이름만)"}`,
    );
    return true;
  }

  /** 새 자리의 부모 페이지 — 맨 위 · `databases` 선반이면 루트. */
  private async parentPageOf(folder: string): Promise<string> {
    const parentFolder = parentFolderOf(folder);
    if (!parentFolder) return this.target.rootPageId;
    // `databases` 선반은 페이지가 아니다 — 그 안의 DB 는 루트 아래에 선다(FolderPlacement 와 같다).
    if (
      parentFolder === ROOT_DATABASES_FOLDER &&
      !folderContainer(parentFolder, this.target.folderLookup())
    ) {
      return this.target.rootPageId;
    }
    const refusal = this.target.folderMoveRefusal(folder, this.target.folderLookup());
    if (refusal) throw new Error(refusal);
    await this.target.ensureFolderPage(parentFolder);
    const container = folderContainer(parentFolder, this.target.folderLookup());
    if (container?.kind !== "page") {
      throw new Error(
        `폴더(${parentFolder})의 Notion 페이지가 없어 DB 를 옮기지 않음 — 다음 push 가 폴더부터 만든다`,
      );
    }
    return container.pageId;
  }

  /** 루트거나 이 볼트가 추적하는 페이지인가. */
  private tracksPage(pageId: string): boolean {
    return (
      notionIdsEqual(pageId, this.target.rootPageId) || this.stateDb.getByNotionId(pageId) !== null
    );
  }

  private settle(move: PendingDatabaseMove): void {
    saveDatabaseMoves(
      this.stateDb,
      this.pending().filter(
        (p) => !(notionIdsEqual(p.databaseId, move.databaseId) && p.to === move.to),
      ),
    );
  }
}

function folderName(folder: string): string {
  return folder.slice(folder.lastIndexOf("/") + 1);
}
