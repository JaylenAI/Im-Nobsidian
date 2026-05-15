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

    return {
      originalUrl: url,
      localPath,
      hash,
      size: buffer.length,
    };
  }

  async downloadAllImages(
    markdown: string,
    pageTitle: string,
  ): Promise<{ content: string; downloads: ImageDownloadResult[] }> {
    const imageRegex = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
    const matches = [...markdown.matchAll(imageRegex)];
    const notionMatches = matches.filter((m) => m[2] && this.isNotionImageUrl(m[2]));

    if (notionMatches.length === 0) {
      return { content: markdown, downloads: [] };
    }

    const sema = new Sema(3);
    const results = await Promise.allSettled(
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

    const downloads: ImageDownloadResult[] = [];
    let result = markdown;

    for (const settled of results) {
      if (settled.status !== "fulfilled") continue;
      const { match, download } = settled.value;
      downloads.push(download);
      const obsidianEmbed = `![[${download.localPath}${match[1] ? `|${match[1]}` : ""}]]`;
      result = result.replace(match[0]!, obsidianEmbed);
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

  private isNotionImageUrl(url: string): boolean {
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
}
