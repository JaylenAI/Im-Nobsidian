import type { IStateDB } from "../state/state-db-interface.js";
import type { Config } from "../types/config.js";
import type { RemoteMove, RemoteMoveSkip, SyncRecord } from "../types/sync.js";
import { notionIdsEqual } from "../utils/id.js";
import { getLogger } from "../utils/logger.js";
import { childFolderOf, type FolderLookup } from "./folder-container.js";
import { NoteRelocator, baseName, joinPath } from "./note-relocation.js";
import type { VaultFS } from "./vault-fs.js";

export interface RemoteMoveResult {
  readonly moved: readonly RemoteMove[];
  readonly skipped: readonly RemoteMoveSkip[];
}

/** 옮길 수 있는 레코드 — 페이지 노트와 폴더. 행은 DB 밖 페이지 아래로 나왔을 때만 옮긴다({@link movedInNotion}). */
const MOVABLE_TYPES: ReadonlySet<SyncRecord["fileType"]> = new Set([
  "file",
  "folder-note",
  "folder-only",
]);

/**
 * 이 레코드의 Notion 부모가 바뀌었으면 옮길 대상이다 — 감지(RemoteDetector)가 묻는다.
 *
 * 행은 볼트가 아는 페이지(루트 · 추적하는 페이지) 아래로 나왔을 때만 — 페이지가 된다(ADR-047). 다른 DB 로 간 행은
 * 그 DB 를 받을 때 그 DB 폴더로 옮긴다(DatabaseSyncer).
 *
 * @param tracksPage 루트거나 이 볼트가 추적하는 페이지인가 — 행만 묻는다.
 */
export function movedInNotion(
  record: SyncRecord,
  parentId: string,
  tracksPage: (pageId: string) => boolean,
): boolean {
  if (record.notionParentId === null || notionIdsEqual(record.notionParentId, parentId)) {
    return false;
  }
  if (MOVABLE_TYPES.has(record.fileType)) return true;
  return record.fileType === "db-row" && tracksPage(parentId);
}

/**
 * Notion 에서 옮긴 페이지를 볼트에서도 옮긴다 (ADR-039).
 *
 * `pages.move` 는 페이지의 수정 시각을 바꾸지 않아(2026-09-27 실측) 예전에는 감지되지 않았고, 볼트의 노트는 옛
 * 자리에 남았다. 감지는 전체 대조가 받은 부모와 상태 DB 의 부모를 견주어 한다. 옮기는 자리는 새 페이지를 받을
 * 때와 같다(`PagePuller.resolveParentPath`) — 새 부모의 폴더 안, 이름은 그대로다. 이름이 그대로라 다른 노트의
 * `[[이름]]` 은 끊기지 않는다.
 *
 * 노트는 파일 하나를, 폴더 노트(`X/X.md`) · 폴더는 폴더를 통째로 옮긴다. 노트 옆에 자식 폴더(`X/`)가 있으면 함께
 * 옮긴다. 다음은 옮기지 않고 까닭을 남긴다 — 볼트에서 옮기면 다음 push 가 Notion 을 그 자리로 맞춘다.
 *   - 볼트에서 옮긴 것을 아직 올리지 않았다 — 볼트가 먼저다(push 가 Notion 을 옮긴다)
 *   - 새 부모가 볼트에 없다 · 노트가 볼트에 없다 · 그 자리에 같은 이름이 있다 · 그 자리가 동기화에서 빠진다
 *   - 폴더 안에 DB 폴더나 다른 연결 폴더가 있다 — DB 의 `.base` 보기가 폴더 경로를 품고 있다
 */
export class RemoteMoveFollower {
  private readonly relocator: NoteRelocator;

  constructor(
    private readonly config: Config,
    private readonly stateDb: IStateDB,
    private readonly vaultFs: VaultFS,
    private readonly folderLookup: () => FolderLookup,
  ) {
    this.relocator = new NoteRelocator(stateDb, vaultFs, config.notion.databases ?? []);
  }

  /**
   * @param moved 페이지 id → Notion 의 새 부모 페이지 id.
   * @param options.dryRun 옮길 자리만 정하고 쓰지 않는다.
   */
  async follow(
    moved: ReadonlyMap<string, string>,
    options: { readonly dryRun?: boolean } = {},
  ): Promise<RemoteMoveResult> {
    const result: { moved: RemoteMove[]; skipped: RemoteMoveSkip[] } = { moved: [], skipped: [] };
    for (const [pageId, parentId] of moved) {
      const record = this.stateDb.getByNotionId(pageId);
      if (!record || !movedInNotion(record, parentId, (id) => this.tracksPage(id))) continue;
      if (this.vaultFs.excludesPath?.(record.obsidianPath)) continue;
      let outcome: RemoteMoveSkip | { readonly moves: readonly RemoteMove[] };
      try {
        outcome = await this.followOne(record, parentId, options.dryRun === true);
      } catch (error) {
        outcome = {
          path: record.obsidianPath,
          reason: `옮기지 못함: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if ("reason" in outcome) {
        result.skipped.push(outcome);
        getLogger().warn(
          `[Im-Nobsidian] Notion 에서 옮긴 페이지를 볼트에서 옮기지 않음 (${outcome.path}): ${outcome.reason}`,
        );
      } else if (outcome.moves.length > 0) {
        result.moved.push(...outcome.moves);
      }
    }
    return result;
  }

  private async followOne(
    record: SyncRecord,
    parentId: string,
    dryRun: boolean,
  ): Promise<RemoteMoveSkip | { readonly moves: readonly RemoteMove[] }> {
    const skip = (reason: string): RemoteMoveSkip => ({ path: record.obsidianPath, reason });
    if (this.stateDb.getIncompleteOpByState(record.id, "move")) {
      return skip(
        "볼트에서 옮긴 것을 아직 올리지 않았다 — 다음 push 가 Notion 을 볼트의 자리로 옮긴다",
      );
    }
    const folder = this.parentFolder(parentId);
    if (folder === null) return skip("Notion 의 새 부모가 볼트에 없다");

    const units = this.relocator.unitsOf(record);
    const moves = units.map((from) => ({ from, to: joinPath(folder, baseName(from)) }));
    if (moves.every((move) => move.from === move.to)) {
      if (!dryRun) this.stateDb.setNotionParentId(record.id, parentId);
      return { moves: [] };
    }
    for (const move of moves) {
      const blocked = await this.relocator.blocked(move);
      if (blocked) return skip(blocked);
    }
    if (dryRun) return { moves };

    await this.relocator.relocate(moves, () => {
      this.stateDb.setNotionParentId(record.id, parentId);
      // DB 밖으로 나온 행은 페이지가 된다 — 노트의 frontmatter(옛 속성)는 볼트에 그대로 둔다. Notion 은 옮기며 제목
      // 말고 속성을 버린다.
      if (record.fileType === "db-row") {
        const moved = this.stateDb.getByNotionId(record.notionPageId!);
        if (moved) this.stateDb.upsert({ ...moved, fileType: "file" });
      }
    });
    for (const move of moves) {
      getLogger().info(
        `[Im-Nobsidian] Notion 에서 옮긴 페이지를 볼트에서 옮김: ${move.from} → ${move.to}`,
      );
    }
    return { moves };
  }

  /** 루트거나 이 볼트가 추적하는 페이지인가. */
  tracksPage(pageId: string): boolean {
    return (
      notionIdsEqual(pageId, this.config.notion.rootPageId) ||
      this.stateDb.getByNotionId(pageId) !== null
    );
  }

  /** 새 부모 아래의 자식이 놓일 폴더 — 새 페이지를 받을 때와 같은 규칙. 루트면 `""`, 볼트에 없는 부모면 null. */
  private parentFolder(parentId: string): string | null {
    if (notionIdsEqual(parentId, this.config.notion.rootPageId)) return "";
    const parent = this.stateDb.getByNotionId(parentId);
    return parent ? childFolderOf(parent, this.folderLookup()) : null;
  }
}
