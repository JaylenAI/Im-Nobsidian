import type { NotionClient } from "../notion/client.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { Config } from "../types/config.js";
import type { LocalChange, SyncRecord } from "../types/sync.js";
import { notionIdsEqual } from "../utils/id.js";
import { getLogger } from "../utils/logger.js";
import { DISCOVERED_DBS_META_KEY, parseDiscoveredDbs } from "./discovered-databases.js";
import {
  ancestorFolders,
  databaseFolderIndex,
  enclosingDatabaseFolder,
  folderContainer,
  folderNoteOf,
  isFolderNotePath,
  isFolderRecord,
  parentFolderOf,
  type FolderLookup,
} from "./folder-container.js";
import type { InterruptedSyncRecovery } from "./interrupted-sync.js";
import type { LocalView } from "./local-planner.js";
import { isDatabaseMode } from "./parent-mode.js";
import type { RemoteDriftChecker } from "./remote-drift.js";
import { remoteBodyFingerprint } from "./remote-observation.js";
import type { RunObservation } from "./run-observation.js";

/**
 * 볼트 폴더의 Notion 자리 — 새 노트 · 옮긴 노트가 놓일 부모 페이지를 정하고, 폴더의 페이지를
 * 마련하고, 둘 자리가 없는 것은 이유와 함께 거절한다(S-04 · S-11 · S-15). 폴더가 Notion 에서
 * 무엇인지는 `folder-container.ts` 의 규칙이 정한다 — 여기는 그 규칙을 상태 DB · Notion 과 잇는다.
 */
export class FolderPlacement {
  /** DB 폴더 → DB id. 자동 발견 목록이 바뀔 때만 다시 만든다({@link folderLookup}). */
  private dbFolderCache: {
    readonly raw: string | null;
    readonly index: Map<string, string>;
  } | null = null;

  // 이번 push 에서 Notion 자리를 마련하지 못한 폴더 → 이유({@link prepareFolders}). 그 안의 노트가
  // 이 이유로 실패한다 — 「폴더 페이지가 아직 없다」 로 뭉개면 무엇을 고쳐야 하는지 모른다.
  private readonly unpreparedFolders = new Map<string, string>();

  constructor(
    private readonly config: Config,
    private readonly stateDb: IStateDB,
    private readonly notionClient: NotionClient,
    private readonly observation: RunObservation,
    private readonly drift: RemoteDriftChecker,
    private readonly recovery: InterruptedSyncRecovery,
  ) {}

  /** 지난 push 가 마련하지 못한 폴더를 잊는다 — push 마다 새로 적는다. */
  resetUnpreparedFolders(): void {
    this.unpreparedFolders.clear();
  }

  /**
   * 폴더 판정에 쓰는 조회 — DB 폴더(설정 · 자동 발견)와 추적 레코드. DB 폴더 표는 자동 발견
   * 목록이 바뀔 때만 다시 만든다(pull 이 새 DB 를 발견하면 바뀐다).
   */
  folderLookup(): FolderLookup {
    const raw = this.stateDb.getMeta(DISCOVERED_DBS_META_KEY);
    if (!this.dbFolderCache || this.dbFolderCache.raw !== raw) {
      this.dbFolderCache = {
        raw,
        // 설정 DB 를 앞에 둔다 — 같은 폴더를 가리키면 설정이 주인이다.
        index: databaseFolderIndex([
          ...(this.config.notion.databases ?? []),
          ...parseDiscoveredDbs(raw),
        ]),
      };
    }
    const index = this.dbFolderCache.index;
    return {
      databaseAt: (folder) => index.get(folder) ?? null,
      pageIdAt: (path) => this.stateDb.getByPath(path)?.notionPageId ?? null,
    };
  }

  /**
   * 이 경로에 새로 생긴 노트가 들어갈 DB — DB 폴더(설정 · 자동 발견) 직속이면 그 DB, 아니면
   * null(페이지). DB 모드는 모든 노트가 루트 DB 의 행이다 — 폴더는 Notion 의 자리를 정하지 않는다.
   */
  newRowDatabaseOf(path: string, lookup: FolderLookup = this.folderLookup()): string | null {
    if (isDatabaseMode(this.config)) return this.config.notion.databaseId!;
    return lookup.databaseAt(parentFolderOf(path));
  }

  /**
   * 새 페이지가 놓일 부모 페이지 — 폴더 노트 · 폴더 페이지 · 페이지 이름의 하위 폴더(DB 를 품은
   * 페이지 · 행)의 페이지. DB 폴더 직속 노트는 행이라 여기 오지 않는다.
   *
   * 자리가 없는 폴더의 폴더 노트는 그 폴더의 자리가 된다 — 폴더가 설 자리(폴더의 부모)에 만든다.
   * pull 이 폴더 노트를 그렇게 받고, 옮길 때(moveParentOf)도 같다.
   */
  async resolveNotionParent(filePath: string): Promise<string> {
    const folder = parentFolderOf(filePath);
    if (!folder) return this.config.notion.rootPageId;

    const lookup = this.folderLookup();
    const container = folderContainer(folder, lookup);
    if (container?.kind === "database") {
      throw new Error("DB 폴더의 노트는 페이지가 아니라 행이다");
    }
    if (isFolderNotePath(filePath)) {
      // push 가 만든 폴더 페이지는 폴더 노트가 삼는다(prepareFolders) — 여기 왔으면 아직 삼지 못한
      // 것이다. 그 아래에 만들면 같은 이름의 페이지가 두 겹이 된다(S-15).
      const folderRecord = this.stateDb.getByPath(folder);
      if (folderRecord?.notionPageId && isFolderRecord(folderRecord)) {
        throw new Error(
          `폴더(${folder})의 페이지를 아직 폴더 노트의 페이지로 삼지 못해 만들지 않음 — ` +
            `폴더 이동 · 앞선 생성 요청이 끝나면 다음 push 가 삼는다`,
        );
      }
      if (!container && !enclosingDatabaseFolder(folder, lookup)) {
        const placement = parentFolderOf(folder);
        if (!placement) return this.config.notion.rootPageId;
        const parent = folderContainer(placement, lookup);
        if (parent?.kind === "page") return parent.pageId;
        throw new Error(
          this.placementRefusal(placement, lookup, "create") ??
            this.folderNotReady(placement, "만들지"),
        );
      }
    }
    if (container?.kind === "page") return container.pageId;
    // 폴더의 자리는 파일보다 먼저 마련한다(prepareFolders). 여기 온 것은 둘 자리가 없는 폴더,
    // 자리를 마련하지 못한 폴더, 같은 push 에서 새 행이 생겨 그 아래 폴더의 자리가 그제서야 정해진
    // 경우다 — 루트에 두면 엉뚱한 곳에 생기므로 실패로 남긴다. 재시도가 폴더를 다시 본다.
    throw new Error(
      this.placementRefusal(folder, lookup, "create") ?? this.folderNotReady(folder, "만들지"),
    );
  }

  /**
   * 옮긴 페이지가 놓일 부모 페이지. 폴더 노트는 그 폴더의 페이지라 폴더의 부모 자리에 선다 —
   * pull 이 폴더 노트를 그렇게 받는다. 새 폴더의 자리는 앞서 마련한다(prepareFolders).
   */
  moveParentOf(path: string): string {
    const folder = pagePlacementFolder(path);
    if (!folder) return this.config.notion.rootPageId;
    const lookup = this.folderLookup();
    const container = folderContainer(folder, lookup);
    if (container?.kind === "page") return container.pageId;
    if (container?.kind === "database") {
      throw new Error(`페이지를 DB 폴더(${folder})로 옮기지 않음 — DB 에는 행만 든다`);
    }
    throw new Error(
      this.placementRefusal(folder, lookup, "move") ?? this.folderNotReady(folder, "옮기지"),
    );
  }

  /**
   * 새 노트 · 옮긴 노트가 들어갈 폴더의 Notion 자리를 마련한다 — 얕은 것부터.
   *
   * 폴더 노트 `F/F.md` 가 폴더 F 의 페이지다(pull 이 그렇게 받는다). 그래서 이번 push 에 새 폴더
   * 노트가 있으면 폴더 페이지를 따로 만들지 않는다.
   *
   * - 폴더에 아직 자리가 없으면 폴더 노트를 먼저 올린다. 폴더가 설 자리(폴더의 부모)에 생기고, 같은
   *   폴더의 노트 · 하위 폴더는 그 아래로 간다.
   * - push 가 앞서 만든 폴더 페이지가 있으면 그 페이지를 폴더 노트의 페이지로 삼는다
   *   ({@link adoptFolderPage}). 새로 만들지 않고 본문을 채워 하위 페이지와 페이지 id 가 그대로다.
   *
   * 예전에는 폴더 페이지를 먼저 만들고 폴더 노트를 그 아래에 만들어 같은 이름의 페이지가 두 겹으로
   * 생기고, 형제 노트는 어느 쪽이 먼저 생겼느냐에 따라 두 부모로 갈렸다(S-15). DB 모드는 모든 노트가
   * 루트 DB 의 행이라 마련할 폴더가 없다({@link foldersToEnsure}).
   *
   * 자리를 마련하지 못한 폴더는 이유를 적어 두고 넘어간다({@link unpreparedFolders}) — 그 안의 노트와
   * 하위 폴더가 그 이유로 실패한다. 예전 첫 차례는 폴더 하나를 못 만들면 push 전체가 멈췄다.
   *
   * @param pushFolderNote 먼저 올릴 폴더 노트를 올린다. 실패는 호출자가 재시도 · 실패로 다룬다.
   * @returns 여기서 올린 폴더 노트의 경로 — 호출자는 다시 올리지 않는다.
   */
  async prepareFolders(
    changes: readonly LocalChange[],
    pushFolderNote: (change: LocalChange) => Promise<void>,
  ): Promise<Set<string>> {
    this.unpreparedFolders.clear();
    const newNotes = new Map(
      changes.filter((c) => c.type === "created").map((c) => [c.path, c] as const),
    );
    const pushed = new Set<string>();
    for (const folder of this.foldersToEnsure(changes)) {
      const inherited = ancestorFolders(folder)
        .map((ancestor) => this.unpreparedFolders.get(ancestor))
        .find((reason) => reason !== undefined);
      if (inherited !== undefined) {
        this.unpreparedFolders.set(folder, inherited);
        continue;
      }
      try {
        const note = newNotes.get(folderNoteOf(folder));
        const lookup = this.folderLookup();
        if (note && !lookup.databaseAt(folder)) {
          if (this.adoptFolderPage(folder, note.path)) continue;
          if (!folderContainer(folder, lookup) && !enclosingDatabaseFolder(folder, lookup)) {
            pushed.add(note.path);
            await pushFolderNote(note);
            if (!folderContainer(folder, this.folderLookup())) {
              throw new Error(`폴더 노트(${note.path})를 올리지 못함`);
            }
            continue;
          }
        }
        await this.ensureFolderPage(folder);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.unpreparedFolders.set(folder, reason);
        getLogger().warn(`[Im-Nobsidian] 폴더(${folder})의 Notion 자리를 마련하지 못함: ${reason}`);
      }
    }
    return pushed;
  }

  async ensureFolderPage(folderPath: string): Promise<void> {
    // DB 폴더는 DB 다. 폴더 이름과 같은 제목의 행은 폴더 노트가 아니다 — 아래 폴더 노트 규칙을
    // 타면 그 행을 폴더의 페이지로 여겨 폴더 레코드를 지운다.
    const lookup = this.folderLookup();
    if (lookup.databaseAt(folderPath)) return;

    // 이미 자리가 있는 폴더(폴더 노트 · 폴더 페이지 · 페이지 이름의 하위 폴더)는 만들지 않는다.
    // DB 폴더 안의 다른 하위 폴더는 만들 자리가 없다 — 그 안의 노트가 이유와 함께 실패로 남는다
    // (resolveNotionParent). 예전에는 DB 폴더와 함께 빈 페이지로 만들었다(S-04).
    if (folderContainer(folderPath, lookup) || enclosingDatabaseFolder(folderPath, lookup)) {
      return;
    }

    // 폴더 노트의 생성 요청이 적용됐는지 모르는 채 남아 있으면 그 페이지가 폴더의 페이지일 수
    // 있다 — 폴더 페이지를 따로 만들면 같은 이름의 페이지가 둘이 된다(S-15). 폴더 노트의 생성을
    // 먼저 매듭짓는다(pushCreate 가 부모에서 찾아 이어 쓴다).
    const notePath = folderNoteOf(folderPath);
    const note = this.stateDb.getByPath(notePath);
    if (
      !isDatabaseMode(this.config) &&
      note &&
      !note.notionPageId &&
      this.stateDb.getIncompleteOpByState(note.id, "create")
    ) {
      throw new Error(
        `폴더 노트(${notePath})의 생성이 아직 끝나지 않아 폴더 페이지를 따로 만들지 않음 — ` +
          `폴더 노트가 폴더의 페이지다`,
      );
    }

    const parts = folderPath.split("/");
    const folderName = parts[parts.length - 1]!;

    let parentId = this.config.notion.rootPageId;
    if (parts.length > 1) {
      const parentPath = parts.slice(0, -1).join("/");
      await this.ensureFolderPage(parentPath);
      const parent = folderContainer(parentPath, this.folderLookup());
      // 부모에 자리가 없으면 만들지 않는다 — 예전에는 루트에 만들어 폴더가 엉뚱한 곳에 생겼다.
      if (parent?.kind !== "page") throw new Error(this.folderNotReady(parentPath, "만들지"));
      parentId = parent.pageId;
    }

    // 폴더 페이지 생성에는 WAL 이 없다. 생성 요청이 적용됐는데 응답을 못 받으면(S-07 —
    // 클라이언트는 그런 생성 요청을 다시 보내지 않는다) 레코드 없이 페이지만 남고, 다음
    // push 가 같은 폴더 페이지를 또 만든다. 그래서 만들기 전에 부모에서 먼저 찾는다 —
    // 새 폴더에서만 드는 목록 조회 1회다.
    const found = await this.recovery.findChildPageByTitle(parentId, folderName);
    const folderPage =
      found ??
      (await this.notionClient.createPage({
        parentId,
        parentType: "page",
        title: folderName,
      }));
    // 폴더 페이지의 본문 지문 — 폴더 노트가 이 페이지를 삼으면(S-15) 그 push 가 본문이 그대로임을
    // 확인한다. 곧 그 아래에 노트가 생겨 수정 시각이 바뀌므로 시각으로는 가를 수 없다.
    const bodyFingerprint = found
      ? await this.drift.remoteBodyFingerprintOf(found.id)
      : remoteBodyFingerprint("");

    this.stateDb.upsert({
      obsidianPath: folderPath,
      notionPageId: folderPage.id,
      notionParentId: parentId,
      contentHash: "",
      ...this.observation.fieldsOf(folderPage, bodyFingerprint),
      localLastModified: new Date().toISOString(),
      syncDirection: "both",
      fileType: "folder-note",
      status: "synced",
    });
  }

  /**
   * 둘 자리가 없어 만들지 않을 새 노트 → 이유. 같은 push 에서 생길 새 행도 자리로 센다 —
   * `DB/행.md` 와 `DB/행/노트.md` 를 함께 만들면 행이 먼저 생기고 노트는 그 아래로 간다.
   *
   * @param recorded 옮긴 노트 · 폴더를 옮겨 적은 뒤의 폴더 판정({@link localView}).
   */
  refusedCreates(changes: readonly LocalChange[], recorded: FolderLookup): Map<string, string> {
    const newRows = new Set(
      changes
        .filter((c) => c.type === "created" && this.newRowDatabaseOf(c.path, recorded))
        .map((c) => c.path),
    );
    const lookup: FolderLookup = {
      databaseAt: recorded.databaseAt,
      // 새 행은 아직 id 가 없다 — 여기서는 자리가 있는지만 본다.
      pageIdAt: (path) => recorded.pageIdAt(path) ?? (newRows.has(path) ? "(새 행)" : null),
    };
    const refused = new Map<string, string>();
    for (const change of changes) {
      if (change.type !== "created" || newRows.has(change.path)) continue;
      const reason = this.placementRefusal(parentFolderOf(change.path), lookup, "create");
      if (reason) refused.set(change.path, reason);
    }
    return refused;
  }

  /**
   * Notion 에서 그렇게 옮길 수 없는 노트 → 이유(S-11). DB 모드는 모든 노트가 루트 DB 의 행이라
   * 폴더가 Notion 의 자리를 정하지 않는다 — 거절할 것이 없다.
   */
  refusedMoves(changes: readonly LocalChange[], view: LocalView): Map<string, string> {
    const refused = new Map<string, string>();
    if (isDatabaseMode(this.config)) return refused;
    for (const change of changes) {
      if (change.type !== "moved") continue;
      const record = view.recordAt(change.path);
      if (!record) continue;
      const reason = this.moveRefusal(change, record, view.lookup);
      if (reason) refused.set(change.path, reason);
    }
    return refused;
  }

  /** 옮긴 폴더의 페이지를 Notion 에서 그 자리로 옮길 수 없는 이유. 옮길 수 있으면 null. */
  folderMoveRefusal(folder: string, lookup: FolderLookup): string | null {
    const parent = parentFolderOf(folder);
    if (!parent) return null;
    if (lookup.databaseAt(parent)) {
      return (
        `폴더를 DB 폴더(${parent}) 안으로 옮기지 않음 — DB 에는 행만 든다. ` +
        `DB 폴더 밖으로 옮기세요`
      );
    }
    return this.placementRefusal(parent, lookup, "move");
  }

  /**
   * 587b405 이전 push 가 남긴 잘못된 폴더 레코드를 지운다 — 루트 페이지를 맨 위 폴더의 페이지로
   * 적은 레코드. 그때 ensureFolderPage 는 폴더 노트의 부모 페이지를 폴더의 페이지로 적었고, 맨 위
   * 폴더에서는 그것이 루트다. 루트는 어느 폴더의 페이지도 아니다. 더 깊은 폴더는 그 부모 페이지를
   * 다른 레코드가 이미 가리켜(notion_page_id 고유 색인) 이런 레코드가 생기지 않았다.
   *
   * push 가 만든 폴더 페이지 아래에 폴더 노트가 든 두 겹의 폴더(S-15)는 지우지 않는다. 예전에는
   * 폴더 노트가 페이지를 가지면 폴더 레코드를 지워, Notion 에 그대로 있는 폴더 페이지를 추적에서
   * 놓았다 — 다음 pull 이 그것을 새 페이지로 받아 `(id)` 이름의 파일로 썼다.
   */
  repairFolderRecords(): void {
    for (const record of this.stateDb.getAll()) {
      if (
        isFolderRecord(record) &&
        record.notionPageId &&
        notionIdsEqual(record.notionPageId, this.config.notion.rootPageId)
      ) {
        this.stateDb.transaction(() => {
          this.stateDb.delete(record.id);
          this.stateDb.deleteWikilink(record.obsidianPath);
        });
      }
    }
  }

  /**
   * 변경을 올리기 전에 Notion 에 있어야 하는 폴더 — 새로 만들거나 옮기는 «페이지» 의 조상뿐,
   * 얕은 것부터. 행은 DB 에 들고, 이미 있는 페이지의 갱신 · 삭제는 부모를 쓰지 않는다. 예전에는
   * 모든 변경의 조상을 폴더 페이지로 만들어, DB 폴더와 DB 를 품은 폴더가 Notion 에 빈 페이지로
   * 생겼다(S-04).
   */
  private foldersToEnsure(changes: readonly LocalChange[]): string[] {
    const folders = new Set<string>();
    for (const change of changes) {
      if (change.type !== "created" && change.type !== "moved") continue;
      if (this.newRowDatabaseOf(change.path)) continue;
      for (const folder of ancestorFolders(change.path)) folders.add(folder);
    }
    return [...folders].sort((a, b) => a.split("/").length - b.split("/").length);
  }

  /**
   * push 가 만든 폴더 페이지를 새 폴더 노트의 페이지로 삼는다(S-15) — 폴더 레코드를 폴더 노트의
   * 경로로 옮겨 적는다. 이어서 pushCreate 가 레코드를 보고 새로 만들지 않고 본문을 보낸다. 제목은
   * frontmatter `title` 이 있을 때만 보낸다(changedPageTitle) — 폴더 페이지는 폴더 이름으로 만들어
   * 폴더 노트의 기본 제목과 같다.
   *
   * 폴더 노트의 생성 요청이 적용됐는지 모르는 채 남아 있으면(미완료 create WAL) 삼지 않는다 — 그
   * 요청이 만든 페이지를 찾아 매듭짓는 것이 먼저다. 폴더 이동을 아직 반영하지 못했어도(미완료 move
   * WAL) 삼지 않는다 — 그 WAL 은 폴더 레코드의 옛 자리를 적은 것이다.
   *
   * @returns 삼았으면 true.
   */
  private adoptFolderPage(folder: string, notePath: string): boolean {
    const record = this.stateDb.getByPath(folder);
    if (!record?.notionPageId || !isFolderRecord(record)) return false;
    if (this.stateDb.getIncompleteOpByState(record.id, "move")) return false;
    const placeholder = this.stateDb.getByPath(notePath);
    if (placeholder?.notionPageId) return false;
    if (placeholder && this.stateDb.getIncompleteOpByState(placeholder.id, "create")) return false;
    this.stateDb.transaction(() => {
      // 생성 요청을 보내기 전에 끊긴 자리표시다 — 지워야 폴더 레코드가 그 경로를 쓴다.
      if (placeholder) this.stateDb.delete(placeholder.id);
      this.stateDb.updatePath(record.id, notePath);
      this.stateDb.deleteWikilink(folder);
    });
    getLogger().info(
      `[Im-Nobsidian] 폴더 페이지를 폴더 노트의 페이지로 삼음: ${folder} → ${notePath}`,
    );
    return true;
  }

  /**
   * 폴더에 Notion 자리가 없어 그 안에 만들거나 옮기지 않는 이유. 이번 push 가 그 폴더의 자리를
   * 마련하다 실패했으면 그 이유를 붙인다.
   */
  private folderNotReady(folder: string, verb: "만들지" | "옮기지"): string {
    const reason = this.unpreparedFolders.get(folder);
    return reason === undefined
      ? `폴더(${folder})의 Notion 페이지가 아직 없어 ${verb} 않음 — 다음 push 가 폴더부터 만든다`
      : `폴더(${folder})의 Notion 페이지를 마련하지 못해 ${verb} 않음 — ${reason}`;
  }

  /**
   * 옮긴 노트를 Notion 에서 그 자리로 옮길 수 없는 이유. 옮길 수 있으면 null.
   *
   * - 행은 제 DB 폴더 바로 아래에서만 움직인다. Notion 에서 행을 DB 밖으로 옮기면 속성이 보이지
   *   않게 되고, 다른 DB 로 옮기면 스키마가 달라 속성이 맞지 않는다.
   * - 페이지는 DB 폴더로 옮길 수 없다 — DB 에는 행만 든다.
   * - 나머지는 새 노트와 같다 — DB 폴더 안의, 같은 이름의 행이 없는 폴더에는 자리가 없다.
   */
  private moveRefusal(
    change: LocalChange,
    record: SyncRecord,
    lookup: FolderLookup,
  ): string | null {
    const folder = parentFolderOf(change.path);
    const databaseId = lookup.databaseAt(folder);
    if (record.fileType === "db-row") {
      if (
        databaseId &&
        record.notionParentId &&
        notionIdsEqual(databaseId, record.notionParentId)
      ) {
        return null;
      }
      const home = change.movedFrom ? `«${parentFolderOf(change.movedFrom)}» ` : "";
      return (
        `DB 행은 그 DB 폴더 밖으로 옮기지 않음 — Notion 에서 행을 DB 밖 · 다른 DB 로 옮기면 ` +
        `속성이 사라진다. 원래 DB 폴더 ${home}바로 아래로 되돌리세요`
      );
    }
    const placement = pagePlacementFolder(change.path);
    const databaseFolder = databaseId
      ? folder
      : placement && lookup.databaseAt(placement)
        ? placement
        : null;
    if (databaseFolder !== null) {
      return (
        `페이지를 DB 폴더(${databaseFolder})로 옮기지 않음 — DB 에는 행만 든다. ` +
        `DB 폴더 밖으로 옮기세요`
      );
    }
    return this.placementRefusal(placement, lookup, "move");
  }

  /**
   * 폴더에 페이지를 둘 자리가 없는 이유 — DB 폴더 안의, 같은 이름의 행이 없는 폴더. 자리가 있으면
   * null. DB 에는 행만 들어 그런 폴더는 Notion 에 같은 것이 없다. 예전에는 그 폴더를 빈 페이지로
   * 만들어 그 아래에 뒀다(S-04).
   */
  private placementRefusal(
    folder: string,
    lookup: FolderLookup,
    action: "create" | "move",
  ): string | null {
    if (!folder || folderContainer(folder, lookup)) return null;
    const databaseFolder = enclosingDatabaseFolder(folder, lookup);
    if (!databaseFolder) return null;
    const rowName = folder.slice(databaseFolder.length + 1).split("/")[0];
    const place = `DB 폴더(${databaseFolder}) 안의 «${rowName}» 폴더는 그 이름의 행 아래 페이지 자리다`;
    return action === "create"
      ? `같은 이름의 행이 Notion 에 없는 폴더라 만들지 않음 — ${place}. ` +
          `행으로 올리려면 DB 폴더 바로 아래로 옮기세요`
      : `같은 이름의 행이 Notion 에 없는 폴더라 옮기지 않음 — ${place}. ` +
          `그 이름의 행을 먼저 만들거나 다른 폴더로 옮기세요`;
  }
}

/**
 * 이 노트의 Notion 페이지가 놓일 폴더. 폴더 노트(`A/B/B.md`)는 폴더 `A/B` 의 페이지라
 * 그 폴더의 부모(`A`)에 놓인다.
 */
function pagePlacementFolder(path: string): string {
  const folder = parentFolderOf(path);
  return isFolderNotePath(path) ? parentFolderOf(folder) : folder;
}
