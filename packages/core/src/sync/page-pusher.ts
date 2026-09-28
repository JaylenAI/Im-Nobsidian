import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import { Sema } from "async-sema";
import type { BlockConverter } from "../converter/block-converter.js";
import { obsidianToNotionEnhanced } from "../converter/enhanced-md-converter.js";
import type { ConversionPipeline } from "../converter/pipeline.js";
import type { NotionClient } from "../notion/client.js";
import type { PropertyMapper } from "../notion/property-mapper.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { Config } from "../types/config.js";
import type { ConversionResult } from "../types/convert.js";
import type { FailedOperation, FileType, LocalChange, SyncRecord } from "../types/sync.js";
import { parseFrontmatter, snapshotFrontmatter } from "../utils/frontmatter.js";
import { computeHash } from "../utils/hash.js";
import { compactNotionId, notionIdsEqual } from "../utils/id.js";
import { getLogger } from "../utils/logger.js";
import { wikilinkTitleFromPath } from "../utils/wikilink-title.js";
import { loadLinkedDbMap } from "./discovered-databases.js";
import { folderContainer, isFolderNotePath, parentFolderOf } from "./folder-container.js";
import type { FolderPlacement } from "./folder-placement.js";
import type { ImageHandler } from "./image-handler.js";
import type { InterruptedSyncRecovery } from "./interrupted-sync.js";
import { moveOrigin } from "./local-moves.js";
import type { PendingFolderMove } from "./local-planner.js";
import {
  explicitTitle,
  extractAliases,
  extractTitle,
  noteTitle,
  titleAfterMove,
  titleMayChange,
  titleProperty,
} from "./note-title.js";
import { replacePageBody } from "./page-body.js";
import { isDatabaseMode, rowDatabaseOf } from "./parent-mode.js";
import { remotePresence } from "./remote-deletion.js";
import {
  refuseUnpulledBody,
  refuseUnpulledDeletion,
  type RemoteDrift,
  type RemoteDriftChecker,
} from "./remote-drift.js";
import { remoteBodyFingerprint, type RemotePageStamp } from "./remote-observation.js";
import { diffRowProperties } from "./row-properties.js";
import type { RowSchemaCache } from "./row-schema-cache.js";
import type { RunObservation } from "./run-observation.js";
import type { VaultFS } from "./vault-fs.js";

/** DB 행을 보낼 때 견줄 기준 — 속성 · 제목 · 본문(null 이면 모름: 본문을 보낸다). */
interface RowState {
  readonly properties: Readonly<Record<string, unknown>>;
  readonly title: string;
  readonly body: string | null;
}

/** push 가 만든 페이지 · 행. `markdown` 은 본문으로 보낸 markdown — 블록으로 보냈으면 null. */
interface CreatedPage {
  readonly page: PageObjectResponse;
  readonly markdown: string | null;
}

/**
 * 로컬 변경을 Notion 에 올린다(push) — 새 노트는 페이지 · 행으로 만들고, 고친 노트는 본문과 제목 ·
 * 속성을 보내고, 옮긴 노트 · 폴더는 부모와 제목을 바꾸고, 지운 노트는 휴지통으로 보낸다.
 *
 * 덮어쓰거나 지우기 전에 pull 하지 않은 Notion 편집이 없는지 본다(N-05). 충돌 해소도 고른 결과를
 * 여기로 올린다({@link pushUpdate} · {@link pushCreate}).
 */
export class PagePusher {
  constructor(
    private readonly config: Config,
    private readonly stateDb: IStateDB,
    private readonly notionClient: NotionClient,
    private readonly vaultFs: VaultFS,
    private readonly pipeline: ConversionPipeline,
    private readonly blockConverter: BlockConverter,
    private readonly imageHandler: ImageHandler,
    private readonly rowSchemas: RowSchemaCache,
    private readonly observation: RunObservation,
    private readonly drift: RemoteDriftChecker,
    private readonly placement: FolderPlacement,
    private readonly recovery: InterruptedSyncRecovery,
  ) {}

  async pushCreate(path: string): Promise<void> {
    // 멱등성/원자성: 이전 시도가 페이지 생성까지는 성공해 notionPageId 가 이미
    // 매핑돼 있으면(이미지 업로드 실패·크래시·인-런 재시도 등) 새 페이지를 또
    // 만들지 않고 업데이트 경로로 위임한다 → 고아 페이지·중복 생성 방지.
    const existingRecord = this.stateDb.getByPath(path);
    if (existingRecord?.notionPageId) {
      await this.pushUpdate(path);
      return;
    }

    const rowDatabaseId = this.placement.newRowDatabaseOf(path);
    if (rowDatabaseId) {
      await this.pushCreateRow(path, rowDatabaseId);
      return;
    }

    const content = await this.vaultFs.readFile(path);
    const parentId = await this.placement.resolveNotionParent(path);

    const selectedPath = this.pipeline.selectPath(content);
    if (selectedPath === "block-api") {
      getLogger().warn(
        `[Im-Nobsidian] "${path}" contains block-api features (inline-db/column/toggle) — converted with reduced fidelity in v0.1.0`,
      );
    }

    const conversionResult = this.pipeline.convertToNotion(content, {
      direction: "push",
      path: selectedPath,
      filePath: path,
      parentMode: this.config.notion.parentMode,
    });
    // 제목은 frontmatter `title` 이 먼저다 — 갱신(changedPageTitle) · 이동(titleAfterMove)과 같은
    // 규칙이어야 만든 뒤 첫 갱신에서 제목이 뒤집히지 않는다. 행도 같다(pushRowUpdate).
    const title = noteTitle(conversionResult.properties, path);

    // I12 WAL(쓰기-우선): 페이지를 만들기 전에 자리표시 state(notion_page_id=null) +
    // pending_operations(create) 를 먼저 기록한다. 생성 요청이 적용됐는데 응답이 유실되거나
    // (timeout) 프로세스가 죽어 매핑 기록 전에 중단되면, 다음 push 시작 시 recoverInterruptedPushOps
    // 가 부모에서 제목으로 고아 페이지를 찾아 입양하므로 중복 페이지 생성을 차단한다.
    const placeholder = this.stateDb.upsert({
      obsidianPath: path,
      notionPageId: null,
      notionParentId: parentId,
      contentHash: "",
      notionLastEdited: null,
      localLastModified: new Date().toISOString(),
      syncDirection: "both",
      fileType: isFolderNotePath(path) ? "folder-note" : "file",
      status: "pending",
      baseSnapshot: null,
      localMtime: null,
      localFileSize: null,
    });
    // 인-런 재시도 시 같은 state 에 대한 op 중복 기록을 막는다(기존 미완료 op 재사용).
    const existingOp = this.stateDb.getIncompleteOpByState(placeholder.id, "create");

    // 미완료 op 가 남아 있다 = 앞선 시도의 생성 요청이 적용됐는지 모른다(S-07 — 클라이언트는
    // 모호한 실패에서 생성 요청을 다시 보내지 않는다). 다시 만들기 전에 부모에서 제목으로
    // 찾아 입양한다. 목록을 읽지 못하면 던져서 이 항목만 실패로 남긴다 — 중복보다 낫다.
    if (existingOp) {
      const orphan = await this.recovery.findChildPageByTitle(parentId, title);
      if (orphan) {
        this.recovery.adoptOrphanPage(path, orphan.id, parentId, placeholder);
        this.stateDb.markPendingCompleted(existingOp.id);
        getLogger().info(`[Im-Nobsidian] 앞선 생성 요청이 적용돼 있었음 — 페이지 입양: ${path}`);
        await this.pushUpdate(path);
        return;
      }
    }

    const walOpId =
      existingOp?.id ??
      this.stateDb.recordPendingOperation({
        syncStateId: placeholder.id,
        operation: "create",
        direction: "push",
        payload: JSON.stringify({ path, parentId, title }),
      });

    const created = await this.pushCreatePage(
      parentId,
      "page",
      title,
      conversionResult.content,
      conversionResult.properties,
    );
    const { page } = created;

    // 페이지 생성 직후 매핑을 먼저 기록(전이 상태 pending). 이후 이미지 업로드 등이
    // 실패해도 이 레코드 덕에 다음 시도는 pushCreate(중복) 가 아니라 pushUpdate 로
    // 이어진다. contentHash 를 비워 변경감지가 "미완료 → 재푸시 필요"로 인식하게 한다.
    this.stateDb.upsert({
      obsidianPath: path,
      notionPageId: page.id,
      notionParentId: parentId,
      contentHash: "",
      ...this.observation.fieldsOf(page, null),
      localLastModified: new Date().toISOString(),
      syncDirection: "both",
      fileType: isFolderNotePath(path) ? "folder-note" : "file",
      status: "pending",
      baseSnapshot: null,
      localMtime: null,
      localFileSize: null,
    });

    const settled = await this.finishCreatedPage(created, conversionResult, path);

    const hash = computeHash(content);
    const fileStat = await this.vaultFs.getFileStat(path);

    this.stateDb.transaction(() => {
      this.stateDb.upsert({
        obsidianPath: path,
        notionPageId: page.id,
        notionParentId: parentId,
        contentHash: hash,
        ...this.observation.fieldsOf(settled.page, settled.bodyFingerprint),
        localLastModified: new Date().toISOString(),
        syncDirection: "both",
        fileType: isFolderNotePath(path) ? "folder-note" : "file",
        status: "synced",
        baseSnapshot: Buffer.from(content, "utf-8"),
        localMtime: fileStat?.mtime ?? null,
        localFileSize: fileStat?.size ?? null,
      });

      const aliases = extractAliases(conversionResult.properties);
      this.stateDb.upsertWikilink({
        obsidianPath: path,
        notionPageId: page.id,
        title: extractTitle(path),
        aliases,
      });

      this.stateDb.storePreserveMarkers(path, conversionResult.preserveMarkers);
    });

    // 생성·매핑·이미지·최종 synced 까지 모두 끝났으므로 WAL 을 완료 처리한다.
    this.stateDb.markPendingCompleted(walOpId);
  }

  /**
   * @param options.overwriteRemote 원격을 로컬 내용으로 맞춘다(충돌 해소 결과 전파 · 입양한 행).
   *   원격이 바뀌었는지 확인하지 않고 덮어쓴다({@link RemoteDriftChecker.overwritesRemote}). DB 행은
   *   비교 기준도 달라진다(pushRowUpdate).
   */
  async pushUpdate(path: string, options?: { overwriteRemote?: boolean }): Promise<void> {
    const content = await this.vaultFs.readFile(path);
    const record = this.stateDb.getByPath(path);
    if (!record?.notionPageId) return;

    const rowDatabaseId = rowDatabaseOf(this.config, record);
    if (rowDatabaseId) {
      await this.pushRowUpdate(path, record, rowDatabaseId, content, {
        overwriteRemote: options?.overwriteRemote === true,
      });
      return;
    }

    const updatePath = this.pipeline.selectPath(content);
    if (updatePath === "block-api") {
      getLogger().warn(
        `[Im-Nobsidian] "${path}" contains block-api features (inline-db/column/toggle) — converted with reduced fidelity in v0.1.0`,
      );
    }

    const conversionResult = this.pipeline.convertToNotion(content, {
      direction: "push",
      path: updatePath,
      filePath: path,
      parentMode: this.config.notion.parentMode,
    });

    // 덮어쓰기 전에 pull 하지 않은 Notion 편집이 없는지 본다(N-05). 본문 밖만 바뀌었으면 본문은
    // 쓰되 수정 시각을 올리지 않는다 — 원격의 제목 변경은 다음 pull 이 받는다.
    const drift: RemoteDrift = this.drift.overwritesRemote(
      record,
      options?.overwriteRemote === true,
    )
      ? "none"
      : await this.drift.remoteDrift(record, await this.notionClient.getPage(record.notionPageId));
    refuseUnpulledBody(drift, path);
    const settles = drift === "none";

    let bodyFingerprint = await this.pushUpdatePage(
      record.notionPageId,
      conversionResult.content,
      record.baseSnapshot,
    );

    if (await this.syncEmbeddedMedia(record.notionPageId, conversionResult, path)) {
      bodyFingerprint = await this.drift.remoteBodyFingerprintOf(record.notionPageId);
    }

    // 페이지는 속성이 제목뿐이다 — 나머지 frontmatter 는 본문 첫머리 YAML 블록으로 간다
    // (PropertiesTableInjector). DB 행은 여기 오지 않는다(pushRowUpdate).
    const newTitle = this.changedPageTitle(record, content, path);
    const propsToUpdate = newTitle === null ? undefined : titleProperty(newTitle);

    // notionLastEdited 는 반드시 Notion 서버가 돌려준 값으로 저장한다. 로컬 시각
    // (new Date())을 쓰면 서버 시각과 클록 스큐·네트워크 지연만큼 어긋나 다음 pull 이
    // 가짜 modified 로 오인 → 불필요 재조회·집계(false-churn). 속성 갱신이 있으면 그
    // 응답이 최종 mutation 이라 권위값이고, 없으면(블록/이미지만 변경) 1회 getPage 로
    // 권위값을 받아 진짜 fixpoint 를 만든다. (I5 — pull 측 content_hash 가드와 이중 차단)
    let written: RemotePageStamp | null = null;
    if (propsToUpdate && Object.keys(propsToUpdate).length > 0) {
      written = await this.notionClient.updatePageProperties(record.notionPageId, propsToUpdate);
    } else if (settles) {
      written = await this.notionClient.getPage(record.notionPageId);
    }

    const hash = computeHash(content);
    const fileStat = await this.vaultFs.getFileStat(path);
    const title = extractTitle(path);
    const aliases = extractAliases(conversionResult.properties);
    this.stateDb.transaction(() => {
      this.stateDb.updateHash(record.id, hash, Buffer.from(content, "utf-8"));
      this.stateDb.updateStatus(record.id, "synced");
      if (written !== null && settles) {
        this.observation.record(record.id, written, bodyFingerprint);
      } else {
        this.stateDb.setNotionBodyFingerprint(record.id, bodyFingerprint);
      }
      if (fileStat) {
        this.stateDb.updateStatCache(record.id, fileStat.mtime, fileStat.size);
      }
      this.stateDb.storePreserveMarkers(path, conversionResult.preserveMarkers);
      this.stateDb.upsertWikilink({
        obsidianPath: path,
        notionPageId: record.notionPageId!,
        title,
        aliases,
      });
    });
  }

  /**
   * 옮기거나 이름을 바꾼 노트를 Notion 에 반영한다(S-11) — 부모 페이지와 제목을 바꾸고, 내용도
   * 바뀌었으면 이어서 갱신한다. 예전에는 부모를 바꾸는 요청을 Notion 이 무시했고(pages.update 의
   * parent), 실패는 로그만 남겼다. 제목은 바꾸지 않았다.
   *
   * 무엇을 바꿀지는 이동 WAL 의 옛 경로 — 마지막으로 Notion 에 반영한 자리 — 와 견줘 정한다.
   * 반영을 마치면 WAL 을 지운다. 도중에 끊기면 다음 push 가 같은 옛 경로로 다시 한다 — 옮기기와
   * 제목 바꾸기는 다시 해도 결과가 같다. 행은 DB 안에서만 옮긴다(refusedMoves) — 제목만 바뀐다.
   */
  async pushMove(change: LocalChange): Promise<void> {
    const path = change.path;
    const record = this.stateDb.getByPath(path);
    if (!record?.notionPageId) throw new Error(`옮긴 노트의 추적 기록이 없음: ${path}`);
    const op = this.stateDb.getIncompleteOpByState(record.id, "move");
    const from = (op ? moveOrigin(op.payload) : null) ?? change.movedFrom ?? path;

    const rowDatabaseId = rowDatabaseOf(this.config, record);
    const base = snapshotFrontmatter(record.baseSnapshot);
    let current: Record<string, unknown>;
    try {
      current = parseFrontmatter(await this.vaultFs.readFile(path)).data;
    } catch (error) {
      // 행은 멈춘다 — 이어지는 갱신이 모든 속성을 지우라는 요청이 된다(pushRowUpdate). 페이지는
      // 제목을 고치지 않은 것으로 본다.
      if (rowDatabaseId) {
        throw new Error(
          `frontmatter 를 읽지 못해 행을 옮기지 않음 (${path}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      current = base ?? {};
    }

    await this.relocatePage(record, {
      parentId: rowDatabaseId ? null : this.placement.moveParentOf(path),
      title: titleMayChange(base, current, from, path)
        ? (remoteTitle) => titleAfterMove(base, current, from, path, remoteTitle)
        : null,
      opId: op?.id ?? null,
    });

    if (record.contentHash !== change.currentHash) await this.pushUpdate(path);
  }

  /**
   * 옮기거나 이름을 바꾼 폴더의 페이지(push 가 만든 폴더 페이지)를 Notion 에 반영한다 — 얕은
   * 것부터. 새 부모 폴더에 페이지가 없으면 먼저 만든다. 실패는 폴더마다 이유와 함께 남긴다.
   *
   * @returns 반영한 폴더 수.
   */
  async pushFolderMoves(
    moves: readonly PendingFolderMove[],
    failed: FailedOperation[],
    onMove?: (to: string) => void,
  ): Promise<number> {
    let moved = 0;
    for (const { record, from, to } of moves) {
      onMove?.(to);
      try {
        const parentFolder = parentFolderOf(to);
        let parentId = this.config.notion.rootPageId;
        if (parentFolder) {
          await this.placement.ensureFolderPage(parentFolder);
          const lookup = this.placement.folderLookup();
          const container = folderContainer(parentFolder, lookup);
          if (container?.kind !== "page") {
            throw new Error(
              this.placement.folderMoveRefusal(to, lookup) ??
                `폴더(${parentFolder})의 Notion 페이지가 없어 옮기지 않음 — 다음 push 가 폴더부터 만든다`,
            );
          }
          parentId = container.pageId;
        }
        await this.relocatePage(record, {
          parentId,
          // 폴더 페이지는 폴더 이름으로 만든다 — 이름이 바뀌면 옛 이름을 따르던 제목만 바꾼다.
          title:
            wikilinkTitleFromPath(from) === wikilinkTitleFromPath(to)
              ? null
              : (remoteTitle) => titleAfterMove(null, {}, from, to, remoteTitle),
          opId: this.stateDb.getIncompleteOpByState(record.id, "move")?.id ?? null,
        });
        moved++;
      } catch (error) {
        failed.push({
          path: to,
          operation: "move",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return moved;
  }

  // 반환값: 실제로 원격(Notion) 삭제가 전파되었는지 여부.
  // deleteSync=false 면 로컬 삭제를 pending 으로만 기록하고 Notion 은 보존하므로
  // false 를 돌려준다 → 호출부가 deleted 카운트를 올리지 않아 보고가 정직해진다.
  //
  // 지우기 전에 원격을 본다(F-f) — pull 하지 않은 Notion 편집이 있으면 지우지 않는다. 휴지통으로
  // 보내면 그 편집은 볼트에도 Notion 에도 보이지 않는다. 이어지는 pull 이 파일을 되살려 받는다
  // (로컬 파일이 없으면 원격을 쓴다). 원격이 이미 사라졌으면 추적만 놓는다.
  async pushDelete(path: string): Promise<boolean> {
    const record = this.stateDb.getByPath(path);
    if (!record?.notionPageId) return false;

    if (!this.config.sync.deleteSync) {
      this.stateDb.updateStatus(record.id, "pending");
      return false;
    }

    const presence = await remotePresence(this.notionClient, record.notionPageId);
    if (presence.kind === "alive") {
      if (!this.drift.overwritesRemote(record, false)) {
        refuseUnpulledDeletion(await this.drift.remoteDrift(record, presence.page), path);
      }
      try {
        await this.notionClient.archivePage(record.notionPageId);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes("archived ancestor")) {
          // 부모 페이지가 이미 아카이브됨 → 자식도 자동 아카이브 상태
        } else {
          throw error;
        }
      }
    }
    this.stateDb.transaction(() => {
      this.stateDb.delete(record.id);
      this.stateDb.deleteWikilink(record.obsidianPath);
    });
    return true;
  }

  /**
   * DB 폴더(설정 · 자동 발견)에 새로 생긴 노트, 그리고 DB 모드의 새 노트를 그 DB 의 행으로
   * 만든다(S-04).
   *
   * 갱신(pushRowUpdate)과 같은 규칙이다 — 속성은 DB 스키마의 속성으로, 본문은 본문으로 보내고
   * 본문에 속성 YAML 을 끼우지 않는다. DB 에 없는 키(`cover` · `aliases` …)는 보내지 않는다.
   * 예전에는 자동 발견 DB 폴더의 새 노트가 DB 폴더 이름의 빈 페이지 아래 페이지로 만들어졌고,
   * 설정 DB 의 행은 WAL 없이 따로 만들어졌으며, DB 모드는 조상 폴더를 페이지로 만들었다.
   *
   * 생성 요청은 페이지와 같이 WAL 을 먼저 적는다. 요청이 적용됐는지 모르고 끝나면(S-07) 다음
   * 시도가 DB 에서 같은 제목의 짝 없는 행을 찾아 입양하고 로컬 내용으로 맞춘다.
   */
  private async pushCreateRow(path: string, databaseId: string): Promise<void> {
    const content = await this.vaultFs.readFile(path);
    const fileType = this.newRowFileType(path);
    // frontmatter 를 못 읽으면 만들지 않는다 — 파이프라인은 읽지 못한 frontmatter 를 «속성
    // 없음» 으로 넘겨, 제목만 있는 행이 생기고 속성은 사라진다.
    let current: ReturnType<typeof parseFrontmatter>;
    try {
      current = parseFrontmatter(content);
    } catch (error) {
      throw new Error(
        `frontmatter 를 읽지 못해 행을 만들지 않음 (${path}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const title = noteTitle(current.data, path);

    // 보낼 것을 먼저 다 만든다 — WAL 은 생성 요청 바로 앞에 적어야, 스키마를 읽지 못해 요청을
    // 보내지도 않은 실행이 «적용됐는지 모름» 기록을 남기지 않는다.
    const mapper = await this.rowSchemas.mapperFor(databaseId);
    const { properties, skipped } = mapper.toNotionPropertyChanges(
      diffRowProperties(null, current.data),
      title,
    );
    if (skipped.length > 0) {
      getLogger().info(
        `[Im-Nobsidian] 새 행 속성 ${skipped.length}개는 보내지 않음(DB 에 없는 속성 · 읽기 전용 · ` +
          `변환 불가): ${path} — ${skipped.join(", ")}`,
      );
    }
    const selectedPath = this.pipeline.selectPath(content);
    if (selectedPath === "block-api") {
      getLogger().warn(
        `[Im-Nobsidian] "${path}" contains block-api features (inline-db/column/toggle) — converted with reduced fidelity in v0.1.0`,
      );
    }
    const conversionResult = this.pipeline.convertToNotion(content, {
      direction: "push",
      path: selectedPath,
      filePath: path,
      parentMode: "database",
    });

    const placeholder = this.stateDb.upsert({
      obsidianPath: path,
      notionPageId: null,
      notionParentId: databaseId,
      contentHash: "",
      notionLastEdited: null,
      localLastModified: new Date().toISOString(),
      syncDirection: "both",
      fileType,
      status: "pending",
      baseSnapshot: null,
      localMtime: null,
      localFileSize: null,
    });
    const existingOp = this.stateDb.getIncompleteOpByState(placeholder.id, "create");
    if (existingOp) {
      const orphan = await this.recovery.findUntrackedRowByTitle(databaseId, title);
      if (orphan) {
        this.recovery.adoptOrphanPage(path, orphan.id, databaseId, placeholder);
        this.stateDb.markPendingCompleted(existingOp.id);
        getLogger().info(`[Im-Nobsidian] 앞선 생성 요청이 적용돼 있었음 — 행 입양: ${path}`);
        // 입양한 행은 이 노트가 보낸 요청으로 생긴 것이다. 반쯤 채워졌을 수 있어 원격과 견줘
        // 다른 속성과 본문을 모두 보낸다.
        await this.pushUpdate(path, { overwriteRemote: true });
        return;
      }
    }

    const walOpId =
      existingOp?.id ??
      this.stateDb.recordPendingOperation({
        syncStateId: placeholder.id,
        operation: "create",
        direction: "push",
        payload: JSON.stringify({ path, parentId: databaseId, parentType: "database", title }),
      });

    const created = await this.pushCreatePage(
      databaseId,
      "database",
      title,
      conversionResult.content,
      properties,
    );
    const { page } = created;

    // 매핑을 먼저 적는다 — 첨부 업로드가 실패해도 다음 시도는 새로 만들지 않고 갱신한다.
    this.stateDb.upsert({
      obsidianPath: path,
      notionPageId: page.id,
      notionParentId: databaseId,
      contentHash: "",
      ...this.observation.fieldsOf(page, null),
      localLastModified: new Date().toISOString(),
      syncDirection: "both",
      fileType,
      status: "pending",
      baseSnapshot: null,
      localMtime: null,
      localFileSize: null,
    });

    const settled = await this.finishCreatedPage(created, conversionResult, path);

    const fileStat = await this.vaultFs.getFileStat(path);
    this.stateDb.transaction(() => {
      this.stateDb.upsert({
        obsidianPath: path,
        notionPageId: page.id,
        notionParentId: databaseId,
        contentHash: computeHash(content),
        ...this.observation.fieldsOf(settled.page, settled.bodyFingerprint),
        localLastModified: new Date().toISOString(),
        syncDirection: "both",
        fileType,
        status: "synced",
        baseSnapshot: Buffer.from(content, "utf-8"),
        localMtime: fileStat?.mtime ?? null,
        localFileSize: fileStat?.size ?? null,
      });
      this.stateDb.upsertWikilink({
        obsidianPath: path,
        notionPageId: page.id,
        title,
        aliases: extractAliases(current.data),
      });
      this.stateDb.storePreserveMarkers(path, conversionResult.preserveMarkers);
    });

    this.stateDb.markPendingCompleted(walOpId);
  }

  /**
   * 노트에 박힌 로컬 미디어를 Notion 에 올린다(R1).
   *
   * 먼저 본문 자리표시자를 실제 image/file 블록으로 **제자리** 교체한다. 그러고도 남은
   * 이미지만 페이지 끝에 덧붙이는 예전 경로로 흘린다 — 자리표시자를 찾지 못했어도
   * (조회 실패 · 블록 방식 push 등) 이미지 자체는 올라가야 하므로 폴백을 남긴다.
   *
   * @returns 페이지 본문을 고쳤을 수 있으면 true — 본문을 보낸 뒤 만든 지문이 더는 맞지 않는다.
   */
  private async syncEmbeddedMedia(
    pageId: string,
    conversionResult: ConversionResult,
    path: string,
  ): Promise<boolean> {
    const { handledTargets, touched } = await this.imageHandler.materializeLocalMedia(
      pageId,
      conversionResult.content,
      path,
    );
    const leftovers = conversionResult.images.filter(
      (img) => !img.localPath || !handledTargets.has(img.localPath),
    );
    let appended = 0;
    if (leftovers.length > 0) {
      appended = (await this.imageHandler.uploadAndAppendImages(pageId, leftovers, path)).length;
    }
    return touched || appended > 0;
  }

  /**
   * 페이지 제목을 바꿔야 하면 새 제목, 아니면 null.
   *
   * frontmatter `title` 을 고쳤을 때만 보낸다. 예전에는 갱신마다 `title` 을 보내, 파일 이름으로
   * 만든 페이지는 첫 갱신에서 제목이 뒤집히고, 이름을 바꿔 올린 제목도 다음 갱신이 옛 `title` 로
   * 되돌렸다(S-11). `title` 을 지웠으면 파일 이름으로 돌아간다. frontmatter 를 읽지 못하면
   * 제목을 건드리지 않는다 — 못 읽은 것을 «지웠다» 로 보면 제목이 파일 이름으로 바뀐다.
   */
  private changedPageTitle(record: SyncRecord, content: string, path: string): string | null {
    let current: Record<string, unknown>;
    try {
      current = parseFrontmatter(content).data;
    } catch {
      return null;
    }
    const written = explicitTitle(current);
    const base = snapshotFrontmatter(record.baseSnapshot);
    if (base === null) return written;
    if (written === explicitTitle(base)) return null;
    return written ?? wikilinkTitleFromPath(path);
  }

  /**
   * 새 행의 레코드 종류. DB 모드의 노트는 행이어도 페이지 레코드로 적는다 — DB 모드의 pull · 복원 ·
   * 렌더는 그 볼트의 노트를 모두 페이지 레코드로 다루고, 행인지는 전역 모드로 가른다(rowDatabaseOf).
   */
  private newRowFileType(path: string): FileType {
    if (!isDatabaseMode(this.config)) return "db-row";
    return isFolderNotePath(path) ? "folder-note" : "file";
  }

  /**
   * DB 행 갱신(S-01 · S-02).
   *
   * 행은 페이지가 아니다. 속성은 DB 스키마의 속성으로 보내고 본문에 YAML 로 끼우지 않는다.
   * 무엇을 보낼지는 비교 기준이 정한다 — 보내기 전에 행을 한 번 읽어 고른다.
   *
   * - 원격이 지난 동기화 뒤 그대로면 지난 동기화 사본(baseSnapshot)과 견줘 **바뀐 것만**
   *   보낸다. 통째로 보내면 로컬이 평문으로만 아는 서식(굵게 · 링크 · 멘션)이 매번 지워진다.
   *   본문도 바뀌었을 때만 보낸다 — 다시 쓰면 블록 ID 와 블록에 달린 댓글이 사라진다.
   * - 원격도 바뀌었으면 똑같이 로컬에서 바꾼 것만 보내되 notionLastEdited 를 올리지 않는다.
   *   올리면 다음 pull 이 원격 변경을 «이미 받은 것» 으로 여겨 영영 가져오지 않는다. 본문은
   *   통째로 바꾸므로 원격 본문이 그대로일 때만 보낸다 — 아니면 pull 을 먼저 하라며 거절한다.
   *   원격이 바뀌었는지는 같은 분 안의 편집까지 내용으로 가른다(N-05,
   *   {@link RemoteDriftChecker.remoteDrift}).
   * - 충돌 해소 결과를 보낼 때(`overwriteRemote`)는 원격의 지금 값과 견줘 다른 것을 모두
   *   보내고 본문도 보낸다 — 로컬이 이긴다(페이지가 본문을 통째로 바꾸는 것과 같다).
   */
  private async pushRowUpdate(
    path: string,
    record: SyncRecord,
    databaseId: string,
    content: string,
    options: { overwriteRemote: boolean },
  ): Promise<void> {
    const pageId = record.notionPageId!;
    // frontmatter 를 못 읽으면 멈춘다. 파이프라인은 읽지 못한 frontmatter 를 «속성 없음» 으로
    // 넘기므로, 그대로 견주면 모든 속성을 지우라는 요청이 된다.
    let current: ReturnType<typeof parseFrontmatter>;
    try {
      current = parseFrontmatter(content);
    } catch (error) {
      throw new Error(
        `frontmatter 를 읽지 못해 행을 보내지 않음 (${path}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const mapper = await this.rowSchemas.mapperFor(databaseId);
    const remote = await this.notionClient.getPage(pageId);
    const drift: RemoteDrift = options.overwriteRemote
      ? "none"
      : await this.drift.remoteDrift(record, remote);
    const against = options.overwriteRemote
      ? this.remoteRowState(mapper, remote)
      : this.baseRowState(record);

    const title = noteTitle(current.data, path);
    const { properties, skipped } = mapper.toNotionPropertyChanges(
      diffRowProperties(
        against?.properties ?? null,
        options.overwriteRemote ? mapper.pickWritable(current.data) : current.data,
      ),
      against?.title === title ? null : title,
    );
    if (skipped.length > 0) {
      getLogger().info(
        `[Im-Nobsidian] 행 속성 ${skipped.length}개는 보내지 않음(DB 에 없는 속성 · 읽기 전용 · ` +
          `비울 수 없는 속성 · 변환 불가): ${path} — ${skipped.join(", ")}`,
      );
    }

    const bodyChanged = against?.body == null || against.body !== current.body;
    // 수정 시각을 올려도 되는가 — 원격의 변경을 모두 로컬이 덮었거나 원격이 그대로일 때만.
    const settles = drift === "none";
    if (bodyChanged && !this.drift.overwritesRemote(record, options.overwriteRemote)) {
      refuseUnpulledBody(drift, path);
    }
    let conversionResult: ConversionResult | null = null;
    let bodyFingerprint: string | null | undefined;
    if (bodyChanged) {
      const selectedPath = this.pipeline.selectPath(content);
      if (selectedPath === "block-api") {
        getLogger().warn(
          `[Im-Nobsidian] "${path}" contains block-api features (inline-db/column/toggle) — converted with reduced fidelity in v0.1.0`,
        );
      }
      conversionResult = this.pipeline.convertToNotion(content, {
        direction: "push",
        path: selectedPath,
        filePath: path,
        parentMode: "database",
      });
      bodyFingerprint = await this.pushUpdatePage(
        pageId,
        conversionResult.content,
        record.baseSnapshot,
      );
      if (await this.syncEmbeddedMedia(pageId, conversionResult, path)) {
        bodyFingerprint = await this.drift.remoteBodyFingerprintOf(pageId);
      }
    }

    // notionLastEdited 는 서버가 돌려준 값으로 적는다(pushUpdate 와 같은 이유 — I5).
    // 보낸 것이 없으면(스키마에 없는 키만 바뀜) 원격은 그대로이므로 옛 값을 둔다.
    let written: RemotePageStamp | null = null;
    if (Object.keys(properties).length > 0) {
      written = await this.notionClient.updatePageProperties(pageId, properties);
    } else if (bodyChanged && settles) {
      written = await this.notionClient.getPage(pageId);
    }
    if (!settles) {
      getLogger().info(
        `[Im-Nobsidian] Notion 에서도 바뀐 행 — 로컬에서 바꾼 것만 보냈고 Notion 쪽 변경은 ` +
          `다음 pull 에서 받음: ${path}`,
      );
    }

    const hash = computeHash(content);
    const fileStat = await this.vaultFs.getFileStat(path);
    this.stateDb.transaction(() => {
      this.stateDb.updateHash(record.id, hash, Buffer.from(content, "utf-8"));
      this.stateDb.updateStatus(record.id, "synced");
      if (written !== null && settles) {
        this.observation.record(record.id, written, bodyFingerprint);
      } else if (bodyFingerprint !== undefined) {
        this.stateDb.setNotionBodyFingerprint(record.id, bodyFingerprint);
      }
      if (fileStat) {
        this.stateDb.updateStatCache(record.id, fileStat.mtime, fileStat.size);
      }
      if (conversionResult) {
        this.stateDb.storePreserveMarkers(path, conversionResult.preserveMarkers);
      }
      this.stateDb.upsertWikilink({
        obsidianPath: path,
        notionPageId: pageId,
        title,
        aliases: extractAliases(current.data),
      });
    });
  }

  /**
   * 지난 동기화 시점의 행. 사본이 없거나 읽지 못하면 null — 호출측은 비교할 기준이 없다고
   * 보고 비어 있지 않은 속성을 모두 보낸다(지우는 요청은 보내지 않는다).
   */
  private baseRowState(record: SyncRecord): RowState | null {
    if (!record.baseSnapshot) return null;
    try {
      const base = parseFrontmatter(record.baseSnapshot.toString("utf-8"));
      return {
        properties: base.data,
        title: noteTitle(base.data, record.obsidianPath),
        body: base.body,
      };
    } catch {
      return null;
    }
  }

  /** 원격의 지금 행 — 보낼 수 있는 속성만. 본문은 읽지 않는다(null: 늘 보낸다). */
  private remoteRowState(
    mapper: PropertyMapper,
    page: Awaited<ReturnType<NotionClient["getPage"]>>,
  ): RowState {
    const raw = (page as unknown as { properties?: Record<string, unknown> }).properties ?? {};
    return {
      properties: mapper.pickWritable(mapper.fromNotionProperties(raw)),
      title: this.notionClient.extractTitle(page),
      body: null,
    };
  }

  /**
   * 페이지를 새 부모로 옮기고 제목을 바꾼 뒤 이동 WAL 을 지운다. 바꿀 것이 없으면 요청하지 않는다.
   *
   * @param change.parentId 새 부모 페이지. null 이면 부모는 그대로(행).
   * @param change.title Notion 의 지금 제목을 받아 새 제목을 돌려준다(그대로면 null). 제목이 바뀔
   *   수 없으면 null — 그러면 페이지를 읽지 않는다.
   */
  private async relocatePage(
    record: SyncRecord,
    change: {
      readonly parentId: string | null;
      readonly title: ((remoteTitle: string) => string | null) | null;
      readonly opId: string | null;
    },
  ): Promise<void> {
    const pageId = record.notionPageId!;
    const newParent =
      change.parentId !== null &&
      !(record.notionParentId !== null && notionIdsEqual(change.parentId, record.notionParentId))
        ? change.parentId
        : null;

    let written: RemotePageStamp | null = null;
    let remoteChanged = false;
    if (newParent !== null || change.title) {
      const remote = await this.notionClient.getPage(pageId);
      // 같은 분 안의 편집도 «바뀜» 으로 본다(N-05) — 옮기기와 제목은 그래도 반영한다.
      remoteChanged = this.observation.verdict(record, remote) !== "unchanged";
      const title = change.title ? change.title(this.notionClient.extractTitle(remote)) : null;
      if (newParent !== null) await this.notionClient.movePage(pageId, newParent);
      if (title !== null) {
        written = await this.notionClient.updatePageProperties(pageId, titleProperty(title));
      } else if (newParent !== null) {
        written = await this.notionClient.getPage(pageId);
      }
    }

    this.stateDb.transaction(() => {
      if (newParent !== null) this.stateDb.setNotionParentId(record.id, newParent);
      // Notion 에서도 바뀐 페이지는 기준 시각을 올리지 않는다 — 올리면 다음 pull 이 그 변경을
      // «이미 받은 것» 으로 여긴다. 옮기기와 제목은 본문을 바꾸지 않는다 — 지문은 그대로 둔다.
      if (written !== null && !remoteChanged) this.observation.record(record.id, written);
      if (change.opId !== null) this.stateDb.markPendingCompleted(change.opId);
    });
  }

  /**
   * 페이지 · 행을 만든다. 본문을 markdown 으로 보냈으면 그 markdown 도 돌려준다 — Notion 이 만들며
   * 버린 맨 앞 `# H1` 을 호출측이 매핑을 적은 뒤 되살린다({@link restoreCreatedHeading}). 블록으로
   * 보냈으면 null 이다 — 블록은 보낸 그대로 생긴다.
   */
  private async pushCreatePage(
    parentId: string,
    parentType: "page" | "database",
    title: string,
    markdownContent: string,
    properties?: Record<string, unknown>,
  ): Promise<CreatedPage> {
    if (this.config.conversion.preferMarkdownApi !== false) {
      const markdown = obsidianToNotionEnhanced(markdownContent);
      const page = await this.notionClient.createPageWithMarkdown({
        parentId,
        parentType,
        title,
        markdown,
        properties,
      });
      return { page, markdown };
    }

    const blocks = this.blockConverter.markdownToNotionBlocks(markdownContent);
    const page = await this.notionClient.createPage({
      parentId,
      parentType,
      title,
      properties,
    });
    if (blocks.length > 0) {
      await this.notionClient.appendChildren(page.id, blocks);
    }
    return { page, markdown: null };
  }

  /**
   * 만든 페이지를 마저 채운다 — 버려진 맨 앞 제목을 되살리고 첨부를 올린다. 호출측이 매핑을 먼저
   * 적은 뒤 부른다.
   *
   * @returns 적을 원격 페이지와 본문 지문. 폴더 노트만 지문을 받는다 — 곧 그 아래에 노트가 생겨
   *   수정 시각이 바뀌므로, 다음 push 가 본문이 그대로임을 지문으로 확인한다(자식은 지문에 들지
   *   않는다). 다른 노트의 페이지는 이 도구가 쓰는 한 편집자가 봇으로 남아 지문 없이 가른다.
   */
  private async finishCreatedPage(
    created: CreatedPage,
    conversionResult: ConversionResult,
    path: string,
  ): Promise<{ page: RemotePageStamp; bodyFingerprint: string | null }> {
    let page = await this.restoreCreatedHeading(created, path);
    if (await this.syncEmbeddedMedia(created.page.id, conversionResult, path)) {
      // 첨부가 본문을 고쳤다 — 수정 시각을 다시 받는다(I5). 옛 시각을 적으면 다음 push 가 이
      // 변경을 원격 편집으로 본다.
      page = await this.notionClient.getPage(created.page.id);
    }
    const bodyFingerprint = isFolderNotePath(path)
      ? await this.drift.remoteBodyFingerprintOf(created.page.id)
      : null;
    return { page, bodyFingerprint };
  }

  /**
   * 만들며 버려진 맨 앞 `# H1` 을 되살리고(N-04) 적을 원격 페이지를 돌려준다. 되살렸으면 서버가
   * 다시 준 페이지다 — 만들 때의 시각을 적으면 다음 pull 이 이 교체를 원격 수정으로 본다(I5).
   *
   * 호출측이 매핑을 먼저 적고, 첨부를 올리기 전에 부른다 — 교체가 자리표시자를 첨부로 바꾼 본문을
   * 되돌리지 않는다. 여기서 던지면 그 항목만 실패하고, 다음 push 는 새로 만들지 않고 갱신으로 본문을
   * 다시 보낸다(본문 교체는 맨 앞 H1 을 남긴다).
   */
  private async restoreCreatedHeading(
    created: CreatedPage,
    path: string,
  ): Promise<RemotePageStamp> {
    const { page, markdown } = created;
    if (markdown === null) return page;
    try {
      if (!(await this.notionClient.restoreLeadingHeading(page.id, markdown))) {
        return page;
      }
      return await this.notionClient.getPage(page.id);
    } catch (error) {
      throw new Error(
        `맨 앞 제목을 Notion 에 되살리지 못함 — 다음 push 가 본문을 다시 보낸다 (${path}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * `.base` 가 나타내는 Notion DB id 들 — 옆 사이드카(`<이름>.notion.json`)의 DB 와, 그 DB 를
   * 원본으로 둔 링크드 뷰 컨테이너(pull 이 `.base` 를 원본 DB 로 몰아 만든다). 사이드카가
   * 없거나 읽지 못하면 빈 목록 — 호출측이 제목으로 맞춘다.
   */
  private async databaseIdsOfBase(basePath: string): Promise<string[]> {
    const sidecarPath = basePath.replace(/\.base$/i, ".notion.json");
    let databaseId: unknown;
    try {
      databaseId = (
        JSON.parse(await this.vaultFs.readFile(sidecarPath)) as { databaseId?: unknown }
      ).databaseId;
    } catch {
      return [];
    }
    if (typeof databaseId !== "string") return [];
    const own = compactNotionId(databaseId);
    const linked = [...loadLinkedDbMap(this.stateDb)]
      .filter(([, original]) => original === own)
      .map(([container]) => container);
    return [own, ...linked];
  }

  /**
   * 페이지 본문을 로컬 본문으로 바꾼다. 자식 페이지 · 자식 DB 는 지우지 않는다(S-03).
   *
   * Markdown API 경로는 {@link replacePageBody} 가 자식을 제자리에 두고 바꾼다. 블록 경로는
   * 기존 블록을 모두 지우고 새로 붙이므로 자식까지 지우게 된다 — 자식이 있으면 보내지 않고
   * 실패로 알린다. 예전처럼 조용히 건너뛰면 동기화됨으로 기록돼 편집이 영영 가지 않는다.
   *
   * @returns 바꾼 뒤 원격 본문의 지문({@link remoteBodyFingerprint}). 블록 방식으로 보냈으면 null.
   */
  private async pushUpdatePage(
    pageId: string,
    markdownContent: string,
    _baseSnapshot?: Buffer | null,
  ): Promise<string | null> {
    if (this.config.conversion.preferMarkdownApi !== false) {
      const enhanced = obsidianToNotionEnhanced(markdownContent);
      const written = await replacePageBody(this.notionClient, pageId, enhanced, {
        databaseIdsOfBase: (basePath) => this.databaseIdsOfBase(basePath),
      });
      // 응답의 본문은 다시 받은 본문과 같다 — 잘렸으면 온전한 본문을 다시 받는다.
      return written.truncated || (written.unknown_block_ids ?? []).length > 0
        ? this.drift.remoteBodyFingerprintOf(pageId)
        : remoteBodyFingerprint(written.markdown);
    }

    // 휴지통 자식은 children.list 에 잡히지 않으므로 여기 보이는 자식은 모두 살아 있다.
    const existingBlocks = await this.notionClient.fetchAllChildren(pageId);
    if (existingBlocks.some((b) => b.type === "child_page" || b.type === "child_database")) {
      throw new Error(
        "자식 페이지 · DB 가 있는 페이지는 블록 방식으로 본문을 보내면 자식까지 지워져 보내지 않음 — " +
          "설정 conversion.preferMarkdownApi 를 기본값(true)으로 두고 다시 push 하세요",
      );
    }

    const blocks = this.blockConverter.markdownToNotionBlocks(markdownContent);
    if (blocks.length > 0) {
      await this.notionClient.appendChildren(pageId, blocks);
    }
    const deleteSema = new Sema(this.config.advanced.concurrency);
    await Promise.all(
      existingBlocks.map(async (block) => {
        await deleteSema.acquire();
        try {
          await this.notionClient.deleteBlock(block.id);
        } finally {
          deleteSema.release();
        }
      }),
    );
    return null;
  }
}
