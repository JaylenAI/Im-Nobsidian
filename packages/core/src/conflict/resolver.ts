import type { Conflict, ConflictStrategy } from "../types/sync.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { VaultFS } from "../sync/vault-fs.js";
import { threeWayMerge } from "./merger.js";
import { computeHash } from "../utils/hash.js";

export type ResolutionChoice = "local" | "remote" | "merge" | "duplicate";

export interface ResolutionResult {
  readonly path: string;
  readonly choice: ResolutionChoice;
  readonly success: boolean;
  readonly mergeHadConflicts?: boolean;
}

export class ConflictResolver {
  constructor(
    private readonly stateDb: IStateDB,
    private readonly vaultFs: VaultFS,
  ) {}

  async resolve(conflict: Conflict, choice: ResolutionChoice): Promise<ResolutionResult> {
    switch (choice) {
      case "local":
        return this.resolveLocal(conflict);
      case "remote":
        return this.resolveRemote(conflict);
      case "merge":
        return this.resolveMerge(conflict);
      case "duplicate":
        return this.resolveDuplicate(conflict);
    }
  }

  async resolveByStrategy(
    conflict: Conflict,
    strategy: ConflictStrategy,
  ): Promise<ResolutionResult> {
    switch (strategy) {
      case "local-first":
        return this.resolve(conflict, "local");
      case "remote-first":
        return this.resolve(conflict, "remote");
      case "duplicate":
        return this.resolve(conflict, "duplicate");
      case "manual":
        return this.resolve(conflict, "merge");
    }
  }

  async resolveAll(conflicts: Conflict[], strategy: ConflictStrategy): Promise<ResolutionResult[]> {
    const results: ResolutionResult[] = [];
    for (const conflict of conflicts) {
      const result = await this.resolveByStrategy(conflict, strategy);
      results.push(result);
    }
    return results;
  }

  private async resolveLocal(conflict: Conflict): Promise<ResolutionResult> {
    const hash = computeHash(conflict.localContent);
    this.stateDb.updateHash(
      conflict.syncRecord.id,
      hash,
      Buffer.from(conflict.localContent, "utf-8"),
    );
    this.stateDb.updateStatus(conflict.syncRecord.id, "synced");

    return { path: conflict.syncRecord.obsidianPath, choice: "local", success: true };
  }

  private async resolveRemote(conflict: Conflict): Promise<ResolutionResult> {
    await this.vaultFs.writeFile(conflict.syncRecord.obsidianPath, conflict.remoteContent);

    const hash = computeHash(conflict.remoteContent);
    this.stateDb.updateHash(
      conflict.syncRecord.id,
      hash,
      Buffer.from(conflict.remoteContent, "utf-8"),
    );
    this.stateDb.updateStatus(conflict.syncRecord.id, "synced");

    return { path: conflict.syncRecord.obsidianPath, choice: "remote", success: true };
  }

  private async resolveMerge(conflict: Conflict): Promise<ResolutionResult> {
    const base = conflict.baseContent ?? "";
    const mergeResult = threeWayMerge(base, conflict.localContent, conflict.remoteContent);

    await this.vaultFs.writeFile(conflict.syncRecord.obsidianPath, mergeResult.merged);

    const hash = computeHash(mergeResult.merged);
    this.stateDb.updateHash(conflict.syncRecord.id, hash, Buffer.from(mergeResult.merged, "utf-8"));

    if (mergeResult.success) {
      this.stateDb.updateStatus(conflict.syncRecord.id, "synced");
    }

    return {
      path: conflict.syncRecord.obsidianPath,
      choice: "merge",
      success: mergeResult.success,
      mergeHadConflicts: !mergeResult.success,
    };
  }

  private async resolveDuplicate(conflict: Conflict): Promise<ResolutionResult> {
    const originalPath = conflict.syncRecord.obsidianPath;
    const ext = originalPath.endsWith(".md") ? ".md" : "";
    const baseName = originalPath.replace(/\.md$/, "");
    const conflictPath = `${baseName}.conflict${ext}`;

    await this.vaultFs.writeFile(conflictPath, conflict.remoteContent);

    const localHash = computeHash(conflict.localContent);
    this.stateDb.updateHash(
      conflict.syncRecord.id,
      localHash,
      Buffer.from(conflict.localContent, "utf-8"),
    );
    this.stateDb.updateStatus(conflict.syncRecord.id, "synced");

    return { path: originalPath, choice: "duplicate", success: true };
  }

  generateDiff(conflict: Conflict): string {
    const localLines = conflict.localContent.split("\n");
    const remoteLines = conflict.remoteContent.split("\n");
    const lines: string[] = [];

    lines.push(`--- local: ${conflict.syncRecord.obsidianPath}`);
    lines.push(`+++ remote: Notion (${conflict.remoteChange.pageId})`);
    lines.push("");

    const maxLen = Math.max(localLines.length, remoteLines.length);
    for (let i = 0; i < maxLen; i++) {
      const localLine = localLines[i];
      const remoteLine = remoteLines[i];

      if (localLine === remoteLine) {
        lines.push(`  ${localLine ?? ""}`);
      } else {
        if (localLine !== undefined) lines.push(`- ${localLine}`);
        if (remoteLine !== undefined) lines.push(`+ ${remoteLine}`);
      }
    }

    return lines.join("\n");
  }
}
