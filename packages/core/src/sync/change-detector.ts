import type { LocalChange, SyncRecord } from "../types/sync.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { FileStatInfo } from "./vault-fs.js";
import { computeHash } from "../utils/hash.js";
import { isFolderRecord } from "./folder-container.js";
import {
  EMPTY_RENAME_HINTS,
  pairLocalMoves,
  pendingMoveOrigins,
  type RenameHints,
} from "./local-moves.js";

export interface FileInfo {
  readonly path: string;
  readonly content: string;
  readonly mtime: string;
}

/** 변경 감지 옵션 — 옮긴 노트를 찾는 데 쓴다(S-11). */
export interface LocalScanOptions {
  /** 플러그인이 적어 둔 이름 변경 힌트. */
  readonly hints?: RenameHints;
  /**
   * 이동으로 짝짓지 않을 경로 — 설정 DB 폴더의 행. 그 행의 이름 변경은 DB 동기화가 따로
   * 다룬다.
   */
  readonly excludeFromMoves?: (path: string) => boolean;
}

/**
 * 옮긴 것으로 짝지은 추적 노트. 상태 DB 는 아직 옛 경로(`record.obsidianPath`)를 적고 있다.
 */
export interface LocalMoveAdoption {
  readonly record: SyncRecord;
  /** 파일의 지금 경로. */
  readonly to: string;
  /** 마지막으로 Notion 에 반영한 경로 — 앞서 입양해 둔 이동이면 그 WAL 의 옛 경로. */
  readonly origin: string;
}

export interface LocalScan {
  /** 입양을 마친 것으로 보고 가른 변경 — 옮긴 노트는 새 경로의 `moved` 다. */
  readonly changes: LocalChange[];
  readonly adoptions: readonly LocalMoveAdoption[];
}

/** 볼트에서 본 파일 한 개. `hash` 가 null 이면 지난 동기화 뒤로 그대로라 읽지 않았다. */
interface ObservedFile {
  readonly path: string;
  readonly record: SyncRecord | null;
  readonly hash: string | null;
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
    options?: LocalScanOptions,
  ): Promise<LocalChange[]> {
    return (await this.scanLocalChangesFast(stats, readFile, options)).changes;
  }

  detectLocalChanges(currentFiles: FileInfo[], options?: LocalScanOptions): LocalChange[] {
    return this.scanLocalChanges(currentFiles, options).changes;
  }

  /** 파일 크기 · 수정 시각이 지난 동기화와 같으면 내용을 읽지 않는다. */
  async scanLocalChangesFast(
    stats: readonly FileStatInfo[],
    readFile: (path: string) => Promise<string>,
    options?: LocalScanOptions,
  ): Promise<LocalScan> {
    const moveOrigins = pendingMoveOrigins(this.stateDb.getIncompletePendingOperations());
    const observed: ObservedFile[] = [];
    for (const file of stats) {
      const record = this.stateDb.getByPath(file.path);
      const unchanged =
        hasRemotePage(record) &&
        !this.movePending(record, moveOrigins) &&
        record.localMtime === file.mtime &&
        record.localFileSize === file.size;
      observed.push({
        path: file.path,
        record,
        hash: unchanged ? null : computeHash(await readFile(file.path)),
      });
    }
    return this.assemble(observed, moveOrigins, options);
  }

  scanLocalChanges(currentFiles: readonly FileInfo[], options?: LocalScanOptions): LocalScan {
    const moveOrigins = pendingMoveOrigins(this.stateDb.getIncompletePendingOperations());
    const observed = currentFiles.map((file): ObservedFile => {
      const record = this.stateDb.getByPath(file.path);
      const unchanged =
        hasRemotePage(record) &&
        !this.movePending(record, moveOrigins) &&
        Boolean(record.localMtime) &&
        record.localMtime === file.mtime;
      return { path: file.path, record, hash: unchanged ? null : computeHash(file.content) };
    });
    return this.assemble(observed, moveOrigins, options);
  }

  /** 이름을 바꿔도 파일 크기 · 수정 시각은 그대로다 — 옮긴 노트는 그것으로 건너뛰지 않는다. */
  private movePending(record: SyncRecord, moveOrigins: ReadonlyMap<string, string>): boolean {
    const origin = moveOrigins.get(record.id);
    return origin !== undefined && origin !== record.obsidianPath;
  }

  private assemble(
    observed: readonly ObservedFile[],
    moveOrigins: ReadonlyMap<string, string>,
    options: LocalScanOptions | undefined,
  ): LocalScan {
    const excluded = options?.excludeFromMoves ?? (() => false);
    const changes: LocalChange[] = [];
    const untracked: Array<{ path: string; hash: string }> = [];
    const existing = new Set<string>();

    for (const file of observed) {
      existing.add(file.path);
      const { record, hash } = file;
      if (!hasRemotePage(record)) {
        if (record === null && !excluded(file.path))
          untracked.push({ path: file.path, hash: hash! });
        else
          changes.push({
            path: file.path,
            type: "created",
            currentHash: hash!,
            previousHash: null,
          });
        continue;
      }
      if (hash === null) continue;
      const origin = moveOrigins.get(record.id);
      if (origin !== undefined && origin !== file.path) {
        changes.push({
          path: file.path,
          type: "moved",
          currentHash: hash,
          previousHash: record.contentHash,
          movedFrom: origin,
        });
      } else if (record.contentHash !== hash) {
        changes.push({
          path: file.path,
          type: "modified",
          currentHash: hash,
          previousHash: record.contentHash,
        });
      }
    }

    const missing = this.stateDb.getByStatus("synced").filter(
      (record) =>
        hasRemotePage(record) &&
        !existing.has(record.obsidianPath) &&
        // 폴더 페이지는 파일이 아니다 — 폴더가 사라진 것은 파일 목록으로 알 수 없다.
        !isFolderRecord(record),
    );
    const movable = missing.filter((record) => !excluded(record.obsidianPath));
    const pairs = pairLocalMoves(
      movable.map((record) => ({
        path: record.obsidianPath,
        hash: record.contentHash,
        origin: moveOrigins.get(record.id),
      })),
      untracked,
      options?.hints ?? EMPTY_RENAME_HINTS,
    );

    const recordAt = new Map(movable.map((record) => [record.obsidianPath, record]));
    const hashAt = new Map(untracked.map((file) => [file.path, file.hash]));
    const adoptions: LocalMoveAdoption[] = [];
    for (const pair of pairs) {
      const record = recordAt.get(pair.from)!;
      const hash = hashAt.get(pair.to)!;
      const origin = moveOrigins.get(record.id) ?? record.obsidianPath;
      adoptions.push({ record, to: pair.to, origin });
      if (origin !== pair.to) {
        changes.push({
          path: pair.to,
          type: "moved",
          currentHash: hash,
          previousHash: record.contentHash,
          movedFrom: origin,
        });
      } else if (record.contentHash !== hash) {
        // Notion 에 반영하기 전에 원래 자리로 되돌렸다 — 이동은 없고 내용만 본다.
        changes.push({
          path: pair.to,
          type: "modified",
          currentHash: hash,
          previousHash: record.contentHash,
        });
      }
    }

    const pairedFrom = new Set(pairs.map((pair) => pair.from));
    const pairedTo = new Set(pairs.map((pair) => pair.to));
    for (const file of untracked) {
      if (pairedTo.has(file.path)) continue;
      changes.push({
        path: file.path,
        type: "created",
        currentHash: file.hash,
        previousHash: null,
      });
    }
    for (const record of missing) {
      if (pairedFrom.has(record.obsidianPath)) continue;
      changes.push({
        path: record.obsidianPath,
        type: "deleted",
        currentHash: "",
        previousHash: record.contentHash,
      });
    }

    return { changes, adoptions };
  }
}
