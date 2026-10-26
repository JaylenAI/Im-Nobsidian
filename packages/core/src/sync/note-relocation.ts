import type { IStateDB } from "../state/state-db-interface.js";
import type { RemoteMove, SyncRecord } from "../types/sync.js";
import { isMarkdownPath, stripMarkdownExtension } from "../utils/markdown-path.js";
import { wikilinkTitleFromPath } from "../utils/wikilink-title.js";
import { DB_BASE_FILES_META_KEY } from "./db-base-files.js";
import { DISCOVERED_DBS_META_KEY, parseDiscoveredDbs } from "./discovered-databases.js";
import { isFolderRecord, parentFolderOf } from "./folder-container.js";
import type { VaultFS } from "./vault-fs.js";

/**
 * Notion 쪽 변화를 따라 볼트의 노트 · 폴더를 옮긴다 — 옮긴 페이지(ADR-039)와 바꾼 제목이 같이 쓴다.
 *
 * 옮기기 전에 막을 까닭을 다 보고({@link blocked}), 여럿을 옮기다 하나가 실패하면 옮긴 것을 되돌린다. 다 옮기면
 * 그 아래의 상태 DB 레코드 · 위키링크 · 보존 마커 · 첨부 기록을 새 경로로 옮겨 적는다.
 */
export class NoteRelocator {
  constructor(
    private readonly stateDb: IStateDB,
    private readonly vaultFs: VaultFS,
  ) {}

  /**
   * 함께 옮길 것 — 폴더로 추적하는 페이지는 그 폴더, 폴더 노트(`X/X.md`)는 든 폴더, 노트는 그 파일과 옆의 자식
   * 폴더(`X/`, 있으면).
   */
  unitsOf(record: SyncRecord): string[] {
    if (isFolderRecord(record)) return [record.obsidianPath];
    if (record.fileType !== "file") return [parentFolderOf(record.obsidianPath)];
    const children = stripMarkdownExtension(record.obsidianPath);
    const hasChildren = this.stateDb.getAll().some((r) => within(r.obsidianPath, children));
    return hasChildren ? [record.obsidianPath, children] : [record.obsidianPath];
  }

  /** 옮기지 못할 까닭 — 없으면 null. */
  async blocked(move: RemoteMove): Promise<string | null> {
    if (within(move.to, move.from)) return "제 안으로 옮길 수 없다";
    if (!(await this.vaultFs.exists(move.from))) return "볼트에 노트가 없다";
    if (await this.taken(move.to)) return `옮길 자리(${move.to})에 같은 이름이 있다`;
    const isFolder = !isMarkdownPath(move.from);
    if (this.vaultFs.excludesPath?.(move.to, isFolder ? "folder" : "file")) {
      return `옮길 자리(${move.to})가 동기화에서 빠진다(paths · .im-nobsidian-ignore)`;
    }
    if (isFolder && this.holdsDatabaseOrConnection(move.from)) {
      return "폴더 안에 DB 나 다른 연결이 있다 — DB 보기(.base)가 폴더 경로를 품는다. Obsidian 에서 옮기면 다음 push 가 Notion 을 맞춘다";
    }
    return null;
  }

  /** 이 경로에 파일 · 폴더가 있거나 추적하는 것이 있다. */
  async taken(path: string): Promise<boolean> {
    return (
      (await this.vaultFs.exists(path)) ||
      this.stateDb.getAll().some((r) => within(r.obsidianPath, path))
    );
  }

  /**
   * 차례로 옮기고 상태 DB 를 새 경로로 적는다. 하나라도 실패하면 옮긴 것을 되돌리고 던진다 — 상태 DB 는 옛 경로 그대로다.
   * @param alsoInTransaction 경로를 옮겨 적는 트랜잭션 안에서 함께 할 것.
   */
  async relocate(moves: readonly RemoteMove[], alsoInTransaction?: () => void): Promise<void> {
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
      alsoInTransaction?.();
    });
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
export function within(path: string, unit: string): boolean {
  return path === unit || path.startsWith(`${unit}/`);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function joinPath(folder: string, name: string): string {
  return folder === "" ? name : `${folder}/${name}`;
}
