import type { IStateDB } from "../state/state-db-interface.js";
import type { Config } from "../types/config.js";
import type { RemoteMove, RemoteMoveSkip, SyncRecord } from "../types/sync.js";
import { notionIdsEqual } from "../utils/id.js";
import { getLogger } from "../utils/logger.js";
import { isMarkdownPath, stripMarkdownExtension } from "../utils/markdown-path.js";
import { wikilinkTitleFromPath } from "../utils/wikilink-title.js";
import { DB_BASE_FILES_META_KEY } from "./db-base-files.js";
import { DISCOVERED_DBS_META_KEY, parseDiscoveredDbs } from "./discovered-databases.js";
import {
  childFolderOf,
  isFolderRecord,
  parentFolderOf,
  type FolderLookup,
} from "./folder-container.js";
import type { VaultFS } from "./vault-fs.js";

export interface RemoteMoveResult {
  readonly moved: readonly RemoteMove[];
  readonly skipped: readonly RemoteMoveSkip[];
}

/** 옮길 수 있는 레코드 — 페이지 노트와 폴더. 행은 DB 를 옮기지 못하고(API), 행의 자리는 DB 폴더가 정한다. */
const MOVABLE_TYPES: ReadonlySet<SyncRecord["fileType"]> = new Set([
  "file",
  "folder-note",
  "folder-only",
]);

/** 이 레코드의 Notion 부모가 바뀌었으면 옮길 대상이다 — 감지(RemoteDetector)가 묻는다. */
export function movedInNotion(record: SyncRecord, parentId: string): boolean {
  return (
    MOVABLE_TYPES.has(record.fileType) &&
    record.notionParentId !== null &&
    !notionIdsEqual(record.notionParentId, parentId)
  );
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
  constructor(
    private readonly config: Config,
    private readonly stateDb: IStateDB,
    private readonly vaultFs: VaultFS,
    private readonly folderLookup: () => FolderLookup,
  ) {}

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
      if (!record || !movedInNotion(record, parentId)) continue;
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

    const units = this.unitsOf(record);
    const moves = units.map((from) => ({ from, to: joinPath(folder, baseName(from)) }));
    if (moves.every((move) => move.from === move.to)) {
      if (!dryRun) this.stateDb.setNotionParentId(record.id, parentId);
      return { moves: [] };
    }
    for (const move of moves) {
      const blocked = await this.blocked(move);
      if (blocked) return skip(blocked);
    }
    if (dryRun) return { moves };

    // 노트와 자식 폴더를 함께 옮기다 한쪽에서 실패하면 옮긴 것을 되돌린다 — 상태 DB 는 아직 옛 경로다.
    const done: RemoteMove[] = [];
    try {
      for (const move of moves) {
        await this.vaultFs.moveFile(move.from, move.to);
        done.push(move);
      }
    } catch (error) {
      for (const move of done.reverse())
        await this.vaultFs.moveFile(move.to, move.from).catch(() => {});
      throw error;
    }
    this.stateDb.transaction(() => {
      for (const move of moves) this.rewritePaths(move);
      this.stateDb.setNotionParentId(record.id, parentId);
    });
    for (const move of moves) {
      getLogger().info(
        `[Im-Nobsidian] Notion 에서 옮긴 페이지를 볼트에서 옮김: ${move.from} → ${move.to}`,
      );
    }
    return { moves };
  }

  /** 새 부모 아래의 자식이 놓일 폴더 — 새 페이지를 받을 때와 같은 규칙. 루트면 `""`, 볼트에 없는 부모면 null. */
  private parentFolder(parentId: string): string | null {
    if (notionIdsEqual(parentId, this.config.notion.rootPageId)) return "";
    const parent = this.stateDb.getByNotionId(parentId);
    return parent ? childFolderOf(parent, this.folderLookup()) : null;
  }

  /**
   * 함께 옮길 것 — 폴더로 추적하는 페이지는 그 폴더, 폴더 노트(`X/X.md`)는 든 폴더, 노트는 그 파일과 옆의 자식
   * 폴더(`X/`, 있으면).
   */
  private unitsOf(record: SyncRecord): string[] {
    if (isFolderRecord(record)) return [record.obsidianPath];
    if (record.fileType !== "file") return [parentFolderOf(record.obsidianPath)];
    const children = stripMarkdownExtension(record.obsidianPath);
    const hasChildren = this.stateDb.getAll().some((r) => within(r.obsidianPath, children));
    return hasChildren ? [record.obsidianPath, children] : [record.obsidianPath];
  }

  /** 옮기지 못할 까닭 — 없으면 null. */
  private async blocked(move: RemoteMove): Promise<string | null> {
    if (within(move.to, move.from)) return "제 안으로 옮길 수 없다";
    if (!(await this.vaultFs.exists(move.from))) return "볼트에 노트가 없다";
    if (
      (await this.vaultFs.exists(move.to)) ||
      this.stateDb.getAll().some((r) => within(r.obsidianPath, move.to))
    ) {
      return `옮길 자리(${move.to})에 같은 이름이 있다`;
    }
    const isFolder = !isMarkdownPath(move.from);
    if (this.vaultFs.excludesPath?.(move.to, isFolder ? "folder" : "file")) {
      return `옮길 자리(${move.to})가 동기화에서 빠진다(paths · .im-nobsidian-ignore)`;
    }
    if (isFolder && this.holdsDatabaseOrConnection(move.from)) {
      return "폴더 안에 DB 나 다른 연결이 있다 — DB 보기(.base)가 폴더 경로를 품는다. Obsidian 에서 옮기면 다음 push 가 Notion 을 맞춘다";
    }
    return null;
  }

  private holdsDatabaseOrConnection(folder: string): boolean {
    const databases = parseDiscoveredDbs(this.stateDb.getMeta(DISCOVERED_DBS_META_KEY));
    if (databases.some((db) => within(db.localFolder.replace(/\/+$/, ""), folder))) return true;
    const baseFiles = this.stateDb.getMeta(DB_BASE_FILES_META_KEY);
    if (baseFiles) {
      try {
        const entries = Object.values(
          JSON.parse(baseFiles) as Record<string, { basePath?: string }>,
        );
        if (entries.some((entry) => entry.basePath && within(entry.basePath, folder))) return true;
      } catch {
        // 깨진 메타 — DB 폴더 목록과 행 레코드로 본다.
      }
    }
    if (
      this.stateDb.getAll().some((r) => r.fileType === "db-row" && within(r.obsidianPath, folder))
    ) {
      return true;
    }
    return this.vaultFs.holdsOtherConnection?.(folder) ?? false;
  }

  /** 옮긴 것 아래의 레코드 · 위키링크 · 보존 마커 · 첨부 기록을 새 경로로 옮겨 적는다. */
  private rewritePaths(move: RemoteMove): void {
    for (const record of this.stateDb.getAll()) {
      if (!within(record.obsidianPath, move.from)) continue;
      const from = record.obsidianPath;
      const to = move.to + from.slice(move.from.length);
      this.stateDb.updatePath(record.id, to);
      const entry = record.notionPageId ? this.stateDb.resolvePageId(record.notionPageId) : null;
      if (entry && entry.obsidianPath === from) {
        this.stateDb.deleteWikilink(from);
        this.stateDb.upsertWikilink({
          obsidianPath: to,
          notionPageId: entry.notionPageId,
          title: wikilinkTitleFromPath(to),
          aliases: entry.aliases,
        });
      }
      const markers = this.stateDb.getPreserveMarkers(from);
      if (markers.length > 0) {
        this.stateDb.storePreserveMarkers(to, markers);
        this.stateDb.storePreserveMarkers(from, []);
      }
      if (record.notionPageId) {
        for (const file of this.stateDb.getFilesByPageId(record.notionPageId)) {
          if (!within(file.localPath, move.from)) continue;
          this.stateDb.registerFile({
            localPath: move.to + file.localPath.slice(move.from.length),
            notionPageId: file.notionPageId,
            fileUploadId: file.fileUploadId,
            fileType: file.fileType,
            fileHash: file.fileHash,
            fileSize: file.fileSize,
          });
          this.stateDb.deleteFileRegistry(file.localPath);
        }
      }
    }
  }
}

/** `path` 가 `unit` 이거나 그 폴더 안이다. */
function within(path: string, unit: string): boolean {
  return path === unit || path.startsWith(`${unit}/`);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function joinPath(folder: string, name: string): string {
  return folder === "" ? name : `${folder}/${name}`;
}
