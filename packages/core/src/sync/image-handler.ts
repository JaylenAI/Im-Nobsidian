import { createHash } from "node:crypto";
import type { VaultFS } from "./vault-fs.js";

export interface ImageDownloadResult {
  readonly originalUrl: string;
  readonly localPath: string;
  readonly hash: string;
  readonly size: number;
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

export class ImageHandler {
  constructor(
    private readonly vaultFs: VaultFS,
    private readonly attachmentFolder: string = "attachments",
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
    const downloads: ImageDownloadResult[] = [];
    const imageRegex = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
    let result = markdown;

    const matches = [...markdown.matchAll(imageRegex)];

    for (const match of matches) {
      const [fullMatch, alt, url] = match;
      if (!url || !this.isNotionImageUrl(url)) continue;

      try {
        const download = await this.downloadImage(url, pageTitle);
        downloads.push(download);

        const obsidianEmbed = `![[${download.localPath}${alt ? `|${alt}` : ""}]]`;
        result = result.replace(fullMatch!, obsidianEmbed);
      } catch {
        // 다운로드 실패 시 원본 URL 유지
      }
    }

    return { content: result, downloads };
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
