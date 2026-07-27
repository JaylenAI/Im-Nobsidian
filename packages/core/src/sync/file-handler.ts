import { createHash } from "node:crypto";
import { Sema } from "async-sema";
import type { VaultFS, NonMdFileInfo } from "./vault-fs.js";
import type { NotionClient } from "../notion/client.js";
import type { IStateDB } from "../state/state-db-interface.js";
import { isDbArtifactPath } from "./stale-db-artifacts.js";
import { getLogger } from "../utils/logger.js";
import { getBlockType, getMimeType } from "../utils/mime.js";
import type { NotionBlockType } from "../utils/mime.js";

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

  constructor(
    private readonly vaultFs: VaultFS,
    private readonly notionClient: NotionClient,
    private readonly stateDb: IStateDB,
    concurrency: number = 2,
  ) {
    this.sema = new Sema(concurrency);
  }

  async pushFilesForFolder(folderPageId: string, folderPath: string): Promise<FileUploadResult[]> {
    const allFiles = await this.listUploadableFiles();
    const folderFiles = allFiles.filter((f) => getFolderPath(f.path) === folderPath);

    if (folderFiles.length === 0) return [];

    const results: FileUploadResult[] = [];

    for (const file of folderFiles) {
      const existing = this.stateDb.getFileRegistry(file.path);
      if (existing) {
        if (existing.fileSize === file.size) continue;
        const buffer = await this.vaultFs.readBinary(file.path);
        const currentHash = createHash("sha256").update(buffer).digest("hex");
        if (existing.fileHash === currentHash) continue;
      }

      await this.sema.acquire();
      try {
        const result = await this.uploadFile(file, folderPageId);
        if (result) results.push(result);
      } catch (error) {
        getLogger().warn(`파일 업로드 실패 (${file.path}):`, error);
      } finally {
        this.sema.release();
      }
    }

    return results;
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
        const existing = this.stateDb.getFileRegistry(file.path);
        if (existing) {
          if (existing.fileSize === file.size) continue;
          const buffer = await this.vaultFs.readBinary(file.path);
          const currentHash = createHash("sha256").update(buffer).digest("hex");
          if (existing.fileHash === currentHash) continue;
        }

        await this.sema.acquire();
        try {
          const result = await this.uploadFile(file, folderPageId);
          if (result) results.push(result);
        } catch (error) {
          getLogger().warn(`파일 업로드 실패 (${file.path}):`, error);
        } finally {
          this.sema.release();
        }
      }
    }

    return results;
  }

  async downloadFileBlock(
    url: string,
    filename: string,
    targetFolder: string,
  ): Promise<FileDownloadResult> {
    const response = await fetch(url);
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
