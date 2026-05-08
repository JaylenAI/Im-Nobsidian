import type { LocalChange } from "../types/sync.js";
import type { StateDB } from "../state/state-db.js";
import { computeHash } from "../utils/hash.js";

export interface FileInfo {
  readonly path: string;
  readonly content: string;
  readonly mtime: string;
}

export class ChangeDetector {
  constructor(private readonly stateDb: StateDB) {}

  detectLocalChanges(currentFiles: FileInfo[]): LocalChange[] {
    const changes: LocalChange[] = [];
    const existingPaths = new Set<string>();

    for (const file of currentFiles) {
      existingPaths.add(file.path);
      const currentHash = computeHash(file.content);
      const record = this.stateDb.getByPath(file.path);

      if (!record) {
        changes.push({
          path: file.path,
          type: "created",
          currentHash,
          previousHash: null,
        });
      } else if (record.contentHash !== currentHash) {
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
