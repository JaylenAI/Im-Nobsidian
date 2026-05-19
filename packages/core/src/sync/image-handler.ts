import { createHash } from "node:crypto";
import { Sema } from "async-sema";
import type { VaultFS } from "./vault-fs.js";
import type { NotionClient } from "../notion/client.js";
import type { ImageReference } from "../types/convert.js";
import { getLogger } from "../utils/logger.js";

export interface ImageDownloadResult {
  readonly originalUrl: string;
  readonly localPath: string;
  readonly hash: string;
  readonly size: number;
}

export interface ImageUploadResult {
  readonly localPath: string;
  readonly fileUploadId: string;
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
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
};

export class ImageHandler {
  constructor(
    private readonly vaultFs: VaultFS,
    private readonly attachmentFolder: string = "attachments",
    private readonly notionClient?: NotionClient,
  ) {}

  async downloadImage(url: string, pageTitle: string): Promise<ImageDownloadResult> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
          getLogger().info(
            `[Im-Nobsidian] 이미지 다운로드 재시도 (${attempt + 1}/${maxRetries}): ${pageTitle}`,
          );
        }
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`이미지 다운로드 실패: ${response.status} ${response.statusText}`);
        }

        const contentType = response.headers.get("content-type") ?? "image/png";
        const extension = IMAGE_EXTENSIONS[contentType] ?? this.guessExtension(url) ?? ".png";

        const buffer = Buffer.from(await response.arrayBuffer());
        const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 12);
        const safeName = pageTitle
          .replace(/[^a-zA-Z0-9가-힣\s-]/g, "")
          .replace(/\s+/g, "-")
          .slice(0, 50);

        const fileName = `${safeName}-${hash}${extension}`;
        const localPath = `${this.attachmentFolder}/${fileName}`;

        await this.vaultFs.ensureFolder(this.attachmentFolder);
        await this.vaultFs.writeBinary(localPath, buffer);

        return { originalUrl: url, localPath, hash, size: buffer.length };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError!;
  }

  async downloadAllImages(
    markdown: string,
    pageTitle: string,
  ): Promise<{ content: string; downloads: ImageDownloadResult[] }> {
    const imageRegex = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
    const matches = [...markdown.matchAll(imageRegex)];
    const notionMatches = matches.filter((m) => m[2] && this.isNotionImageUrl(m[2]));

    const internalImageRegex = /!\[([^\]]*)\]\((file:\/\/%7B.*?%7D%7D)\)/g;
    const internalMatches = [...markdown.matchAll(internalImageRegex)];

    if (notionMatches.length === 0 && internalMatches.length === 0) {
      return { content: markdown, downloads: [] };
    }

    const sema = new Sema(3);
    const downloads: ImageDownloadResult[] = [];
    let result = markdown;

    const httpResults = await Promise.allSettled(
      notionMatches.map(async (match) => {
        await sema.acquire();
        try {
          return {
            match,
            download: await this.downloadImage(match[2]!, pageTitle),
          };
        } finally {
          sema.release();
        }
      }),
    );

    for (const settled of httpResults) {
      if (settled.status !== "fulfilled") continue;
      const { match, download } = settled.value;
      downloads.push(download);
      const obsidianEmbed = `![[${download.localPath}${match[1] ? `|${match[1]}` : ""}]]`;
      result = result.replace(match[0]!, obsidianEmbed);
    }

    for (const match of internalMatches) {
      await sema.acquire();
      try {
        const fileUrl = match[2]!;
        const parsed = this.parseNotionFileUrl(fileUrl);
        if (!parsed || !this.notionClient) continue;

        const realUrl = await this.notionClient.getFileBlockUrl(parsed.blockId);
        if (!realUrl) {
          getLogger().warn(`[Im-Nobsidian] 이미지 Block URL 조회 실패: ${parsed.fileName}`);
          continue;
        }

        const download = await this.downloadImage(realUrl, pageTitle);
        downloads.push(download);
        const obsidianEmbed = `![[${download.localPath}${match[1] ? `|${match[1]}` : ""}]]`;
        result = result.replace(match[0]!, obsidianEmbed);
      } catch (error) {
        getLogger().warn(`내부 이미지 다운로드 실패: ${error}`);
      } finally {
        sema.release();
      }
    }

    return { content: result, downloads };
  }

  async uploadLocalImage(localPath: string): Promise<ImageUploadResult> {
    if (!this.notionClient) {
      throw new Error("NotionClient required for image upload");
    }

    const buffer = await this.readImageFromVault(localPath);
    const filename = localPath.split("/").pop() ?? "image.png";
    const contentType = this.getContentTypeFromPath(filename);
    const blob = new Blob([buffer], { type: contentType });
    const fileUploadId = await this.notionClient.uploadFile(blob, filename, contentType);

    return { localPath, fileUploadId };
  }

  async uploadAndAppendImages(
    pageId: string,
    images: ImageReference[],
  ): Promise<ImageUploadResult[]> {
    if (!this.notionClient) return [];

    const localImages = images.filter((img) => !img.isExternal && img.localPath);
    if (localImages.length === 0) return [];

    const results: ImageUploadResult[] = [];
    const imageBlocks: unknown[] = [];

    for (const img of localImages) {
      try {
        const result = await this.uploadLocalImage(img.localPath!);
        results.push(result);
        imageBlocks.push({
          type: "image",
          image: {
            type: "file_upload",
            file_upload: { id: result.fileUploadId },
          },
        });
      } catch (error) {
        getLogger().warn(`이미지 업로드 실패 (${img.localPath}):`, error);
      }
    }

    if (imageBlocks.length > 0) {
      await this.notionClient.appendChildren(pageId, imageBlocks);
    }

    return results;
  }

  private async readImageFromVault(localPath: string): Promise<Buffer> {
    try {
      return await this.vaultFs.readBinary(localPath);
    } catch {
      return await this.vaultFs.readBinary(`${this.attachmentFolder}/${localPath}`);
    }
  }

  private getContentTypeFromPath(filename: string): string {
    const ext = filename.match(/\.[^.]+$/)?.[0]?.toLowerCase();
    return (ext && EXTENSION_TO_MIME[ext]) ?? "application/octet-stream";
  }

  async downloadAllFiles(
    markdown: string,
    pageTitle: string,
  ): Promise<{ content: string; downloads: ImageDownloadResult[] }> {
    const mdLinkRegex = /\[(?:📎|🎬|🎞|📄|🔊)\s*([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
    const mdHttpMatches = [...markdown.matchAll(mdLinkRegex)];
    const notionHttpMatches = mdHttpMatches.filter((m) => m[2] && this.isNotionFileUrl(m[2]));

    const mdInternalRegex = /\[(?:📎|🎬|🎞|📄|🔊)\s*([^\]]*)\]\((file:\/\/%7B.*?%7D%7D)\)/g;
    const mdInternalMatches = [...markdown.matchAll(mdInternalRegex)];

    const xmlHttpRegex =
      /<(?:file|video|audio|pdf)\s+src="(https?:\/\/[^"]+)">([\s\S]*?)<\/(?:file|video|audio|pdf)>/g;
    const xmlHttpMatches = [...markdown.matchAll(xmlHttpRegex)];
    const notionXmlHttpMatches = xmlHttpMatches.filter((m) => m[1] && this.isNotionFileUrl(m[1]));

    const xmlInternalRegex =
      /<(?:file|video|audio|pdf)\s+src="(file:\/\/%7B.*?%7D%7D)">([\s\S]*?)<\/(?:file|video|audio|pdf)>/g;
    const xmlInternalMatches = [...markdown.matchAll(xmlInternalRegex)];

    const totalMatches =
      notionHttpMatches.length +
      mdInternalMatches.length +
      notionXmlHttpMatches.length +
      xmlInternalMatches.length;

    if (totalMatches === 0) {
      return { content: markdown, downloads: [] };
    }

    const sema = new Sema(3);
    const downloads: ImageDownloadResult[] = [];
    let result = markdown;

    for (const match of notionHttpMatches) {
      await sema.acquire();
      try {
        const url = match[2]!;
        const caption = match[1]?.trim() || "file";
        const download = await this.downloadFile(url, pageTitle, caption);
        downloads.push(download);
        const obsidianLink = `[[${download.localPath}|${caption}]]`;
        result = result.replace(match[0]!, obsidianLink);
      } catch (error) {
        getLogger().warn(`파일 다운로드 실패: ${error}`);
      } finally {
        sema.release();
      }
    }

    for (const match of mdInternalMatches) {
      await sema.acquire();
      try {
        const fileUrl = match[2]!;
        const parsed = this.parseNotionFileUrl(fileUrl);
        if (!parsed || !this.notionClient) continue;

        const blockId = parsed.blockId;
        const fileName = parsed.fileName;
        const realUrl = await this.notionClient.getFileBlockUrl(blockId);
        if (!realUrl) continue;

        const caption = fileName || match[1]?.trim() || "file";
        const download = await this.downloadFile(realUrl, pageTitle, caption);
        downloads.push(download);
        const obsidianLink = `[[${download.localPath}|${caption}]]`;
        result = result.replace(match[0]!, obsidianLink);
      } catch (error) {
        getLogger().warn(`내부 파일 다운로드 실패: ${error}`);
      } finally {
        sema.release();
      }
    }

    for (const match of notionXmlHttpMatches) {
      await sema.acquire();
      try {
        const url = match[1]!;
        const caption = match[2]?.trim() || "file";
        const download = await this.downloadFile(url, pageTitle, caption);
        downloads.push(download);
        const obsidianLink = `[[${download.localPath}|${caption}]]`;
        result = result.replace(match[0]!, obsidianLink);
      } catch (error) {
        getLogger().warn(`파일 다운로드 실패: ${error}`);
      } finally {
        sema.release();
      }
    }

    for (const match of xmlInternalMatches) {
      await sema.acquire();
      try {
        const fileUrl = match[1]!;
        const parsed = this.parseNotionFileUrl(fileUrl);
        if (!parsed || !this.notionClient) continue;

        const blockId = parsed.blockId;
        const fileName = parsed.fileName;
        const realUrl = await this.notionClient.getFileBlockUrl(blockId);
        if (!realUrl) continue;

        const caption = fileName || match[2]?.trim() || "file";
        const download = await this.downloadFile(realUrl, pageTitle, caption);
        downloads.push(download);
        const obsidianLink = `[[${download.localPath}|${caption}]]`;
        result = result.replace(match[0]!, obsidianLink);
      } catch (error) {
        getLogger().warn(`내부 파일 다운로드 실패: ${error}`);
      } finally {
        sema.release();
      }
    }

    return { content: result, downloads };
  }

  private parseNotionFileUrl(fileUrl: string): { blockId: string; fileName: string } | null {
    try {
      const decoded = decodeURIComponent(fileUrl.replace("file://", ""));
      const json = JSON.parse(decoded) as {
        source?: string;
        permissionRecord?: { id?: string };
      };
      const blockId = json.permissionRecord?.id ?? "";
      const source = json.source ?? "";
      const fileNameMatch = source.match(/attachment:[^:]+:(.+)$/);
      const fileName = fileNameMatch ? decodeURIComponent(fileNameMatch[1]!) : "";
      return blockId ? { blockId, fileName } : null;
    } catch {
      return null;
    }
  }

  private async downloadFile(
    url: string,
    _pageTitle: string,
    caption: string,
  ): Promise<ImageDownloadResult> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 1000 * attempt));
          getLogger().info(
            `[Im-Nobsidian] 파일 다운로드 재시도 (${attempt + 1}/${maxRetries}): ${caption}`,
          );
        }
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`파일 다운로드 실패: ${response.status} ${response.statusText}`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 12);

        const extension = this.guessFileExtension(url, response.headers.get("content-type"));
        const safeName = caption
          .replace(/[^a-zA-Z0-9가-힣\s._-]/g, "")
          .replace(/\s+/g, "-")
          .slice(0, 80);
        const fileName = `${safeName}-${hash}${extension}`;
        const localPath = `${this.attachmentFolder}/${fileName}`;

        await this.vaultFs.ensureFolder(this.attachmentFolder);
        await this.vaultFs.writeBinary(localPath, buffer);

        return { originalUrl: url, localPath, hash, size: buffer.length };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError!;
  }

  private isNotionImageUrl(url: string): boolean {
    return this.isNotionFileUrl(url);
  }

  private isNotionFileUrl(url: string): boolean {
    return (
      url.includes("secure.notion-static.com") ||
      url.includes("prod-files-secure") ||
      url.includes("s3.us-west-2.amazonaws.com/secure.notion-static.com")
    );
  }

  private guessExtension(url: string): string | null {
    const pathname = new URL(url).pathname;
    const ext = pathname.match(/\.(png|jpg|jpeg|gif|webp|svg|bmp|tiff)(\?|$)/i);
    return ext ? `.${ext[1]!.toLowerCase()}` : null;
  }

  private guessFileExtension(url: string, contentType: string | null): string {
    try {
      const pathname = new URL(url).pathname;
      const extMatch = pathname.match(/\.([a-zA-Z0-9]{1,10})(?:\?|$)/);
      if (extMatch) return `.${extMatch[1]!.toLowerCase()}`;
    } catch {
      // URL 파싱 실패 시 MIME 타입으로 폴백
    }

    const mimeMap: Record<string, string> = {
      "application/pdf": ".pdf",
      "application/zip": ".zip",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
      "application/x-hwp": ".hwp",
      "application/gzip": ".gz",
    };
    if (contentType && mimeMap[contentType]) return mimeMap[contentType]!;
    return "";
  }
}
