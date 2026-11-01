import { createHash } from "node:crypto";
import { Sema } from "async-sema";
import type { VaultFS, NonMdFileInfo } from "./vault-fs.js";
import type { NotionClient } from "../notion/client.js";
import type { IStateDB } from "../state/state-db-interface.js";
import { isDbArtifactPath } from "./stale-db-artifacts.js";
import { getLogger } from "../utils/logger.js";
import { getBlockType, getMimeType, isNotionUploadable } from "../utils/mime.js";
import type { NotionBlockType } from "../utils/mime.js";
import { fetchForDownload } from "../utils/download-fetch.js";
import { withDeadline } from "../utils/deadline.js";
import { DEFAULT_CONFIG } from "../types/config.js";
import type { FailedOperation } from "../types/sync.js";
import type { FileRegistryEntry } from "../state/state-db.js";
import { isFolderRecord } from "./folder-container.js";
import {
  embeddedNamesOf,
  folderFileIdsOf,
  rememberFolderFileId,
  type FolderFileRef,
} from "./folder-files.js";
import { uploadedFileNameFromUrl } from "./image-handler.js";
import { fileUrlOfBlock, notionFileIdOf } from "../utils/notion-file-url.js";

/** 첨부 다운로드 운영 튜닝값. 미지정 시 기존 동작과 동일한 기본값 사용. */
export interface FileHandlerOptions {
  /** 다운로드에 쓸 fetch 구현(테스트 주입용). 기본 전역 fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** 다운로드 1회 시도의 시간 상한(ms). 기본 300초. 0 이하면 상한 없음(권장하지 않음). */
  readonly downloadTimeoutMs?: number;
  /** 첨부 1건 업로드 전체의 시간 상한(ms). 기본 30분. 0 이하면 상한 없음. */
  readonly itemTimeoutMs?: number;
  /**
   * pull 이 받은 그림 · 파일을 두는 폴더(`paths.attachments`). 그 안의 파일은 폴더 첨부로 올리지 않는다 — 받은 것을
   * 다시 올리면 Notion 에 사본이 생긴다.
   */
  readonly attachmentsFolder?: string;
}

/** 노트 없는 폴더의 Notion 페이지를 마련하는 쪽 — push 의 폴더 배치(`FolderPlacement`). */
export interface FolderPageProvider {
  /** 폴더의 페이지를 마련한다. 이미 있으면 그대로 둔다. 마련할 수 없으면 까닭과 함께 던진다. */
  ensureFolderPage(folder: string): Promise<void>;
}

/** 점으로 시작하는 폴더 · 파일 안인가 — Obsidian 이 보이지 않는 것(`.obsidian` · 상태 폴더)은 첨부가 아니다. */
function isHiddenPath(path: string): boolean {
  return path.split("/").some((part) => part.startsWith("."));
}

/** 올리지 않은 폴더 첨부 — 폴더에 Notion 자리가 없다. */
interface StrandedFile {
  readonly path: string;
  readonly reason: string;
}

export interface FileUploadResult {
  readonly localPath: string;
  readonly fileUploadId: string;
  readonly blockType: NotionBlockType;
}

export interface FileDownloadResult {
  readonly url: string;
  readonly localPath: string;
  readonly hash: string;
  readonly size: number;
}

function getFolderPath(filePath: string): string {
  const parts = filePath.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

/** 볼트의 첨부를 올릴 것과 Notion 이 받지 않아 올리지 않을 것으로 나눈 목록. */
interface UploadCandidates {
  readonly uploadable: NonMdFileInfo[];
  readonly unsupported: NonMdFileInfo[];
}

/** 로그에 싣는 파일 이름 수 — 나머지는 개수로만 말한다. */
const LOGGED_NAMES = 5;

export class FileHandler {
  private readonly sema: Sema;
  private readonly customFetch?: typeof globalThis.fetch;
  private readonly downloadTimeoutMs: number;
  private readonly itemTimeoutMs: number;
  private readonly attachmentsFolder: string;

  constructor(
    private readonly vaultFs: VaultFS,
    private readonly notionClient: NotionClient,
    private readonly stateDb: IStateDB,
    concurrency: number = DEFAULT_CONFIG.advanced.fileConcurrency,
    options?: FileHandlerOptions,
  ) {
    this.sema = new Sema(concurrency);
    this.customFetch = options?.fetch;
    this.downloadTimeoutMs =
      options?.downloadTimeoutMs ?? DEFAULT_CONFIG.advanced.mediaDownloadTimeoutMs;
    this.itemTimeoutMs = options?.itemTimeoutMs ?? DEFAULT_CONFIG.advanced.itemTimeoutMs;
    this.attachmentsFolder = (
      options?.attachmentsFolder ?? DEFAULT_CONFIG.paths.attachments
    ).replace(/^\/+|\/+$/g, "");
  }

  private get fetchFn(): typeof globalThis.fetch {
    return this.customFetch ?? globalThis.fetch;
  }

  async pushFilesForFolder(folderPageId: string, folderPath: string): Promise<FileUploadResult[]> {
    const { uploadable } = await this.listUploadableFiles();
    const folderFiles = uploadable.filter((f) => getFolderPath(f.path) === folderPath);

    if (folderFiles.length === 0) return [];

    const results: FileUploadResult[] = [];

    for (const file of folderFiles) {
      const existing = this.stateDb.getFileRegistry(file.path);
      if (existing && (await this.isUnchanged(existing, file))) continue;
      const result = await this.pushSingleFile(file, folderPageId, existing);
      if (result) results.push(result);
    }

    return results;
  }

  /**
   * 첨부 1건을 폴더 페이지에 올린다 — 두 push 경로(`pushFilesForFolder` · `pushAllFiles`)의
   * 공통 단위. 변경 없음 판정·동시성 슬롯·시간 상한·실패 격리를 모두 여기 한 곳에 둔다.
   *
   * 한 곳에 모은 이유는 R9a 에서 실제로 데인 적이 있어서다. 같은 다운로드 로직이
   * image/file 핸들러에 두 벌 존재한 탓에 한쪽에만 상한이 걸린 채로 남았고, 상한 없는
   * 쪽이 세마포어를 쥔 채 영원히 매달렸다. 여기도 같은 코드가 두 루프에 나뉘어 있었다.
   *
   * 상한(R9f): 업로드는 호출 1건마다 상한이 있어도(SDK 30초) 멀티파트는 파트 수만큼
   * 호출이 늘어나는 **합성 경로**라 전체로는 여전히 무한대다. 상한을 넘긴 첨부는 경고만
   * 남기고 나머지 첨부는 계속 올린다 — 첨부 하나가 push 전체를 멎게 하지 않는다.
   *
   * @param failed 실패를 결과로 알릴 곳 — 있으면 실패를 여기 담고 경고 로그는 내지 않는다(화면이 결과로 알린다. 둘 다
   *   내면 같은 말이 두 번 나온다). 없으면 경고 로그로만 남는다.
   * @returns 업로드 결과. 변경 없음(스킵)이거나 실패했으면 null.
   */
  private async pushSingleFile(
    file: NonMdFileInfo,
    folderPageId: string,
    existing: FileRegistryEntry | null,
    failed?: FailedOperation[],
  ): Promise<FileUploadResult | null> {
    // 슬롯 대기는 상한 밖이다 — 줄 서서 기다리는 것은 정지가 아니라 정상 동작이다.
    await this.sema.acquire();
    try {
      return await withDeadline(
        () => this.uploadFile(file, folderPageId, existing),
        this.itemTimeoutMs,
        `첨부 업로드 ${file.path}`,
      );
    } catch (error) {
      // 사유만 남긴다 — 오류 객체를 통째로 넘기면 응답 헤더까지 쏟아져 사유가 묻힌다.
      const reason = error instanceof Error ? error.message : String(error);
      if (failed) {
        failed.push({
          path: file.path,
          operation: existing ? "update" : "create",
          error: `첨부 업로드 실패 — ${reason}`,
        });
        getLogger().info(`파일 업로드 실패 (${file.path}): ${reason}`);
      } else {
        getLogger().warn(`파일 업로드 실패 (${file.path}): ${reason}`);
      }
      return null;
    } finally {
      this.sema.release();
    }
  }

  /** 올린 뒤 바뀌지 않았나 — 크기가 같으면 읽지 않는다. */
  private async isUnchanged(existing: FileRegistryEntry, file: NonMdFileInfo): Promise<boolean> {
    if (existing.fileSize === file.size) return true;
    const buffer = await this.vaultFs.readBinary(file.path);
    return existing.fileHash === createHash("sha256").update(buffer).digest("hex");
  }

  /** pull 이 받은 것을 두는 폴더 안인가. */
  private inAttachmentsFolder(path: string): boolean {
    return this.attachmentsFolder !== "" && path.startsWith(`${this.attachmentsFolder}/`);
  }

  /** 폴더 첨부를 둘 Notion 페이지 — 폴더 노트 없는 폴더의 페이지(폴더 레코드)만. 맨 위는 루트 기록이 있을 때만. */
  private folderPageOf(folder: string): string | null {
    const record = this.stateDb.getByPath(folder || "__root__");
    if (!record?.notionPageId) return null;
    return folder === "" || isFolderRecord(record) ? record.notionPageId : null;
  }

  /**
   * 업로드 후보 목록 — 도구 내부 산출물(`.base`/`.notion.json`)은 아예 빼고, Notion 이 받지 않는
   * 형식은 따로 모은다.
   *
   * 내부 산출물: node 측 VaultFS 는 과거 `.base` 를 워커에서 빼는 식으로 우회했지만, Obsidian
   * 어댑터는 모든 파일을 반환하므로 플러그인 push 가 사이드카를 Notion 첨부로 오염시켰다.
   * 소비자인 여기서 일괄 차단해 구현체 간 동작을 통일한다.
   *
   * 받지 않는 형식(S-14): 올리면 업로드를 만들 때 400 으로 거절된다. 등록되지 않으니 push 할
   * 때마다 같은 요청을 다시 보내 같은 이유로 실패했다(실볼트 `.ipynb` 22개).
   */
  private async listUploadableFiles(): Promise<UploadCandidates> {
    const uploadable: NonMdFileInfo[] = [];
    const unsupported: NonMdFileInfo[] = [];
    for (const file of await this.vaultFs.listNonMarkdownFiles()) {
      if (isDbArtifactPath(file.path)) continue;
      (isNotionUploadable(file.path) ? uploadable : unsupported).push(file);
    }
    return { uploadable, unsupported };
  }

  /**
   * 볼트의 첨부를 폴더 페이지마다 올린다.
   *
   * @param failed 올리지 못한 첨부를 담을 곳 — push 결과의 `failed` 를 넘기면 CLI · 플러그인이 처리하지 못한 것으로
   *   보인다. 예전엔 경고 로그로만 남아 push 가 「실패 0」 으로 끝났다.
   */
  async pushAllFiles(
    failed?: FailedOperation[],
    folders?: FolderPageProvider,
  ): Promise<FileUploadResult[]> {
    const { uploadable: allFiles, unsupported } = await this.listUploadableFiles();
    if (unsupported.length > 0) {
      const names = unsupported.slice(0, LOGGED_NAMES).map((f) => f.path);
      const rest = unsupported.length - names.length;
      // 올리지 못한 것이라 경고 — CLI 는 정보 로그를 기본으로 숨기고, 플러그인은 경고를 동기화 기록에 모은다.
      getLogger().warn(
        `[Im-Nobsidian] Notion 이 받지 않는 형식이라 올리지 않은 첨부 ${unsupported.length}개: ` +
          `${names.join(", ")}${rest > 0 ? ` 외 ${rest}개` : ""}`,
      );
    }

    // 올릴 것: 처음 보는 파일 · 폴더 첨부로 올린 뒤 바뀐 파일. 노트 임베드로 올라간 파일(다른 페이지의 기록)은 노트가
    // 올린다 — 여기서 또 올리면 폴더 페이지에 사본이 생긴다.
    const pending: Array<{ file: NonMdFileInfo; existing: FileRegistryEntry | null }> = [];
    for (const file of allFiles) {
      if (this.inAttachmentsFolder(file.path) || isHiddenPath(file.path)) continue;
      const existing = this.stateDb.getFileRegistry(file.path);
      if (existing) {
        if (existing.notionPageId !== this.folderPageOf(getFolderPath(file.path))) continue;
        if (await this.isUnchanged(existing, file)) continue;
      }
      pending.push({ file, existing });
    }
    if (pending.length === 0) return [];

    // 노트에 붙인 파일은 노트와 함께 간다 — 처음 보는 것만 노트에서 찾는다.
    const embedded = pending.some((p) => !p.existing) ? await this.embeddedNames() : new Set();
    const byFolder = new Map<string, typeof pending>();
    for (const item of pending) {
      if (
        !item.existing &&
        embedded.has(item.file.path.slice(item.file.path.lastIndexOf("/") + 1).normalize("NFC"))
      ) {
        continue;
      }
      const folder = getFolderPath(item.file.path);
      const list = byFolder.get(folder) ?? [];
      list.push(item);
      byFolder.set(folder, list);
    }

    const results: FileUploadResult[] = [];
    const stranded: StrandedFile[] = [];
    for (const [folder, items] of byFolder) {
      const pageId = await this.provideFolderPage(folder, folders, items, stranded);
      if (!pageId) continue;
      for (const { file, existing } of items) {
        const result = await this.pushSingleFile(file, pageId, existing, failed);
        if (result) results.push(result);
      }
    }
    this.reportStranded(stranded);
    return results;
  }

  /** 폴더 첨부를 둘 페이지 — 노트 없는 폴더면 마련한다. 둘 곳이 없으면 그 파일들을 `stranded` 에 담고 null. */
  private async provideFolderPage(
    folder: string,
    folders: FolderPageProvider | undefined,
    items: ReadonlyArray<{ file: NonMdFileInfo }>,
    stranded: StrandedFile[],
  ): Promise<string | null> {
    let pageId = this.folderPageOf(folder);
    let reason = folder === "" ? "볼트 맨 위" : "폴더 노트가 있는 폴더 · DB 폴더";
    if (!pageId && folder !== "" && folders && !this.stateDb.getByPath(folder)) {
      try {
        await folders.ensureFolderPage(folder);
        pageId = this.folderPageOf(folder);
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
    }
    if (!pageId) stranded.push(...items.map(({ file }) => ({ path: file.path, reason })));
    return pageId;
  }

  /**
   * 둘 곳이 없어 올리지 않은 폴더 첨부 — 경고로 알린다. 예전에는 디버그 로그로만 남아 파일이 Notion 에 가지 않은 것을 알 수
   * 없었다. 노트에 붙이면 그 노트와 함께 올라간다.
   */
  private reportStranded(stranded: readonly StrandedFile[]): void {
    if (stranded.length === 0) return;
    const names = stranded.slice(0, LOGGED_NAMES).map((f) => `${f.path}(${f.reason})`);
    const rest = stranded.length - names.length;
    getLogger().warn(
      `[Im-Nobsidian] 폴더에 Notion 자리가 없어 올리지 않은 첨부 ${stranded.length}개 — 노트에 붙이면 함께 올라간다: ` +
        `${names.join(", ")}${rest > 0 ? ` 외 ${rest}개` : ""}`,
    );
  }

  /** 볼트의 노트가 붙인 파일 이름 — {@link embeddedNamesOf}. 읽지 못한 노트는 건너뛴다. */
  private async embeddedNames(): Promise<Set<string>> {
    const texts: string[] = [];
    for (const note of await this.vaultFs.listMarkdownFiles()) {
      try {
        texts.push(await this.vaultFs.readFile(note.path));
      } catch {
        // 못 읽은 노트가 붙인 파일은 폴더 첨부로 올라갈 수 있다 — 사본일 뿐 잃는 것은 없다
      }
    }
    return embeddedNamesOf(texts);
  }

  /**
   * 폴더 페이지의 폴더 첨부를 그 폴더에 받는다 — 올린 이름 그대로. Notion 파일 id 가 적어 둔 것과 같으면(올린 볼트 · 앞서
   * 받은 볼트) 받지 않는다. Notion 에서 바뀐 파일은 볼트 쪽이 그대로일 때만 덮는다 — 볼트에서도 고쳤으면 두고 알린다(다음
   * push 가 볼트의 것을 올린다).
   *
   * @returns 새로 받거나 바꾼 파일 수
   */
  async receiveFolderFiles(
    folder: string,
    pageId: string,
    files: readonly FolderFileRef[],
  ): Promise<number> {
    const known = new Map(
      this.stateDb.getFilesByPageId(pageId).map((entry) => [entry.localPath, entry]),
    );
    const ids = folderFileIdsOf(this.stateDb, pageId);
    let received = 0;
    for (const file of files) {
      const localPath = folder ? `${folder}/${file.name}` : file.name;
      const fileId = notionFileIdOf(file.url);
      const entry = known.get(localPath);
      if (entry && fileId && ids.get(localPath) === fileId) continue;
      if (entry && fileId && !ids.has(localPath)) {
        // 파일 id 를 적기 전(v0.17)에 올리거나 받은 것 — 같은 파일로 보고 id 만 적는다
        rememberFolderFileId(this.stateDb, pageId, localPath, fileId);
        continue;
      }
      if (entry && !fileId) continue;
      await this.sema.acquire();
      try {
        if (await this.receiveOne(localPath, folder, pageId, file, entry ?? null)) received++;
        if (fileId) rememberFolderFileId(this.stateDb, pageId, localPath, fileId);
      } catch (error) {
        getLogger().warn(
          `[Im-Nobsidian] 폴더 첨부를 받지 못함 (${localPath}): ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        this.sema.release();
      }
    }
    return received;
  }

  /**
   * 폴더 첨부 하나를 받는다. 볼트에 같은 경로가 있으면: 같은 내용이면 적기만 하고, 지난 동기화 뒤 볼트에서 그대로인 파일은
   * 덮고(`entry`), 그 밖(볼트에서 고친 것 · 처음 보는 다른 파일)은 두고 알린다.
   *
   * @returns 볼트에 썼는가
   */
  private async receiveOne(
    localPath: string,
    folder: string,
    pageId: string,
    file: FolderFileRef,
    entry: FileRegistryEntry | null,
  ): Promise<boolean> {
    const response = await fetchForDownload(this.fetchFn, file.url, this.downloadTimeoutMs);
    if (!response.ok) {
      throw new Error(`파일 다운로드 실패: ${response.status} ${response.statusText}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const hash = createHash("sha256").update(buffer).digest("hex");
    let wrote = false;
    if (await this.vaultFs.exists(localPath)) {
      const localHash = createHash("sha256")
        .update(await this.vaultFs.readBinary(localPath))
        .digest("hex");
      if (localHash !== hash) {
        if (entry?.fileHash !== localHash) {
          getLogger().warn(
            `[Im-Nobsidian] 폴더 첨부를 받지 않음 — 볼트의 ${localPath} 가 Notion 의 것과 다르다` +
              `${entry ? "(양쪽에서 고침 — 다음 push 가 볼트의 것을 올린다)" : "(같은 이름의 다른 파일)"}`,
          );
          return false;
        }
        await this.vaultFs.writeBinary(localPath, buffer);
        wrote = true;
      }
    } else {
      await this.vaultFs.ensureFolder(folder || ".");
      await this.vaultFs.writeBinary(localPath, buffer);
      wrote = true;
    }
    this.stateDb.registerFile({
      localPath,
      notionPageId: pageId,
      fileUploadId: "",
      fileType: getBlockType(file.name),
      fileHash: hash,
      fileSize: buffer.length,
    });
    return wrote;
  }

  async downloadFileBlock(
    url: string,
    filename: string,
    targetFolder: string,
  ): Promise<FileDownloadResult> {
    // 상한 없는 fetch 는 세마포어를 쥔 채 영원히 매달릴 수 있다(utils/download-fetch 주석 참조).
    const response = await fetchForDownload(this.fetchFn, url, this.downloadTimeoutMs);
    if (!response.ok) {
      throw new Error(`파일 다운로드 실패: ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const hash = createHash("sha256").update(buffer).digest("hex");
    const localPath = targetFolder ? `${targetFolder}/${filename}` : filename;

    await this.vaultFs.ensureFolder(targetFolder || ".");
    await this.vaultFs.writeBinary(localPath, buffer);

    return { url, localPath, hash, size: buffer.length };
  }

  async downloadFileBlocks(
    blocks: Array<{ type: string; url: string; caption?: string }>,
    targetFolder: string,
  ): Promise<FileDownloadResult[]> {
    const results: FileDownloadResult[] = [];

    for (const block of blocks) {
      const filename = this.extractFilename(block.url, block.caption);
      if (this.stateDb.isFileRegistered(`${targetFolder}/${filename}`)) continue;

      await this.sema.acquire();
      try {
        const result = await this.downloadFileBlock(block.url, filename, targetFolder);
        results.push(result);
      } catch (error) {
        getLogger().warn(`파일 다운로드 실패 (${block.url}):`, error);
      } finally {
        this.sema.release();
      }
    }

    return results;
  }

  private async uploadFile(
    file: NonMdFileInfo,
    parentPageId: string,
    previous: FileRegistryEntry | null,
  ): Promise<FileUploadResult | null> {
    const buffer = await this.vaultFs.readBinary(file.path);
    const filename = file.path.split("/").pop() ?? "file";
    const contentType = getMimeType(filename);
    const blockType = getBlockType(filename);
    const hash = createHash("sha256").update(buffer).digest("hex");

    const blob = new Blob([buffer], { type: contentType });
    const fileUploadId = await this.notionClient.uploadFile(blob, filename, contentType);

    const block = this.createFileBlock(blockType, fileUploadId, filename);
    const [created] = await this.notionClient.appendChildBlocks(parentPageId, [block]);
    // 바뀐 파일은 새 블록을 붙이고 옛 블록을 지운다 — 예전에는 고칠 때마다 블록이 하나씩 늘었다.
    if (previous) await this.removeOlderBlocks(parentPageId, filename, created?.id);
    // Notion 이 저장한 파일 id 를 적는다 — 다음 pull 이 제가 올린 것을 다시 받지 않는다
    const url = created ? fileUrlOfBlock(created as { readonly type?: string }) : null;
    const fileId = url ? notionFileIdOf(url) : null;
    if (fileId) rememberFolderFileId(this.stateDb, parentPageId, file.path, fileId);

    this.stateDb.registerFile({
      localPath: file.path,
      notionPageId: parentPageId,
      fileUploadId,
      fileType: blockType,
      fileHash: hash,
      fileSize: file.size,
    });

    getLogger().info(`파일 업로드 완료: ${file.path} → ${blockType} 블록`);

    return { localPath: file.path, fileUploadId, blockType };
  }

  /** 이 페이지에서 같은 이름의 파일 블록 중 방금 붙인 것 말고를 지운다. */
  private async removeOlderBlocks(
    pageId: string,
    name: string,
    keep: string | undefined,
  ): Promise<void> {
    for (const block of await this.notionClient.fetchAllChildren(pageId)) {
      if (block.id === keep) continue;
      const media = (block as unknown as Record<string, unknown>)[block.type] as
        { type?: string; file?: { url?: string }; name?: string } | undefined;
      const url = media?.type === "file" ? media.file?.url : undefined;
      if (!url || uploadedFileNameFromUrl(url) !== name) continue;
      await this.notionClient.deleteBlock(block.id);
    }
  }

  /**
   * 폴더 첨부의 파일 블록 — 캡션에 파일 이름을 적는다. 받는 쪽이 그 표시로 폴더 첨부를 알아본다({@link folderFilesOf}) —
   * 자식 페이지가 없는 폴더 페이지는 PDF 하나만 붙인 노트와 모양이 같다.
   */
  private createFileBlock(blockType: NotionBlockType, fileUploadId: string, name: string): unknown {
    const fileRef = {
      type: "file_upload" as const,
      file_upload: { id: fileUploadId },
      caption: [{ type: "text" as const, text: { content: name } }],
    };

    switch (blockType) {
      case "image":
        return { type: "image", image: fileRef };
      case "pdf":
        return { type: "pdf", pdf: fileRef };
      case "video":
        return { type: "video", video: fileRef };
      case "audio":
        return { type: "audio", audio: fileRef };
      case "file":
      default:
        return { type: "file", file: fileRef };
    }
  }

  private extractFilename(url: string, caption?: string): string {
    if (caption) {
      const safe = caption.replace(/[^a-zA-Z0-9가-힣._\s-]/g, "").trim();
      if (safe) return safe;
    }

    try {
      const pathname = new URL(url).pathname;
      const segments = pathname.split("/");
      const last = segments[segments.length - 1];
      if (last && last.includes(".")) return decodeURIComponent(last);
    } catch {
      // fallback
    }

    const ext = url.match(/\.(png|jpg|jpeg|gif|pdf|mp4|mp3|docx|xlsx|zip|webp)(\?|$)/i);
    return `file-${Date.now()}${ext ? `.${ext[1]}` : ""}`;
  }
}
