import type { LocalChange, SyncRecord } from "../types/sync.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { FileStatInfo } from "./vault-fs.js";
import { computeHash } from "../utils/hash.js";

export interface FileInfo {
  readonly path: string;
  readonly content: string;
  readonly mtime: string;
}

/**
 * 이 파일의 짝인 Notion 페이지를 알고 있는가.
 *
 * 페이지 ID 가 없는 레코드는 끝나지 않은 생성의 자리표시다(pushCreate 의 WAL). 해시가
 * 비어 있어 예전에는 "수정" 으로 분류됐고, 수정 경로는 페이지 ID 가 없으면 아무것도 보내지
 * 않은 채 updated 로 셌다. 짝이 없으니 "생성" 이다 — 생성 경로가 입양 확인부터 한다.
 */
function hasRemotePage(record: SyncRecord | null): record is SyncRecord {
  return record !== null && Boolean(record.notionPageId);
}

export class ChangeDetector {
  constructor(private readonly stateDb: IStateDB) {}

  async detectLocalChangesFast(
    stats: FileStatInfo[],
    readFile: (path: string) => Promise<string>,
  ): Promise<LocalChange[]> {
    const changes: LocalChange[] = [];
    const existingPaths = new Set<string>();

    for (const file of stats) {
      existingPaths.add(file.path);
      const record = this.stateDb.getByPath(file.path);

      if (!hasRemotePage(record)) {
        const content = await readFile(file.path);
        changes.push({
          path: file.path,
          type: "created",
          currentHash: computeHash(content),
          previousHash: null,
        });
        continue;
      }

      if (record.localMtime === file.mtime && record.localFileSize === file.size) {
        continue;
      }

      const content = await readFile(file.path);
      const currentHash = computeHash(content);
      if (record.contentHash !== currentHash) {
        changes.push({
          path: file.path,
          type: "modified",
          currentHash,
          previousHash: record.contentHash,
        });
      }
    }

    const syncedRecords = this.stateDb.getByStatus("synced");
    for (const record of syncedRecords) {
      if (!existingPaths.has(record.obsidianPath)) {
        if (record.fileType === "folder-note" || record.fileType === "folder-only") {
          if (!record.obsidianPath.endsWith(".md")) continue;
        }
        changes.push({
          path: record.obsidianPath,
          type: "deleted",
          currentHash: "",
          previousHash: record.contentHash,
        });
      }
    }

    return this.detectMoves(changes);
  }

  detectLocalChanges(currentFiles: FileInfo[]): LocalChange[] {
    const changes: LocalChange[] = [];
    const existingPaths = new Set<string>();

    for (const file of currentFiles) {
      existingPaths.add(file.path);
      const record = this.stateDb.getByPath(file.path);

      if (!hasRemotePage(record)) {
        changes.push({
          path: file.path,
          type: "created",
          currentHash: computeHash(file.content),
          previousHash: null,
        });
        continue;
      }

      if (record.localMtime && record.localMtime === file.mtime) {
        continue;
      }

      const currentHash = computeHash(file.content);
      if (record.contentHash !== currentHash) {
        changes.push({
          path: file.path,
          type: "modified",
          currentHash,
          previousHash: record.contentHash,
        });
      }
    }

    const syncedRecords = this.stateDb.getByStatus("synced");
    for (const record of syncedRecords) {
      if (!existingPaths.has(record.obsidianPath)) {
        if (record.fileType === "folder-note" || record.fileType === "folder-only") {
          if (!record.obsidianPath.endsWith(".md")) continue;
        }
        changes.push({
          path: record.obsidianPath,
          type: "deleted",
          currentHash: "",
          previousHash: record.contentHash,
        });
      }
    }

    return this.detectMoves(changes);
  }

  private detectMoves(changes: LocalChange[]): LocalChange[] {
    const result: LocalChange[] = [];
    const created = changes.filter((c) => c.type === "created");
    const deleted = changes.filter((c) => c.type === "deleted");
    const others = changes.filter((c) => c.type !== "created" && c.type !== "deleted");

    const matchedCreated = new Set<string>();
    const matchedDeleted = new Set<string>();

    for (const del of deleted) {
      const match = created.find(
        (c) => c.currentHash === del.previousHash && !matchedCreated.has(c.path),
      );
      if (match) {
        matchedCreated.add(match.path);
        matchedDeleted.add(del.path);
        result.push({
          path: match.path,
          type: "moved",
          currentHash: match.currentHash,
          previousHash: del.previousHash,
          movedFrom: del.path,
        });
      }
    }

    for (const c of created) {
      if (!matchedCreated.has(c.path)) result.push(c);
    }
    for (const d of deleted) {
      if (!matchedDeleted.has(d.path)) result.push(d);
    }
    result.push(...others);

    return result;
  }
}
