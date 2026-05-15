import { createHash } from "node:crypto";
import { Sema } from "async-sema";
import type { VaultFS, NonMdFileInfo } from "./vault-fs.js";
import type { NotionClient } from "../notion/client.js";
import type { StateDB } from "../state/state-db.js";
import { getLogger } from "../utils/logger.js";

export type NotionBlockType = "image" | "pdf" | "video" | "audio" | "file";

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

const EXTENSION_TO_BLOCK_TYPE: Record<string, NotionBlockType> = {
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".gif": "image",
  ".svg": "image",
  ".webp": "image",
  ".ico": "image",
  ".bmp": "image",
  ".tiff": "image",
  ".tif": "image",
  ".avif": "image",
  ".apng": "image",
  ".heic": "image",

  ".pdf": "pdf",

  ".mp4": "video",
  ".mov": "video",
  ".webm": "video",
  ".avi": "video",
  ".mkv": "video",
  ".flv": "video",
  ".wmv": "video",
  ".m4v": "video",
  ".mpeg": "video",
  ".ogv": "video",
  ".3gp": "video",

  ".mp3": "audio",
  ".wav": "audio",
  ".ogg": "audio",
  ".m4a": "audio",
  ".flac": "audio",
  ".aac": "audio",
  ".wma": "audio",
  ".opus": "audio",
  ".weba": "audio",
};

const EXTENSION_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".avif": "image/avif",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed",
  ".py": "text/x-python",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".json": "application/json",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".html": "text/html",
  ".xml": "application/xml",
  ".hwp": "application/x-hwp",
  ".xls": "application/vnd.ms-excel",
  ".doc": "application/msword",
  ".ppt": "application/vnd.ms-powerpoint",
};

export function getBlockType(filename: string): NotionBlockType {
  const ext = filename.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  if (!ext) return "file";
  return EXTENSION_TO_BLOCK_TYPE[ext] ?? "file";
}

export function getMimeType(filename: string): string {
  const ext = filename.match(/\.[^.]+$/)?.[0]?.toLowerCase();
  if (!ext) return "application/octet-stream";
  return EXTENSION_TO_MIME[ext] ?? "application/octet-stream";
}

function getFolderPath(filePath: string): string {
  const parts = filePath.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

export class FileHandler {
  private readonly sema = new Sema(2);

  constructor(
    private readonly vaultFs: VaultFS,
    private readonly notionClient: NotionClient,
    private readonly stateDb: StateDB,
  ) {}

  async pushFilesForFolder(folderPageId: string, folderPath: string): Promise<FileUploadResult[]> {
    const allFiles = await this.vaultFs.listNonMarkdownFiles();
    const folderFiles = allFiles.filter((f) => getFolderPath(f.path) === folderPath);

    if (folderFiles.length === 0) return [];

    const results: FileUploadResult[] = [];

    for (const file of folderFiles) {
      if (this.stateDb.isFileRegistered(file.path)) {
        const existing = this.stateDb.getFileRegistry(file.path);
        if (existing) {
          const buffer = await this.vaultFs.readBinary(file.path);
          const currentHash = createHash("sha256").update(buffer).digest("hex");
          if (existing.fileHash === currentHash) continue;
        }
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

  async pushAllFiles(): Promise<FileUploadResult[]> {
    const allFiles = await this.vaultFs.listNonMarkdownFiles();
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
        getLogger().warn(
          `폴더 페이지 없음, 파일 스킵: ${folderPath || "(루트)"} (${files.length}개)`,
        );
        continue;
      }

      for (const file of files) {
        if (this.stateDb.isFileRegistered(file.path)) {
          const existing = this.stateDb.getFileRegistry(file.path);
          if (existing) {
            const buffer = await this.vaultFs.readBinary(file.path);
            const currentHash = createHash("sha256").update(buffer).digest("hex");
            if (existing.fileHash === currentHash) continue;
          }
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
