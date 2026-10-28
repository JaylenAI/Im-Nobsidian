import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import type { NotionClient } from "../notion/client.js";
import { isTrashedOrArchived } from "../notion/client.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { DatabaseSyncConfig } from "../types/config.js";
import type { RemoteChange, RemoteMove, RemoteMoveSkip, SyncRecord } from "../types/sync.js";
import { pagePathCandidates } from "../utils/db-row-path.js";
import { parseFrontmatter, snapshotFrontmatter } from "../utils/frontmatter.js";
import { getLogger } from "../utils/logger.js";
import { stripMarkdownExtension } from "../utils/markdown-path.js";
import { sanitizeFileName } from "../utils/sanitize.js";
import { isFolderRecord, parentFolderOf } from "./folder-container.js";
import { NoteRelocator, joinPath } from "./note-relocation.js";
import { retitledInNotion } from "./note-title.js";
import type { VaultFS } from "./vault-fs.js";

export interface RemoteRenameResult {
  /** 이름을 바꾼 노트 · 폴더 — 레코드마다 하나, 옛 경로 → 새 경로. dry-run 은 바꿀 것. */
  readonly renamed: readonly RemoteMove[];
  readonly skipped: readonly RemoteMoveSkip[];
  /** 실제로 옮긴 차례 그대로의 이동 — 다른 노트의 링크를 고칠 때 쓴다. */
  readonly applied: readonly RemoteMove[];
}

/**
 * Notion 에서 제목을 바꾼 페이지의 노트 이름을 바꾼다 — `sync.renameOnTitleChange` 를 켰을 때만.
 *
 * 끄면(기본) 예전처럼 파일 이름은 두고 새 제목을 frontmatter `title` 에 적는다. 켜면 새 제목으로 이름을 바꾸고 —
 * 새 페이지를 받을 때와 같은 이름 규칙이다(같은 이름이 있으면 페이지 id 접미사) — 다른 노트의 링크는 pull 끝에서
 * 고친다({@link LinkUpdater}). 노트 옆의 자식 폴더 · 폴더 노트의 폴더 · 폴더로 추적하는 페이지의 폴더도 바꾼다.
 *
 * 받기 전에 차례로 돈다 — 받기는 여럿을 함께 쓰므로, 폴더 이름을 바꾸는 동안 그 안의 노트를 쓰지 않게 한다.
 * DB 행은 행을 받을 때 바꾼다(DatabaseSyncer). 바꾸지 않는 것과 까닭은 옮긴 페이지(ADR-039)와 같다.
 */
export class RemoteRenameFollower {
  private readonly relocator: NoteRelocator;

  constructor(
    private readonly stateDb: IStateDB,
    private readonly vaultFs: VaultFS,
    private readonly notionClient: NotionClient,
    private readonly pageOf: (pageId: string) => Promise<PageObjectResponse>,
    configuredDatabases: readonly DatabaseSyncConfig[] = [],
  ) {
    this.relocator = new NoteRelocator(stateDb, vaultFs, configuredDatabases);
  }

  async follow(
    changes: readonly RemoteChange[],
    options: { readonly dryRun?: boolean } = {},
  ): Promise<RemoteRenameResult> {
    const renamed: RemoteMove[] = [];
    const skipped: RemoteMoveSkip[] = [];
    const applied: RemoteMove[] = [];
    for (const change of changes) {
      if (change.type !== "modified") continue;
      const record = this.stateDb.getByNotionId(change.pageId);
      if (!record || !RENAMABLE.has(record.fileType)) continue;
      if (this.vaultFs.excludesPath?.(record.obsidianPath)) continue;
      try {
        const outcome = await this.followOne(record, options.dryRun === true);
        if (outcome === null) continue;
        if ("reason" in outcome) {
          skipped.push(outcome);
          getLogger().warn(
            `[Im-Nobsidian] Notion 에서 바꾼 제목으로 노트 이름을 바꾸지 않음 (${outcome.path}): ${outcome.reason}`,
          );
          continue;
        }
        renamed.push(outcome.renamed);
        applied.push(...outcome.moves);
      } catch (error) {
        skipped.push({
          path: record.obsidianPath,
          reason: `이름을 바꾸지 못함: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return { renamed, skipped, applied };
  }

  /** 바꿀 것이 없으면 null. */
  private async followOne(
    record: SyncRecord,
    dryRun: boolean,
  ): Promise<RemoteMoveSkip | { renamed: RemoteMove; moves: RemoteMove[] } | null> {
    const page = await this.pageOf(record.notionPageId!);
    if (isTrashedOrArchived(page)) return null;
    const title = this.notionClient.extractTitle(page);
    if (!retitledInNotion(...(await this.frontmatters(record)), record.obsidianPath, title)) {
      return null;
    }
    const skip = (reason: string): RemoteMoveSkip => ({ path: record.obsidianPath, reason });
    if (this.stateDb.getIncompleteOpByState(record.id, "move")) {
      return skip(
        "볼트에서 옮긴 것을 아직 올리지 않았다 — 다음 push 가 Notion 을 볼트의 자리로 옮긴다",
      );
    }

    const moves = await this.freeMoves(record, sanitizeFileName(title));
    if (moves === null) return skip("새 이름의 자리가 모두 차 있다");
    for (const move of moves) {
      const blocked = await this.relocator.blocked(move);
      if (blocked) return skip(blocked);
    }
    const renamed = { from: record.obsidianPath, to: finalPath(record.obsidianPath, moves) };
    if (dryRun) return { renamed: { ...renamed, renamed: true }, moves: [] };

    await this.relocator.relocate(moves, () => {
      const entry = this.stateDb.resolvePageId(record.notionPageId!);
      if (entry) this.stateDb.upsertWikilink({ ...entry, obsidianPath: renamed.to, title });
    });
    getLogger().info(
      `[Im-Nobsidian] Notion 에서 바꾼 제목으로 노트 이름을 바꿈: ${renamed.from} → ${renamed.to}`,
    );
    return { renamed: { ...renamed, renamed: true }, moves };
  }

  /** 지난 동기화 때와 지금 노트의 frontmatter — 폴더는 둘 다 없다. */
  private async frontmatters(
    record: SyncRecord,
  ): Promise<[Record<string, unknown> | null, Record<string, unknown> | null]> {
    if (isFolderRecord(record)) return [null, null];
    const base = snapshotFrontmatter(record.baseSnapshot);
    try {
      return [base, parseFrontmatter(await this.vaultFs.readFile(record.obsidianPath)).data];
    } catch {
      return [base, null];
    }
  }

  /**
   * 새 이름으로 옮길 차례 — 새 페이지를 받을 때처럼 자연 이름부터, 차 있으면 id 접미사를 붙인 이름. 모두 차 있으면 null.
   * 폴더 노트는 노트 이름을 먼저 바꾸고 폴더를 바꾼다 — 거꾸로 하면 두 번째 이동의 출발점이 아직 없다.
   */
  private async freeMoves(record: SyncRecord, safeName: string): Promise<RemoteMove[] | null> {
    for (const candidate of pagePathCandidates("", safeName, record.notionPageId!)) {
      const name = stripMarkdownExtension(candidate);
      const moves = this.movesTo(record, name);
      let free = true;
      for (const move of moves) {
        if (move.from !== move.to && (await this.relocator.taken(move.to))) free = false;
      }
      if (free) return moves.filter((move) => move.from !== move.to);
    }
    return null;
  }

  private movesTo(record: SyncRecord, name: string): RemoteMove[] {
    const path = record.obsidianPath;
    if (isFolderRecord(record)) {
      return [{ from: path, to: joinPath(parentFolderOf(path), name) }];
    }
    if (record.fileType === "folder-note") {
      const folder = parentFolderOf(path);
      return [
        { from: path, to: joinPath(folder, `${name}.md`) },
        { from: folder, to: joinPath(parentFolderOf(folder), name) },
      ];
    }
    const [note, children] = this.relocator.unitsOf(record);
    const folder = parentFolderOf(path);
    const moves = [{ from: note!, to: joinPath(folder, `${name}.md`) }];
    if (children) moves.push({ from: children, to: joinPath(folder, name) });
    return moves;
  }
}

/** 레코드 이름을 바꿀 수 있는 것 — 페이지 노트 · 폴더 노트 · 폴더. 행은 DatabaseSyncer 가 바꾼다. */
const RENAMABLE: ReadonlySet<SyncRecord["fileType"]> = new Set([
  "file",
  "folder-note",
  "folder-only",
]);

/** 차례로 옮긴 뒤 `path` 가 놓이는 자리. */
function finalPath(path: string, moves: readonly RemoteMove[]): string {
  let current = path;
  for (const move of moves) {
    if (current === move.from || current.startsWith(`${move.from}/`)) {
      current = move.to + current.slice(move.from.length);
    }
  }
  return current;
}
