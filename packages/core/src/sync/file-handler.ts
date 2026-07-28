import { createHash } from "node:crypto";
import { Sema } from "async-sema";
import type { VaultFS, NonMdFileInfo } from "./vault-fs.js";
import type { NotionClient } from "../notion/client.js";
import type { IStateDB } from "../state/state-db-interface.js";
import { isDbArtifactPath } from "./stale-db-artifacts.js";
import { getLogger } from "../utils/logger.js";
import { getBlockType, getMimeType } from "../utils/mime.js";
import type { NotionBlockType } from "../utils/mime.js";
import { fetchForDownload, DEFAULT_DOWNLOAD_TIMEOUT_MS } from "../utils/download-fetch.js";
import { withDeadline, DEFAULT_ITEM_TIMEOUT_MS } from "../utils/deadline.js";

/** 첨부 다운로드 운영 튜닝값. 미지정 시 기존 동작과 동일한 기본값 사용. */
export interface FileHandlerOptions {
  /** 다운로드에 쓸 fetch 구현(테스트 주입용). 기본 전역 fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** 다운로드 1회 시도의 시간 상한(ms). 기본 300초. 0 이하면 상한 없음(권장하지 않음). */
  readonly downloadTimeoutMs?: number;
  /** 첨부 1건 업로드 전체의 시간 상한(ms). 기본 30분. 0 이하면 상한 없음. */
  readonly itemTimeoutMs?: number;
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

export class FileHandler {
  private readonly sema: Sema;
  private readonly customFetch?: typeof globalThis.fetch;
  private readonly downloadTimeoutMs: number;
  private readonly itemTimeoutMs: number;

  constructor(
    private readonly vaultFs: VaultFS,
    private readonly notionClient: NotionClient,
    private readonly stateDb: IStateDB,
    concurrency: number = 2,
    options?: FileHandlerOptions,
  ) {
    this.sema = new Sema(concurrency);
    this.customFetch = options?.fetch;
    this.downloadTimeoutMs = options?.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
    this.itemTimeoutMs = options?.itemTimeoutMs ?? DEFAULT_ITEM_TIMEOUT_MS;
  }

  private get fetchFn(): typeof globalThis.fetch {
    return this.customFetch ?? globalThis.fetch;
  }

  async pushFilesForFolder(folderPageId: string, folderPath: string): Promise<FileUploadResult[]> {
    const allFiles = await this.listUploadableFiles();
    const folderFiles = allFiles.filter((f) => getFolderPath(f.path) === folderPath);

    if (folderFiles.length === 0) return [];

    const results: FileUploadResult[] = [];

    for (const file of folderFiles) {
      const result = await this.pushSingleFile(file, folderPageId);
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
   * @returns 업로드 결과. 변경 없음(스킵)이거나 실패했으면 null.
   */
  private async pushSingleFile(
    file: NonMdFileInfo,
    folderPageId: string,
  ): Promise<FileUploadResult | null> {
    const existing = this.stateDb.getFileRegistry(file.path);
    if (existing) {
      if (existing.fileSize === file.size) return null;
      const buffer = await this.vaultFs.readBinary(file.path);
      const currentHash = createHash("sha256").update(buffer).digest("hex");
      if (existing.fileHash === currentHash) return null;
    }

    // 슬롯 대기는 상한 밖이다 — 줄 서서 기다리는 것은 정지가 아니라 정상 동작이다.
    await this.sema.acquire();
    try {
      return await withDeadline(
        () => this.uploadFile(file, folderPageId),
        this.itemTimeoutMs,
        `첨부 업로드 ${file.path}`,
      );
    } catch (error) {
      getLogger().warn(`파일 업로드 실패 (${file.path}):`, error);
      return null;
    } finally {
      this.sema.release();
    }
  }

  /**
   * 업로드 후보 목록 — 도구 내부 산출물(`.base`/`.notion.json`)은 제외한다.
   * node 측 VaultFS 는 과거 `.base` 를 워커에서 빼는 식으로 우회했지만, Obsidian
   * 어댑터는 모든 파일을 반환하므로 플러그인 push 가 사이드카를 Notion 첨부로
   * 오염시켰다. 소비자인 여기서 일괄 차단해 구현체 간 동작을 통일한다.
   */
  private async listUploadableFiles(): Promise<NonMdFileInfo[]> {
    const allFiles = await this.vaultFs.listNonMarkdownFiles();
    return allFiles.filter((f) => !isDbArtifactPath(f.path));
  }

  async pushAllFiles(): Promise<FileUploadResult[]> {
    const allFiles = await this.listUploadableFiles();
    if (allFiles.length === 0) return [];

    const filesByFolder = new Map<string, NonMdFileInfo[]>();
    for (const file of allFiles) {
      const folder = getFolderPath(file.path);
      const list = filesByFolder.get(folder) ?? [];
      list.push(file);
      filesByFolder.set(folder, list);
    }

    const results: FileUploadResult[] = [];

    for (const [folderPath, files] of filesByFolder) {
      const folderRecord = folderPath
        ? this.stateDb.getByPath(folderPath)
        : this.stateDb.getByPath("__root__");

      const folderPageId = folderRecord?.notionPageId;
      if (!folderPageId) {
        if (files.length > 0) {
          getLogger().debug(
            `폴더 페이지 없음, 파일 스킵: ${folderPath || "(루트)"} (${files.length}개)`,
          );
        }
        continue;
      }

      for (const file of files) {
        const result = await this.pushSingleFile(file, folderPageId);
        if (result) results.push(result);
      }
    }

    return results;
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
  ): Promise<FileUploadResult | null> {
    const buffer = await this.vaultFs.readBinary(file.path);
    const filename = file.path.split("/").pop() ?? "file";
    const contentType = getMimeType(filename);
    const blockType = getBlockType(filename);
    const hash = createHash("sha256").update(buffer).digest("hex");

    const blob = new Blob([buffer], { type: contentType });
    const fileUploadId = await this.notionClient.uploadFile(blob, filename, contentType);

    const block = this.createFileBlock(blockType, fileUploadId);
    await this.notionClient.appendChildren(parentPageId, [block]);

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

  private createFileBlock(blockType: NotionBlockType, fileUploadId: string): unknown {
    const fileRef = {
      type: "file_upload" as const,
      file_upload: { id: fileUploadId },
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
