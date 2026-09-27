import type { Conflict, ConflictStrategy } from "../types/sync.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { VaultFS } from "../sync/vault-fs.js";
import { removeTrackedNote } from "../sync/remote-deletion.js";
import { threeWayMerge } from "./merger.js";
import { computeHash } from "../utils/hash.js";

export type ResolutionChoice = "local" | "remote" | "merge" | "duplicate";

/**
 * Notion 에서 지운 노트의 충돌인가 — 올리지 않은 로컬 편집이 남은 채 원격이 휴지통 · 보관 · 없음이다.
 * 풀 수 있는 것은 «로컬 유지»(Notion 에 새 페이지로 다시 만든다)와 «원격 유지»(볼트에서도 지운다)
 * 뿐이다 — 병합하거나 사본으로 남길 원격 본문이 없다.
 */
export function isRemoteDeletion(conflict: Conflict): boolean {
  return conflict.remoteChange.type === "deleted";
}

const ALL_CHOICES: readonly ResolutionChoice[] = ["local", "remote", "merge", "duplicate"];
const REMOTE_DELETION_CHOICES: readonly ResolutionChoice[] = ["local", "remote"];

/** 이 충돌을 풀 수 있는 선택지 — 앱은 이것만 보여 준다. */
export function applicableChoices(conflict: Conflict): readonly ResolutionChoice[] {
  return isRemoteDeletion(conflict) ? REMOTE_DELETION_CHOICES : ALL_CHOICES;
}

/**
 * 전략이 이 충돌에 고르는 것. 원격에서 지운 노트는 복제할 원격이 없어 duplicate 도 «로컬 유지» —
 * 둘 다 잃는 것이 없다. manual 은 자동 병합인데 지운 원격과는 병합할 수 없어 던진다.
 */
export function choiceForStrategy(
  conflict: Conflict,
  strategy: ConflictStrategy,
): ResolutionChoice {
  switch (strategy) {
    case "local-first":
      return "local";
    case "remote-first":
      return "remote";
    case "duplicate":
      return isRemoteDeletion(conflict) ? "local" : "duplicate";
    case "manual":
      if (isRemoteDeletion(conflict)) {
        throw new Error(
          `Notion 에서 지운 노트는 자동 병합할 수 없음 — 로컬 유지나 원격 유지를 고르세요: ${conflict.syncRecord.obsidianPath}`,
        );
      }
      return "merge";
  }
}

export interface ResolutionResult {
  readonly path: string;
  readonly choice: ResolutionChoice;
  readonly success: boolean;
  readonly mergeHadConflicts?: boolean;
}

/**
 * 충돌을 볼트 파일과 상태 DB 에서 푼다. **Notion 에는 올리지 않는다.**
 *
 * 앱은 `SyncOrchestrator.resolveConflict` 를 쓴다 — 이 클래스로 푼 뒤 고른 결과를 Notion 에 올리고,
 * 올리지 못하면 충돌로 되돌린다. 이 클래스만 부르면 지난 동기화 사본만 해결 결과로 바뀌어, 다음
 * pull 이 바뀐 원격으로 고른 로컬 · 병합 결과를 덮는다(N-06).
 */
export class ConflictResolver {
  constructor(
    private readonly stateDb: IStateDB,
    private readonly vaultFs: VaultFS,
  ) {}

  async resolve(conflict: Conflict, choice: ResolutionChoice): Promise<ResolutionResult> {
    if (isRemoteDeletion(conflict)) return this.resolveRemoteDeletion(conflict, choice);
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
    return this.resolve(conflict, choiceForStrategy(conflict, strategy));
  }

  async resolveAll(conflicts: Conflict[], strategy: ConflictStrategy): Promise<ResolutionResult[]> {
    const results: ResolutionResult[] = [];
    for (const conflict of conflicts) {
      const result = await this.resolveByStrategy(conflict, strategy);
      results.push(result);
    }
    return results;
  }

  /**
   * Notion 에서 지운 노트 — «로컬 유지» 는 추적만 놓아 파일을 새 노트로 만든다(다음 push 가 새 페이지로
   * 올린다. 앱은 오케스트레이터가 곧바로 올린다). «원격 유지» 는 볼트에서도 지운다.
   */
  private async resolveRemoteDeletion(
    conflict: Conflict,
    choice: ResolutionChoice,
  ): Promise<ResolutionResult> {
    const record = conflict.syncRecord;
    if (!applicableChoices(conflict).includes(choice)) {
      throw new Error(
        `Notion 에서 지운 노트는 병합 · 복제로 풀 수 없음 — 로컬 유지나 원격 유지를 고르세요: ${record.obsidianPath}`,
      );
    }
    await removeTrackedNote(this.stateDb, this.vaultFs, record, choice === "remote");
    return { path: record.obsidianPath, choice, success: true };
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
