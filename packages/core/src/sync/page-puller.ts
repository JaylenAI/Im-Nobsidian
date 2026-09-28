import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import type { BlockConverter } from "../converter/block-converter.js";
import { hasBodyBesidesChildren } from "../converter/child-tags.js";
import { notionEnhancedToObsidian } from "../converter/enhanced-md-converter.js";
import { resolveNotionIdWikilinks } from "../converter/notion-id-links.js";
import type { ConversionPipeline } from "../converter/pipeline.js";
import { isCompactExport } from "../converter/post-processors/block-spacer.js";
import type { NotionClient } from "../notion/client.js";
import type { PropertyMapper } from "../notion/property-mapper.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { Config } from "../types/config.js";
import type { RemoteChange, SyncRecord } from "../types/sync.js";
import { pagePathCandidates } from "../utils/db-row-path.js";
import { computeHash } from "../utils/hash.js";
import { normalizeNotionId, notionIdsEqual } from "../utils/id.js";
import { getLogger } from "../utils/logger.js";
import { sanitizeFileName } from "../utils/sanitize.js";
import { resolvePullConflict, sameNoteContent } from "./conflict-detector.js";
import type { DatabaseDiscovery } from "./database-discovery.js";
import type { DatabaseSyncer } from "./database-syncer.js";
import { folderNoteOf, isFolderRecord } from "./folder-container.js";
import type { FolderPlacement } from "./folder-placement.js";
import type { ImageHandler } from "./image-handler.js";
import { moveOrigin } from "./local-moves.js";
import { extractAliases, extractTitle, followsFileName } from "./note-title.js";
import { extractParentId } from "./notion-parent.js";
import { isDatabaseMode } from "./parent-mode.js";
import type { PullOutcome } from "./pull-outcome.js";
import { applyRemoteDeletion, type RemoteDeletionOutcome } from "./remote-deletion.js";
import type { RemoteDetector } from "./remote-detector.js";
import type { RemoteDriftChecker } from "./remote-drift.js";
import { remoteBodyFingerprint } from "./remote-observation.js";
import type { RunObservation } from "./run-observation.js";
import { readLocalNote, type VaultFS } from "./vault-fs.js";

/**
 * 원격 페이지를 볼트에 받는다(pull) — Notion 에서 새로 생긴 페이지는 노트로 쓰고, 바뀐 페이지는
 * 로컬과 견줘 받거나 충돌로 남기고, 지운 페이지는 전략에 따라 지운다.
 *
 * 원격 페이지를 볼트에 쓸 본문으로 렌더하는 일({@link renderRemotePage})은 충돌 해소도 같이 쓴다 —
 * 받을 때와 «원격 유지» 로 해소할 때 같은 노트가 써져야 한다.
 */
export class PagePuller {
  private dbSchemaLoaded = false;
  private _pullImageCount = 0;
  private _pullFileCount = 0;

  // 이번 pull 실행에서 이미 배정된 파일 경로. 워커 풀이 동시에 도는 동안 동명 페이지가
  // 같은 경로를 골라 서로를 덮어쓰는 것을 막는다({@link resolveUniqueFilePath}).
  // 실행마다 비운다 — 지난 실행에서 삭제된 경로를 영구히 막지 않기 위해.
  private readonly claimedPaths = new Set<string>();

  constructor(
    private readonly config: Config,
    private readonly stateDb: IStateDB,
    private readonly notionClient: NotionClient,
    private readonly vaultFs: VaultFS,
    private readonly pipeline: ConversionPipeline,
    private readonly blockConverter: BlockConverter,
    private readonly imageHandler: ImageHandler,
    private readonly propertyMapper: PropertyMapper,
    private readonly databaseSyncer: DatabaseSyncer,
    private readonly observation: RunObservation,
    private readonly drift: RemoteDriftChecker,
    private readonly placement: FolderPlacement,
    private readonly detector: RemoteDetector,
    private readonly discovery: DatabaseDiscovery,
  ) {}

  /**
   * pull 을 시작한다 — 지난 실행의 경로 선점 장부와 내려받은 수를 비운다. 장부를 비우지 않으면
   * 지난 실행에서 삭제된 경로를 계속 막는다.
   */
  beginPull(): void {
    this.claimedPaths.clear();
    this._pullImageCount = 0;
    this._pullFileCount = 0;
  }

  /** 이번 pull 이 내려받은 이미지 수. */
  get imageCount(): number {
    return this._pullImageCount;
  }

  /** 이번 pull 이 내려받은 첨부 파일 수. */
  get fileCount(): number {
    return this._pullFileCount;
  }

  async pullCreate(pageId: string): Promise<string> {
    const page = await this.notionClient.getPage(pageId);
    const title = this.notionClient.extractTitle(page);
    const safeName = sanitizeFileName(title);

    const parentPath = await this.resolveParentPath(page);

    const hasChildPages = await this.pageHasChildContainers(pageId);

    const {
      content: markdown,
      compact: exportCompact,
      fingerprint,
    } = await this.fetchPageMarkdown(pageId);
    const hasContent = markdown.trim().length > 0;

    let filePath: string;
    let fileType: "file" | "folder-note" | "folder-only";

    if (hasChildPages && hasContent) {
      const folderPath = parentPath ? `${parentPath}/${safeName}` : safeName;
      filePath = await this.resolveUniqueFilePath(folderPath, safeName, pageId);
      fileType = "folder-note";
      await this.vaultFs.ensureFolder(folderPath);
    } else if (hasChildPages && !hasContent) {
      const folderPath = parentPath ? `${parentPath}/${safeName}` : safeName;
      filePath = await this.resolveUniqueFilePath(folderPath, safeName, pageId);
      fileType = "folder-only";
      await this.vaultFs.ensureFolder(folderPath);
    } else {
      filePath = await this.resolveUniqueFilePath(parentPath, safeName, pageId);
      fileType = "file";
    }

    let properties: Record<string, unknown>;
    if (isDatabaseMode(this.config)) {
      await this.ensureDbSchema();
      properties = this.propertyMapper.fromNotionProperties(
        (page as unknown as { properties: Record<string, unknown> }).properties,
      );
    } else {
      properties = this.notionClient.extractProperties(page);
    }
    // D2(page 모드): 파일명 stem 으로 복원 가능한 제목은 프론트매터에 주입하지 않는다 —
    // 원본에 없던 `title:` 키가 pull 마다 생기는 가짜 diff 의 원인. sanitize·`(1)` 접미사로
    // 파일명이 제목과 달라진 경우만 보존한다(DB 모드 title 은 Name 컬럼 데이터라 항상 유지).
    if (isDatabaseMode(this.config) || extractTitle(filePath) !== title) {
      properties.title = title;
    }

    let processedMarkdown = await this.imageHandler.restoreUploadedMedia(
      markdown,
      pageId,
      filePath,
    );
    if (this.config.conversion.imageDownload === "immediate") {
      const imageResult = await this.imageHandler.downloadAllImages(
        processedMarkdown,
        title,
        pageId,
      );
      processedMarkdown = imageResult.content;
      this._pullImageCount += imageResult.downloads.length;
    }

    const fileResult = await this.imageHandler.downloadAllFiles(processedMarkdown, title);
    processedMarkdown = fileResult.content;
    this._pullFileCount += fileResult.downloads.length;

    const finalContent = this.pipeline.convertToMarkdown(
      processedMarkdown,
      {
        direction: "pull",
        path: "markdown-api",
        filePath,
        parentMode: this.config.notion.parentMode,
      },
      { properties, notionExportCompact: exportCompact },
    );

    // 부모 해소는 파일 기록 전에 끝낸다. parent 가 block 일 때 resolveBlockToPageId 가
    // API 를 호출(429 가능)하는데, 이를 writeFile 뒤에 두면 기록만 되고 sync_state 등록 전에
    // throw → 재시도 시 같은 페이지가 `(1)` 로 재생성되며 첫 파일이 고아가 된다. 기록↔등록
    // 사이에는 throw 가능한 원격 호출을 두지 않는다(원자적 등록 보장).
    const resolvedParentId = await extractParentId(this.notionClient, page);

    await this.vaultFs.writeFile(filePath, finalContent);

    const hash = computeHash(finalContent);
    const pullStat = await this.vaultFs.getFileStat(filePath);
    this.stateDb.transaction(() => {
      this.stateDb.upsert({
        obsidianPath: filePath,
        notionPageId: pageId,
        notionParentId: resolvedParentId,
        contentHash: hash,
        ...this.observation.fieldsOf(page, fingerprint),
        localLastModified: new Date().toISOString(),
        syncDirection: "both",
        fileType,
        status: "synced",
        baseSnapshot: Buffer.from(finalContent, "utf-8"),
        localMtime: pullStat?.mtime ?? null,
        localFileSize: pullStat?.size ?? null,
      });

      const aliases = extractAliases(properties);
      this.stateDb.upsertWikilink({
        obsidianPath: filePath,
        notionPageId: pageId,
        title,
        aliases,
      });
    });

    return filePath;
  }

  async pullUpdate(change: RemoteChange): Promise<PullOutcome> {
    let record = this.stateDb.getByNotionId(change.pageId);
    if (!record) return { action: "unchanged" };

    const page = await this.notionClient.getPage(change.pageId);

    // push 가 만든 폴더 페이지에는 볼트 파일이 없다 — 폴더로 받는다(S-17).
    if (isFolderRecord(record)) {
      const folderNote = await this.pullFolderRecord(record, page);
      if (!folderNote) return { action: "unchanged", path: record.obsidianPath };
      record = folderNote;
    }

    // 리모트가 휴지통/보관 상태인데 로컬 파일도 없다면 양쪽 다 없는 것이다 — 복원 스캔이
    // 올린 항목이라도 되살릴 원본이 없으므로 빈 껍데기를 만들지 않고 무동작으로 끝낸다.
    // (deleteSync 가 켜져 있으면 전체 스캔이 이 페이지를 deleted 로 따로 처리한다.)
    const remoteGone =
      (page as { in_trash?: boolean }).in_trash === true ||
      (page as { archived?: boolean }).archived === true;
    if (remoteGone && !(await this.vaultFs.exists(record.obsidianPath))) {
      return { action: "unchanged", path: record.obsidianPath };
    }

    const rendered = await this.renderRemotePage(record, change.pageId, page);
    const remoteContent = rendered.content;

    let localContent: string;
    // 읽기 실패를 곧바로 "파일 없음"으로 단정하지 않는다 — 권한 오류로 못 읽은 파일까지
    // 복원 대상으로 삼으면 멀쩡한 로컬 편집을 덮어쓴다. 실패 경로에서만 존재 여부를
    // 한 번 더 물어 '없음'과 '못 읽음'을 가른다.
    let localExists = true;
    try {
      localContent = await this.vaultFs.readFile(record.obsidianPath);
    } catch {
      localContent = "";
      localExists = await this.vaultFs.exists(record.obsidianPath);
    }

    // 받은 원격이 지난 사본 그대로인지 내용으로 가른다 — push 와 같은 규칙(N-05). 렌더한 글이
    // 달라도 받을 것이 없으면, 그 사이 로컬 편집을 충돌로 올리지 않는다. 사라진 파일은 되살린다.
    const remoteUnchanged =
      localExists && (await this.drift.unchangedSinceSync(record, page, rendered.bodyFingerprint));

    const resolution = resolvePullConflict({
      record,
      localContent,
      localExists,
      remoteContent,
      remoteUnchanged,
      remoteChange: change,
      strategy: this.config.sync.conflictStrategy,
    });

    if (resolution.action === "skip") {
      // 원격이 지난 사본 그대로다 — 본 것만 적는다. 로컬 편집은 이어지는 push 가 올린다.
      if (resolution.remoteUnchanged) {
        this.observation.record(record.id, page, rendered.bodyFingerprint);
        return { action: "unchanged", path: record.obsidianPath };
      }
      // local-first: 로컬을 지키고 원격 변경은 받지 않는다. 본 것도 적지 않는다 — 로컬을 올려
      // 원격을 맞출 때까지 다음 pull 이 다시 본다.
      return { action: "skipped", path: record.obsidianPath };
    }
    if (resolution.action === "conflict") {
      this.stateDb.updateStatus(record.id, "conflict");
      return { action: "conflict", path: record.obsidianPath, conflict: resolution.conflict! };
    }

    // I5 false-churn 차단: 리모트 변환 결과가 디스크 내용과 바이트 동일하면 Notion 이
    // last_edited 만 갱신한 '가짜 수정'이다. 파일을 재기록하면 mtime 이 바뀌어 다음 push 가
    // 로컬 수정으로 오인 → push↔pull 무한 churn. 파일은 건드리지 않고 추적 메타
    // (notionLastEdited)만 현재 원격값으로 정렬해 재감지를 멈춘다. content_hash 비교로
    // 진짜 변경과 가짜 변경을 구분하는 핵심 멱등 지점이다.
    // localExists 를 반드시 함께 본다: 파일이 사라졌고 원격도 빈 페이지면 둘 다 "" 라
    // 동일 판정이 나면서 파일을 되쓰지 않고 synced 로 마감돼 삭제가 굳는다.
    // 파일 끝 개행만 다르면 로컬을 그대로 두고 로컬을 사본으로 적는다(sameNoteContent).
    if (localExists && sameNoteContent(remoteContent, localContent)) {
      const stat = await this.vaultFs.getFileStat(record.obsidianPath);
      this.stateDb.upsert({
        obsidianPath: record.obsidianPath,
        notionPageId: change.pageId,
        notionParentId: record.notionParentId,
        contentHash: computeHash(localContent),
        ...this.observation.fieldsOf(page, rendered.bodyFingerprint),
        localLastModified: record.localLastModified,
        syncDirection: record.syncDirection,
        fileType: record.fileType,
        status: "synced",
        baseSnapshot: Buffer.from(localContent, "utf-8"),
        localMtime: stat?.mtime ?? record.localMtime ?? null,
        localFileSize: stat?.size ?? record.localFileSize ?? null,
      });
      return { action: "unchanged", path: record.obsidianPath };
    }

    await this.vaultFs.writeFile(record.obsidianPath, remoteContent);

    const updateStat = await this.vaultFs.getFileStat(record.obsidianPath);
    const newHash = computeHash(remoteContent);
    this.stateDb.transaction(() => {
      this.stateDb.upsert({
        obsidianPath: record.obsidianPath,
        notionPageId: change.pageId,
        notionParentId: record.notionParentId,
        contentHash: newHash,
        ...this.observation.fieldsOf(page, rendered.bodyFingerprint),
        localLastModified: new Date().toISOString(),
        syncDirection: record.syncDirection,
        fileType: record.fileType,
        status: "synced",
        baseSnapshot: Buffer.from(remoteContent, "utf-8"),
        localMtime: updateStat?.mtime ?? null,
        localFileSize: updateStat?.size ?? null,
      });

      const aliases = extractAliases(rendered.properties);
      this.stateDb.upsertWikilink({
        obsidianPath: record.obsidianPath,
        notionPageId: change.pageId,
        title: rendered.title,
        aliases,
      });
    });

    return { action: "written", path: record.obsidianPath };
  }

  /**
   * Notion 에서 사라진 페이지를 볼트에 반영한다. 올리지 않은 로컬 편집이 있으면 전략을 따른다
   * ({@link applyRemoteDeletion}) — 지우지 않고 충돌로 남기거나(manual · duplicate) 파일을 둔다
   * (local-first).
   *
   * @returns `path` 는 진행 표시용 — 추적하지 않던 페이지면 없다.
   */
  async pullDelete(
    change: RemoteChange,
  ): Promise<(RemoteDeletionOutcome | { readonly action: "untracked" }) & { path?: string }> {
    const record = this.stateDb.getByNotionId(change.pageId);
    if (!record) return { action: "untracked" };

    // push 가 만든 폴더 페이지는 추적만 놓는다 — 볼트에서는 폴더다. 안의 노트는 각자의 레코드가
    // 지운다. 예전에는 폴더 경로를 파일처럼 지워, Obsidian 에서는 올리지 않은 노트까지 폴더째
    // 휴지통으로 갔다(S-17).
    if (isFolderRecord(record)) {
      this.stateDb.transaction(() => {
        this.stateDb.delete(record.id);
        this.stateDb.deleteWikilink(record.obsidianPath);
      });
      return { action: "untracked", path: record.obsidianPath };
    }

    const outcome = await applyRemoteDeletion(this.stateDb, this.vaultFs, record, {
      deleteFile: this.config.sync.deleteSync,
      strategy: this.config.sync.conflictStrategy,
      remoteChange: change,
    });
    return { ...outcome, path: record.obsidianPath };
  }

  /**
   * 원격 페이지를 **pull 과 동일한 파이프라인**으로 볼트에 쓸 수 있는 본문까지 렌더한다.
   * (본문 변환 → 이미지/첨부 내려받기 → 속성 주입 → preserve marker → 압축형 간격 판정)
   *
   * pull 경로와 충돌 해소 경로가 이 한 곳을 공유해야 한다. 예전엔 충돌 목록만
   * {@link fetchPageMarkdown} 원문을 그대로 담아, `nobsi resolve` 에서 "원격 유지"를 고르면
   * 프론트매터도 첨부도 없는 반쪽 본문이 볼트에 덮여 썼다 — 해소가 곧 손실이었다.
   *
   * @returns 렌더된 본문과 함께, 호출자가 위키링크 레지스트리 등에 쓰는 제목·속성.
   *          여기서 이미 읽은 값을 되돌려 줘야 호출자가 같은 페이지를 다시 파싱하지 않는다.
   */
  async renderRemotePage(
    record: SyncRecord,
    pageId: string,
    page: Awaited<ReturnType<NotionClient["getPage"]>>,
    options?: { downloadMedia?: boolean },
  ): Promise<{
    content: string;
    title: string;
    properties: Record<string, unknown>;
    /** 받은 원격 본문의 지문 — 모르면 null. */
    bodyFingerprint: string | null;
  }> {
    // 표시 전용 호출(diff)은 첨부를 내려받지 않는다 — 비교를 보려다 볼트에 파일이 생기면
    // 안 된다. 이때 새 미디어는 원격 URL 그대로 남지만, 비교 화면에서만 보이는 차이다.
    const downloadMedia = options?.downloadMedia !== false;
    if (record.fileType === "db-row") {
      // 행은 pull 과 같은 렌더러로 — 페이지처럼 렌더하면 본문 첫머리의 옛 속성 블록이
      // 실제 속성 값을 덮는다(S-02). 충돌 «원격 선택» 은 이 렌더를 파일에 그대로 쓴다.
      return this.databaseSyncer.renderRow(page, record.obsidianPath, { downloadMedia });
    }
    const fetched = await this.fetchPageMarkdown(pageId);
    let markdown = fetched.content;

    const title = this.notionClient.extractTitle(page);

    let properties: Record<string, unknown>;
    if (isDatabaseMode(this.config)) {
      await this.ensureDbSchema();
      properties = this.propertyMapper.fromNotionProperties(
        (page as unknown as { properties: Record<string, unknown> }).properties,
      );
    } else {
      properties = this.notionClient.extractProperties(page);
    }
    // D2: pullCreate 와 동일 — 파일명으로 복원 가능한 제목은 주입하지 않는다.
    if (isDatabaseMode(this.config) || !this.titleFollowsName(record, title)) {
      properties.title = title;
    }

    // 이 노트가 올린 미디어는 내려받지 않고 원래 임베드로 되돌린다 — 표시 전용 렌더도 같다.
    markdown = await this.imageHandler.restoreUploadedMedia(markdown, pageId, record.obsidianPath);

    if (downloadMedia && this.config.conversion.imageDownload === "immediate") {
      const imageResult = await this.imageHandler.downloadAllImages(markdown, title, pageId);
      markdown = imageResult.content;
      this._pullImageCount += imageResult.downloads.length;
    }

    if (downloadMedia) {
      const fileResult = await this.imageHandler.downloadAllFiles(markdown, title);
      markdown = fileResult.content;
      this._pullFileCount += fileResult.downloads.length;
    }

    const savedMarkers = this.stateDb.getPreserveMarkers(record.obsidianPath);
    const content = this.pipeline.convertToMarkdown(
      markdown,
      {
        direction: "pull",
        path: "markdown-api",
        filePath: record.obsidianPath,
        parentMode: this.config.notion.parentMode,
      },
      {
        properties,
        preserveMarkers: savedMarkers.length > 0 ? savedMarkers : undefined,
        notionExportCompact: fetched.compact,
        localContent: await readLocalNote(this.vaultFs, record.obsidianPath),
      },
    );
    return { content, title, properties, bodyFingerprint: fetched.fingerprint };
  }

  /**
   * 페이지 본문을 볼트 쪽 markdown 으로 받는다.
   *
   * @returns `fingerprint` 는 받은 원격 본문의 지문({@link remoteBodyFingerprint}). 블록 API 로
   *   받았으면 null — 지문은 Markdown API 의 본문으로만 견준다.
   */
  async fetchPageMarkdown(
    pageId: string,
  ): Promise<{ content: string; compact: boolean; fingerprint: string | null }> {
    if (this.config.conversion.preferMarkdownApi !== false) {
      try {
        const result = await this.notionClient.getPageMarkdown(pageId);
        this.discovery.collectInlineDbRefs(pageId, result.markdown);
        return {
          content: this.resolveNotionIdWikilinks(notionEnhancedToObsidian(result.markdown)),
          // 압축형 판정은 반드시 원시 export 기준 — enhanced 변환이 <empty-block/> 을
          // 빈 줄로 바꾼 뒤에는 BlockSpacer 가 저작형과 구분할 수 없다(D1).
          compact: isCompactExport(result.markdown),
          fingerprint: remoteBodyFingerprint(result.markdown),
        };
      } catch (error) {
        // Markdown API 실패 시 blocks API fallback — 잘린 블록이 상한보다 많을 때(S-06)도 여기로 온다.
        getLogger().warn(
          `[Im-Nobsidian] Markdown API 로 받지 못해 블록 API 로 받음 (${pageId}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    // blocks-API 폴백 산출물은 이미 표준 간격 — 재간격 불필요.
    // 폴백 변환기도 child-database 보존 마커를 발행하므로 인라인 DB 수집을 이어간다.
    const fallback = await this.blockConverter.notionBlocksToMarkdown(pageId);
    this.discovery.collectInlineDbRefs(pageId, fallback);
    return { content: fallback, compact: false, fingerprint: null };
  }

  /**
   * push 가 만든 폴더 페이지(폴더 레코드)의 원격 변경을 받는다(S-17). 폴더 레코드에는 볼트 파일이
   * 없다 — 예전에는 폴더 경로를 파일로 읽어 «빈 로컬 파일» 과 원격 본문의 충돌로 남겼다.
   *
   * - 자식 말고 본문이 없으면 받을 것이 없다. 그 아래에 페이지가 생겨도 Notion 이 수정 시각을
   *   올린다 — 시각만 맞춰 다음 pull 이 다시 읽지 않게 한다.
   * - 본문이 생겼으면 그 페이지는 이제 폴더 노트다(ADR-012) — 레코드를 폴더 노트 경로로 옮겨 적고
   *   돌려준다. 호출자가 보통 노트처럼 받는다: 로컬 폴더 노트가 없으면 쓰고, 올리지 않은 로컬
   *   폴더 노트가 있으면 그 노트와의 충돌이 된다.
   * - 폴더 노트를 둘 자리가 없으면 본문은 Notion 에만 둔다 — 시각만 맞추고 알린다. DB 모드는
   *   노트가 행이고, v0.3 이 DB 폴더 자리에 만든 폴더 페이지는 그 폴더가 DB 라 행만 든다.
   *
   * @returns 폴더 노트로 옮겨 적은 레코드. 받을 것이 없으면 null.
   * @throws 받을 자리가 없을 때 — 이유와 함께 실패로 남고, 다음 pull 이 다시 본다(기준 시각이
   *         이 변경 앞에 묶인다).
   */
  private async pullFolderRecord(
    record: SyncRecord,
    page: PageObjectResponse,
  ): Promise<SyncRecord | null> {
    const folder = record.obsidianPath;
    const remoteGone =
      (page as { in_trash?: boolean }).in_trash === true ||
      (page as { archived?: boolean }).archived === true;
    if (remoteGone) return null;

    const { markdown } = await this.notionClient.getPageMarkdown(page.id);
    if (!hasBodyBesidesChildren(markdown)) {
      this.observation.record(record.id, page, remoteBodyFingerprint(markdown));
      return null;
    }
    const noPlace = isDatabaseMode(this.config)
      ? "DB 모드는 폴더 노트를 받지 않음"
      : this.placement.folderLookup().databaseAt(folder)
        ? "그 폴더는 DB 라 폴더 노트를 둘 수 없음"
        : null;
    if (noPlace) {
      getLogger().warn(
        `[Im-Nobsidian] 폴더(${folder})의 Notion 페이지에 본문이 있지만 ${noPlace} — Notion 에만 있다`,
      );
      this.observation.record(record.id, page, remoteBodyFingerprint(markdown));
      return null;
    }

    if (this.stateDb.getIncompleteOpByState(record.id, "move")) {
      throw new Error(
        `폴더(${folder})의 이동을 Notion 에 반영하기 전이라 폴더 페이지의 본문을 받지 않음 — ` +
          `push 뒤 pull 이 받는다`,
      );
    }
    const notePath = folderNoteOf(folder);
    if (this.stateDb.getByPath(notePath)) {
      // 두 겹으로 생긴 폴더(S-15 이전 push) — 폴더 노트가 다른 페이지다.
      throw new Error(
        `폴더(${folder})의 Notion 페이지에 본문이 생겼지만 폴더 노트(${notePath})가 다른 ` +
          `페이지라 받지 않음 — 두 페이지 중 하나를 정리해야 한다`,
      );
    }

    this.stateDb.transaction(() => {
      this.stateDb.updatePath(record.id, notePath);
      this.stateDb.deleteWikilink(folder);
    });
    getLogger().info(
      `[Im-Nobsidian] 폴더 페이지에 Notion 에서 쓴 본문을 폴더 노트로 받음: ${folder} → ${notePath}`,
    );
    return this.stateDb.getByPath(notePath);
  }

  /**
   * 페이지가 폴더(자식 페이지·자식 DB 보유)인지 신뢰성 있게 판정한다.
   *
   * 결함(폴더노트 본문분리)의 근본 원인은 얕은 판정이었다 — 최상위 블록 첫 페이지에서
   * child_page 만 검사하면 callout·column·toggle 안에 중첩된 자식 페이지나 child_database 를
   * 놓쳐 폴더노트가 file 로 오분류되고, 본문이 폴더 밖 최상위로 밀려 resolveUniqueFilePath
   * 충돌(' (1).md')로 쪼개졌다.
   *
   * 1차: 발견 단계(서브트리 순회/증분)에서 전 페이지의 부모를 해소하며 만든
   *      집합({@link RemoteDetector.hasChildPages})으로 O(1) 판정(추가 API 호출 0, 처리 순서 무관) — 전체 pull 경로.
   * 폴백: 집합에 없을 때만(증분 pull 의 신규 폴더 등) fetchAllChildrenDeep 로 컨테이너를
   *       재귀 탐색해 child_page·child_database 를 직접 확인한다.
   */
  private async pageHasChildContainers(pageId: string): Promise<boolean> {
    if (this.detector.hasChildPages(pageId)) return true;
    try {
      const deep = await this.notionClient.fetchAllChildrenDeep(pageId);
      return deep.some((b) => b.type === "child_page" || b.type === "child_database");
    } catch {
      return false;
    }
  }

  /**
   * 이 제목을 파일 이름으로 되살릴 수 있는가 — 그러면 frontmatter 에 `title` 을 적지 않는다(D2).
   *
   * 옮기고 아직 Notion 에 반영하지 않은 노트는 Notion 제목이 옛 파일 이름을 따른다. 그 제목을
   * 새 파일의 `title` 로 적으면 push 가 그것을 «사용자가 정한 제목» 으로 보고, 이름 변경을
   * 제목에 반영하지 않는다(S-11).
   */
  private titleFollowsName(record: SyncRecord, title: string): boolean {
    if (extractTitle(record.obsidianPath) === title) return true;
    const op = this.stateDb.getIncompleteOpByState(record.id, "move");
    const origin = moveOrigin(op?.payload ?? null);
    return origin !== null && followsFileName(title, origin);
  }

  private async resolveParentPath(page: PageObjectResponse): Promise<string> {
    const parentId = await extractParentId(this.notionClient, page);
    if (!parentId || notionIdsEqual(parentId, this.config.notion.rootPageId)) return "";

    const parentRecord = this.stateDb.getByNotionId(parentId);
    if (parentRecord) {
      // push 가 만든 폴더 페이지는 폴더 경로 자체로 추적한다 — 그 폴더가 자식의 자리다. 예전에는
      // 폴더 노트 파일처럼 마지막 조각을 떼어 한 층 위에 받았다(S-16). v0.3 이 DB 폴더 자리에 만든
      // 폴더 페이지는 빼고 예전 자리에 둔다 — DB 폴더에는 행만 든다.
      if (
        isFolderRecord(parentRecord) &&
        !this.placement.folderLookup().databaseAt(parentRecord.obsidianPath)
      ) {
        return parentRecord.obsidianPath;
      }
      if (parentRecord.fileType === "folder-note" || parentRecord.fileType === "folder-only") {
        const pathParts = parentRecord.obsidianPath.split("/");
        pathParts.pop();
        return pathParts.join("/");
      }
      const pathParts = parentRecord.obsidianPath.split("/");
      pathParts.pop();
      const parentDir = pathParts.join("/");
      return (
        parentDir ||
        sanitizeFileName(this.notionClient.extractTitle(await this.notionClient.getPage(parentId)))
      );
    }

    try {
      const parentPage = await this.notionClient.getPage(parentId);
      const parentTitle = this.notionClient.extractTitle(parentPage);
      const grandparentPath = await this.resolveParentPath(parentPage);
      const safeName = sanitizeFileName(parentTitle);
      return grandparentPath ? `${grandparentPath}/${safeName}` : safeName;
    } catch {
      return "";
    }
  }

  /**
   * 신규 pull 페이지가 쓸 파일 경로를 충돌 없이 결정하고 **그 자리에서 선점**한다.
   *
   * DB 행과 **같은 규칙**({@link pagePathCandidates})을 쓴다. 예전에는 `(1)`, `(2)` …
   * 순번을 99 까지 훑고 고갈되면 **원본 경로를 그대로 돌려줬는데**, 그러면 남의 노트를
   * 조용히 덮어써 내용이 사라진다. 순번은 그때의 볼트 상태로 정해져 실행마다 페이지끼리
   * 접미사가 뒤바뀔 수도 있었다(pull 마다 파일이 갈아엎히는 churn).
   *
   * 점유 판정은 세 가지를 모두 본다:
   *   · 이번 실행의 선점 장부 — 아래 참조.
   *   · 추적 레코드 — 다른 페이지가 소유한 경로면 피하고, 자기 소유면 그대로 재사용한다.
   *   · 볼트 파일 — 추적되지 않는 사용자 노트가 놓여 있으면 피한다.
   *
   * 선점 장부가 필요한 이유는 pull 이 워커 풀로 **동시 실행**되기 때문이다. 조회와 기록
   * 사이에 await 가 끼면 동명 페이지 여럿이 나란히 "비어 있음"을 보고 같은 경로를 고른다.
   * 그러면 마지막에 쓴 페이지만 남고 나머지 본문이 사라진다(실측 재현: 동명 3페이지 →
   * 파일 1개·레코드 1건). 그래서 마지막 확인과 등록을 **await 없는 동기 구간**에 묶는다 —
   * 그 사이에는 다른 작업이 끼어들 수 없으므로 두 페이지가 같은 경로를 얻는 일이 없다.
   */
  private async resolveUniqueFilePath(
    dir: string,
    safeName: string,
    pageId: string,
  ): Promise<string> {
    const candidates = pagePathCandidates(dir, safeName, pageId);

    for (const candidate of candidates) {
      if (this.claimedPaths.has(candidate)) continue;

      const owner = this.stateDb.getByPath(candidate);
      if (owner) {
        // 자기 소유면 재사용해야 멱등하다(레코드가 남은 채 파일만 지워진 복원 시나리오).
        if (owner.notionPageId != null && notionIdsEqual(owner.notionPageId, pageId)) {
          this.claimedPaths.add(candidate);
          return candidate;
        }
        continue;
      }

      if (await this.vaultFs.exists(candidate)) continue;

      // ── 여기부터 동기 구간(await 금지) ── 위 await 동안 다른 작업이 선점했을 수 있다.
      if (this.claimedPaths.has(candidate)) continue;
      this.claimedPaths.add(candidate);
      return candidate;
    }

    // 전체 ID(32 글자) 후보는 전역 유일하므로 위 루프에서 반드시 반환된다.
    // 도달 불가 경로이나 방어적으로 가장 유일한 후보를 돌려준다.
    const fallback = candidates[candidates.length - 1]!;
    this.claimedPaths.add(fallback);
    return fallback;
  }

  // pull 시 url 기반 page mention 은 `[[notion:<id>]]` 로 1차 변환된다(notionEnhancedToObsidian).
  // 이를 state DB 역조회로 원래 `[[제목]]` 위키링크로 복원해 push↔pull 라운드트립을 수렴시킨다.
  // 볼트 밖/미추적 페이지면 `[[notion:<id>]]` 를 그대로 두어 정보 손실을 막는다.
  private resolveNotionIdWikilinks(markdown: string): string {
    return resolveNotionIdWikilinks(
      markdown,
      (id) => this.stateDb.getByNotionId(normalizeNotionId(id))?.obsidianPath ?? null,
    ).markdown;
  }

  private async ensureDbSchema(): Promise<void> {
    if (this.dbSchemaLoaded || !isDatabaseMode(this.config)) return;
    const schema = await this.notionClient.getDatabaseSchema(this.config.notion.databaseId!);
    this.propertyMapper.loadSchema(schema);
    this.dbSchemaLoaded = true;
  }
}
