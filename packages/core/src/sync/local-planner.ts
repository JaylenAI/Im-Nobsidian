import type { IStateDB } from "../state/state-db-interface.js";
import type { Config } from "../types/config.js";
import type { FolderMoveChange, SyncRecord } from "../types/sync.js";
import { getLogger } from "../utils/logger.js";
import { wikilinkTitleFromPath } from "../utils/wikilink-title.js";
import type { ChangeDetector, LocalScan, LocalScanOptions } from "./change-detector.js";
import { DISCOVERED_DBS_META_KEY, parseDiscoveredDbs } from "./discovered-databases.js";
import { isFolderNotePath, isFolderRecord, type FolderLookup } from "./folder-container.js";
import type { FolderPlacement } from "./folder-placement.js";
import {
  deriveFolderMoves,
  foldersOf,
  hintedFolderTarget,
  isEmptyRenameHints,
  movePayload,
  moveOrigin,
  parseRenameHints,
  pendingMoveOrigins,
  pruneRenameHints,
  RENAME_HINTS_META_KEY,
  type FolderMove,
  type RenameHints,
} from "./local-moves.js";
import type { FileStatInfo, VaultFS } from "./vault-fs.js";

/**
 * 이번 실행의 로컬 스캔 — 옮긴 노트 · 폴더를 상태 DB 에 옮겨 적기 전의 결과(S-11).
 * dry-run 은 옮겨 적지 않고 {@link LocalView} 로 옮긴 뒤의 모습을 겹쳐 같은 판정을 쓴다.
 */
export interface LocalPlan {
  readonly scan: LocalScan;
  /** 스캔이 쓴 이름 변경 힌트 — 옮겨 적은 뒤 이 스냅샷만큼 지운다. */
  readonly hints: RenameHints;
  /** 옮겨진 폴더 레코드 — push 가 만든 폴더 페이지. */
  readonly folderMoves: readonly FolderMove[];
  /** 옮겨진 자동 발견 DB 폴더. */
  readonly databaseFolderMoves: readonly FolderMove[];
  /** 반영할 것이 없어 닫을 이동 WAL — {@link LocalPlanner.settledMoveOps}. */
  readonly settledMoveOps: readonly string[];
}

/** 옮겨 적은 뒤의 볼트 — 경로의 레코드와 폴더 판정. */
export interface LocalView {
  recordAt(path: string): SyncRecord | null;
  readonly lookup: FolderLookup;
}

/** Notion 에 반영할 폴더 이동. 레코드는 이미 새 경로(`to`)를 추적한다. */
export interface PendingFolderMove {
  readonly record: SyncRecord;
  /** 마지막으로 Notion 에 반영한 경로. */
  readonly from: string;
  readonly to: string;
}

/**
 * 이번 실행의 로컬 변경을 계획한다 — 변경 감지와, 볼트에서 옮기거나 이름을 바꾼 노트 · 폴더를 추적
 * 레코드와 다시 짝짓는 일(S-11).
 *
 * 옮긴 것은 상태 DB 에 옮겨 적은 뒤({@link adoptLocalMoves}) Notion 에는 부모와 제목만 바꿔 반영한다
 * (pushMove). 예전에는 이름을 바꾸면 옛 페이지를 두고 새 페이지를 만들거나(내용도 바꾼 경우), 짝을
 * 지어도 아무것도 하지 않았다. dry-run 은 옮겨 적지 않고 계획을 겹쳐 본다({@link localView}).
 */
export class LocalPlanner {
  constructor(
    private readonly config: Config,
    private readonly stateDb: IStateDB,
    private readonly vaultFs: VaultFS,
    private readonly changeDetector: ChangeDetector,
    private readonly placement: FolderPlacement,
  ) {}

  /** 변경 감지 옵션 — 플러그인이 적어 둔 이름 변경 힌트. */
  localScanOptions(): LocalScanOptions & { readonly hints: RenameHints } {
    return { hints: this.renameHints() };
  }

  renameHints(): RenameHints {
    return parseRenameHints(this.stateDb.getMeta(RENAME_HINTS_META_KEY));
  }

  writeRenameHints(hints: RenameHints): void {
    this.stateDb.setMeta(
      RENAME_HINTS_META_KEY,
      isEmptyRenameHints(hints) ? "" : JSON.stringify(hints),
    );
  }

  /** 이번 실행의 로컬 변경과 옮겨진 폴더. 상태 DB 는 바꾸지 않는다. */
  async planLocalChanges(stats: readonly FileStatInfo[]): Promise<LocalPlan> {
    const options = this.localScanOptions();
    const scan = await this.changeDetector.scanLocalChangesFast(
      stats,
      (path) => this.vaultFs.readFile(path),
      options,
    );
    return {
      scan,
      hints: options.hints,
      settledMoveOps: this.settledMoveOps(scan),
      ...(await this.planFolderMoves(stats, scan, options.hints)),
    };
  }

  /** 이번 실행이 옮겨 적을 레코드 id → 새 경로. dry-run 이 옮겨 적은 뒤의 경로로 보이는 데 쓴다. */
  plannedPaths(plan: LocalPlan | null): Map<string, string> {
    const paths = new Map<string, string>();
    if (!plan) return paths;
    for (const { record, to } of plan.scan.adoptions) paths.set(record.id, to);
    for (const { from, to } of [...plan.folderMoves, ...plan.databaseFolderMoves]) {
      const record = this.stateDb.getByPath(from);
      if (record) paths.set(record.id, to);
    }
    return paths;
  }

  /** 옮겨 적은 뒤의 볼트 — dry-run 도 실제 push 와 같은 판정을 쓰도록 계획을 겹쳐 본다. */
  localView(plan: LocalPlan): LocalView {
    const recorded = this.placement.folderLookup();
    const moved: Array<{ from: string; to: string; record: SyncRecord | null }> = [
      ...plan.scan.adoptions.map((a) => ({
        from: a.record.obsidianPath,
        to: a.to,
        record: a.record,
      })),
      ...plan.folderMoves.map((m) => ({ ...m, record: this.stateDb.getByPath(m.from) })),
    ];
    const recordAt = new Map<string, SyncRecord | null>();
    for (const m of moved) recordAt.set(m.from, null);
    for (const m of moved) recordAt.set(m.to, m.record);
    const databaseAt = new Map<string, string | null>();
    for (const m of plan.databaseFolderMoves) databaseAt.set(m.from, null);
    for (const m of plan.databaseFolderMoves) databaseAt.set(m.to, recorded.databaseAt(m.from));

    const at = (path: string): SyncRecord | null =>
      recordAt.has(path) ? recordAt.get(path)! : this.stateDb.getByPath(path);
    return {
      recordAt: at,
      lookup: {
        databaseAt: (folder) =>
          databaseAt.has(folder) ? databaseAt.get(folder)! : recorded.databaseAt(folder),
        pageIdAt: (path) => at(path)?.notionPageId ?? null,
      },
    };
  }

  /**
   * 옮긴 노트 · 폴더를 상태 DB 에 옮겨 적는다 — Notion 은 건드리지 않는다.
   *
   * 레코드가 새 경로를 추적해야 pull 이 옛 자리에 노트를 되살리지 않고, 원격 변경을 새 경로에
   * 쓴다. Notion 에 반영할 것은 이동 WAL 이 «마지막으로 반영한 경로» 로 적고, 반영을 마치면
   * 지운다(pushMove). 반영하기 전에 그 자리로 되돌아오면 반영할 것이 없어 바로 지운다.
   */
  adoptLocalMoves(plan: LocalPlan): void {
    const { adoptions } = plan.scan;
    const moved = adoptions.length + plan.folderMoves.length + plan.databaseFolderMoves.length;
    if (moved === 0 && plan.settledMoveOps.length === 0 && isEmptyRenameHints(plan.hints)) return;

    this.stateDb.transaction(() => {
      for (const opId of plan.settledMoveOps) this.stateDb.markPendingCompleted(opId);
      for (const { record, to } of adoptions) {
        this.moveRecord(record, to);
        // 폴더 노트인지는 경로가 정한다 — 새로 만들 때(pushCreate)와 같다. 행은 그대로 행이다.
        const fileType =
          record.fileType === "db-row" ? "db-row" : isFolderNotePath(to) ? "folder-note" : "file";
        if (fileType !== record.fileType) {
          this.stateDb.upsert({
            obsidianPath: to,
            notionPageId: record.notionPageId,
            notionParentId: record.notionParentId,
            contentHash: record.contentHash,
            notionLastEdited: record.notionLastEdited,
            notionLastEditedBy: record.notionLastEditedBy,
            notionSeenAt: record.notionSeenAt,
            notionBodyFingerprint: record.notionBodyFingerprint,
            localLastModified: record.localLastModified,
            syncDirection: record.syncDirection,
            fileType,
            status: record.status,
            baseSnapshot: record.baseSnapshot,
            localMtime: record.localMtime,
            localFileSize: record.localFileSize,
          });
        }
      }
      for (const move of plan.folderMoves) {
        const record = this.stateDb.getByPath(move.from);
        if (record) this.moveRecord(record, move.to);
      }
      if (plan.databaseFolderMoves.length > 0) {
        this.remapDiscoveredDbFolders(plan.databaseFolderMoves);
      }
      // 이번 스캔이 쓴 힌트만 지운다 — 그 사이 플러그인이 적은 힌트는 다음 실행이 쓴다.
      if (!isEmptyRenameHints(plan.hints)) {
        this.writeRenameHints(pruneRenameHints(this.renameHints(), plan.hints));
      }
    });

    if (moved > 0) {
      getLogger().info(
        `[Im-Nobsidian] 옮긴 노트 ${adoptions.length}건 · 폴더 ${
          plan.folderMoves.length + plan.databaseFolderMoves.length
        }건을 상태에 옮겨 적음`,
      );
    }
    for (const move of plan.databaseFolderMoves) {
      getLogger().info(
        `[Im-Nobsidian] DB 폴더를 옮김: ${move.from} → ${move.to} — 볼트 쪽 자리만 바뀐다. ` +
          `Notion 의 DB 는 옮기거나 이름을 바꾸지 않는다`,
      );
    }
  }

  /**
   * 변경 목록에 보일 폴더 이동 — Notion 에 반영할 폴더 페이지와, 볼트 쪽 자리만 바꿀 DB 폴더.
   * 옮긴 폴더는 노트가 아니라 {@link LocalChange} 가 없다. 예전에는 목록에 보이지 않고 push 결과의
   * 수에만 들었다.
   */
  folderMoveChanges(plan: LocalPlan): FolderMoveChange[] {
    return [...this.pendingFolderMoves(plan), ...plan.databaseFolderMoves].map(({ from, to }) => ({
      from,
      to,
    }));
  }

  /**
   * Notion 에 반영할 폴더 이동 — 앞선 실행에서 옮겨 적고 반영하지 못한 것까지, 얕은 것부터.
   * dry-run 은 이번 실행의 폴더 이동을 옮겨 적지 않았으므로 계획에서 더한다.
   */
  pendingFolderMoves(plan: LocalPlan): PendingFolderMove[] {
    const origins = pendingMoveOrigins(this.stateDb.getIncompletePendingOperations());
    const moves = new Map<string, PendingFolderMove>();
    if (origins.size > 0) {
      for (const record of this.stateDb.getAll()) {
        const from = origins.get(record.id);
        if (from !== undefined && from !== record.obsidianPath && isFolderRecord(record)) {
          moves.set(record.id, { record, from, to: record.obsidianPath });
        }
      }
    }
    for (const move of plan.folderMoves) {
      const record = this.stateDb.getByPath(move.from);
      if (!record) continue; // 이미 옮겨 적었다 — 위에서 WAL 로 셌다.
      const from = origins.get(record.id) ?? move.from;
      if (from === move.to) moves.delete(record.id);
      else moves.set(record.id, { record, from, to: move.to });
    }
    return [...moves.values()].sort((a, b) => a.to.split("/").length - b.to.split("/").length);
  }

  /**
   * 반영할 것이 없는 이동 WAL — 레코드가 마지막으로 Notion 에 반영한 자리에 이미 돌아와 있다.
   * 옮겨 적기 말고 다른 길로 제자리에 온 경우다. pull 의 DB 동기화는 DB 밖으로 옮겨 거절된 행을
   * 제 DB 폴더에 다시 쓰고 레코드를 옮긴다 — 그 WAL 은 아무도 닫지 않아 남는다. 이번에 옮겨 적는
   * 레코드의 WAL 은 옮겨 적을 때 정한다(moveRecord).
   */
  private settledMoveOps(scan: LocalScan): string[] {
    const ops = this.stateDb
      .getIncompletePendingOperations()
      .filter((op) => op.direction === "push" && op.operation === "move");
    if (ops.length === 0) return [];
    const adopting = new Set(scan.adoptions.map((adoption) => adoption.record.id));
    const pathOf = new Map(this.stateDb.getAll().map((record) => [record.id, record.obsidianPath]));
    return ops
      .filter(
        (op) =>
          !adopting.has(op.syncStateId) && moveOrigin(op.payload) === pathOf.get(op.syncStateId),
      )
      .map((op) => op.id);
  }

  /**
   * 옮겨진 폴더 — push 가 만든 폴더 페이지의 레코드와 자동 발견 DB 폴더. 새 자리는 폴더 힌트가,
   * 없으면 그 폴더에 있던 노트들의 짝이 정한다({@link deriveFolderMoves}). 새 자리를 이미 다른
   * 레코드 · DB 가 쓰고 있으면 옮기지 않는다.
   */
  private async planFolderMoves(
    stats: readonly FileStatInfo[],
    scan: LocalScan,
    hints: RenameHints,
  ): Promise<Pick<LocalPlan, "folderMoves" | "databaseFolderMoves">> {
    const lookup = this.placement.folderLookup();
    const folderRecords = new Set(
      this.stateDb
        .getAll()
        .filter((r) => isFolderRecord(r) && r.notionPageId && !lookup.databaseAt(r.obsidianPath))
        .map((r) => r.obsidianPath),
    );
    const configured = new Set(
      (this.config.notion.databases ?? []).map((db) => db.localFolder.replace(/\/+$/, "")),
    );
    const databaseFolders = new Set(
      parseDiscoveredDbs(this.stateDb.getMeta(DISCOVERED_DBS_META_KEY))
        .map((db) => db.localFolder.replace(/\/+$/, ""))
        .filter((folder) => folder && !configured.has(folder)),
    );
    const tracked = [...folderRecords, ...databaseFolders];
    if (tracked.length === 0) return { folderMoves: [], databaseFolderMoves: [] };

    // 노트가 없는 폴더(빈 DB 폴더 · 첨부만 든 폴더)도 볼트에 있을 수 있다 — 노트 목록에 없는
    // 폴더는 디스크에서 확인한다. 그대로 있으면 옮기지 않은 것이다.
    const live = foldersOf(stats.map((stat) => stat.path));
    for (const folder of tracked) {
      if (live.has(folder)) continue;
      if (await this.vaultFs.exists(folder)) {
        live.add(folder);
        continue;
      }
      const target = hintedFolderTarget(hints, folder);
      if (target !== null && !live.has(target) && (await this.vaultFs.exists(target))) {
        live.add(target);
      }
    }

    const pairs = scan.adoptions.map((a) => ({ from: a.record.obsidianPath, to: a.to }));
    const folderMoves: FolderMove[] = [];
    const databaseFolderMoves: FolderMove[] = [];
    for (const move of deriveFolderMoves(tracked, live, pairs, hints)) {
      if (this.stateDb.getByPath(move.to) || lookup.databaseAt(move.to)) continue;
      (folderRecords.has(move.from) ? folderMoves : databaseFolderMoves).push(move);
    }
    return { folderMoves, databaseFolderMoves };
  }

  /** 레코드를 새 경로로 옮겨 적는다 — 이동 WAL · 위키링크 · 보존 마커도 함께. */
  private moveRecord(record: SyncRecord, to: string): void {
    const from = record.obsidianPath;
    let op = this.stateDb.getIncompleteOpByState(record.id, "move");
    if (op && moveOrigin(op.payload) === null) {
      this.stateDb.markPendingFailed(op.id, "invalid move payload");
      op = null;
    }
    const origin = (op ? moveOrigin(op.payload) : null) ?? from;

    this.stateDb.updatePath(record.id, to);
    if (origin === to) {
      if (op) this.stateDb.markPendingCompleted(op.id);
    } else if (!op) {
      this.stateDb.recordPendingOperation({
        syncStateId: record.id,
        operation: "move",
        direction: "push",
        payload: movePayload(from),
      });
    }

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
  }

  /** 옮겨진 자동 발견 DB 폴더를 설정에 옮겨 적는다 — pull 이 행을 새 폴더에 쓴다. */
  private remapDiscoveredDbFolders(moves: readonly FolderMove[]): void {
    const target = new Map(moves.map((move) => [move.from, move.to]));
    const configs = parseDiscoveredDbs(this.stateDb.getMeta(DISCOVERED_DBS_META_KEY));
    let changed = false;
    for (const config of configs) {
      const to = target.get(config.localFolder.replace(/\/+$/, ""));
      if (to === undefined) continue;
      config.localFolder = to;
      changed = true;
    }
    if (changed) this.stateDb.setMeta(DISCOVERED_DBS_META_KEY, JSON.stringify(configs));
  }
}
