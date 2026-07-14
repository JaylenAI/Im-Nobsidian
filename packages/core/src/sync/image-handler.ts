import { createHash } from "node:crypto";
import { Sema } from "async-sema";
import type { VaultFS } from "./vault-fs.js";
import type { NotionClient } from "../notion/client.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { ImageReference } from "../types/convert.js";
import { MARKER_BRAND_RE } from "../constants/markers.js";
import { getLogger } from "../utils/logger.js";

/** 미디어(이미지/파일) 다운로드 운영 튜닝값. 미지정 시 기존 동작과 동일한 기본값 사용. */
export interface MediaOptions {
  readonly concurrency?: number;
  readonly maxRetries?: number;
  readonly retryBaseMs?: number;
  readonly maxFileSizeBytes?: number;
}

export interface ImageDownloadResult {
  readonly originalUrl: string;
  readonly localPath: string;
  readonly hash: string;
  readonly size: number;
}

/** 다운로드는 됐지만 아직 디스크에 쓰지 않은 이미지 — D6 dedup 판정 후 persist 한다. */
interface FetchedImage {
  readonly originalUrl: string;
  readonly localPath: string;
  readonly hash: string;
  /** 전체 sha256 — file_registry.fileHash 와 동일 산식의 비교 키. */
  readonly fullHash: string;
  readonly buffer: Buffer;
}

export interface ImageUploadResult {
  readonly localPath: string;
  readonly fileUploadId: string;
  /** 업로드한 이미지의 전체 sha256 — file_registry 비교 키(FileHandler 와 동일 산식). */
  readonly fileHash: string;
  readonly fileSize: number;
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

/** 괄호 균형 스캔으로 찾은 마크다운 링크/임베드 한 건. */
export interface MarkdownLinkSpan {
  readonly full: string;
  readonly label: string;
  readonly url: string;
  readonly isEmbed: boolean;
}

/**
 * `![label](url)` / `[label](url)` 을 괄호 균형 스캔으로 추출한다.
 * Notion 캡션은 내부에 `[텍스트](url)` 링크를 허용하므로, `[^\]]*` 류 정규식은
 * 캡션 속 첫 `]` 에서 라벨을 끊고 캡션 내부 URL 을 이미지 URL 로 오인한다.
 */
export function scanMarkdownLinks(markdown: string): MarkdownLinkSpan[] {
  const spans: MarkdownLinkSpan[] = [];
  let i = 0;
  while (i < markdown.length) {
    const open = markdown.indexOf("[", i);
    if (open === -1) break;
    if (markdown[open - 1] === "\\") {
      i = open + 1;
      continue;
    }
    const isEmbed = markdown[open - 1] === "!" && markdown[open - 2] !== "\\";
    // 라벨: 대괄호 깊이 균형(이스케이프 스킵). 빈 줄을 만나면 링크가 아니다.
    let depth = 1;
    let j = open + 1;
    let broken = false;
    while (j < markdown.length && depth > 0) {
      const ch = markdown[j];
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === "\n" && markdown[j + 1] === "\n") {
        broken = true;
        break;
      }
      if (ch === "[") depth++;
      else if (ch === "]") depth--;
      j++;
    }
    if (broken || depth !== 0 || markdown[j] !== "(") {
      i = open + 1;
      continue;
    }
    const label = markdown.slice(open + 1, j - 1);
    let parenDepth = 1;
    let k = j + 1;
    while (k < markdown.length && parenDepth > 0) {
      const ch = markdown[k];
      if (ch === "\\") {
        k += 2;
        continue;
      }
      if (ch === "\n") {
        broken = true;
        break;
      }
      if (ch === "(") parenDepth++;
      else if (ch === ")") parenDepth--;
      k++;
    }
    if (broken || parenDepth !== 0) {
      i = open + 1;
      continue;
    }
    const start = isEmbed ? open - 1 : open;
    spans.push({
      full: markdown.slice(start, k),
      label,
      url: markdown.slice(j + 1, k - 1),
      isEmbed,
    });
    i = k;
  }
  return spans;
}

/** 라벨을 `![[경로|별칭]]` 별칭으로 안전하게 쓸 수 있는 평문으로 변환한다. */
export function toWikilinkAlias(label: string): string {
  return label
    .replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, t: string, d?: string) => d ?? t)
    .replace(/[\r\n]+/g, " ")
    .replace(/\]\]/g, ")")
    .replace(/\|/g, "-")
    .trim();
}

const INTERNAL_FILE_URL_RE = /^file:\/\/%7B.*%7D%7D$/;
const FILE_LABEL_PREFIX_RE = /^(?:📎|🎬|🎞|📄|🔊)\s*/u;

const LOCAL_MARKER_RE = new RegExp(`${MARKER_BRAND_RE}:local-(?:image|file):([^\\s%]+)`, "g");

/** pull 원문(이스케이프 포함 가능)에서 제자리 보존 마커의 대상 파일명 집합을 뽑는다(D6). */
function collectLocalMarkerBasenames(markdown: string): Set<string> {
  const names = new Set<string>();
  const unescaped = markdown.replace(/\\/g, "");
  for (const m of unescaped.matchAll(LOCAL_MARKER_RE)) {
    names.add(baseName(m[1]!));
  }
  return names;
}

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

export class ImageHandler {
  private readonly customFetch?: typeof globalThis.fetch;
  private readonly concurrency: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly maxFileSizeBytes: number;

  constructor(
    private readonly vaultFs: VaultFS,
    private readonly attachmentFolder: string = "attachments",
    private readonly notionClient?: NotionClient,
    customFetch?: typeof globalThis.fetch,
    options?: MediaOptions,
    private readonly stateDb?: IStateDB,
  ) {
    this.customFetch = customFetch;
    this.concurrency = options?.concurrency ?? 3;
    this.maxRetries = options?.maxRetries ?? 3;
    this.retryBaseMs = options?.retryBaseMs ?? 1000;
    this.maxFileSizeBytes = options?.maxFileSizeBytes ?? 100 * 1024 * 1024;
  }

  private get fetchFn(): typeof globalThis.fetch {
    return this.customFetch ?? globalThis.fetch;
  }

  async downloadImage(url: string, pageTitle: string): Promise<ImageDownloadResult> {
    return this.persistImage(await this.fetchImage(url, pageTitle));
  }

  private async fetchImage(url: string, pageTitle: string): Promise<FetchedImage> {
    const maxRetries = this.maxRetries;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, this.retryBaseMs * attempt));
          getLogger().info(
            `[Im-Nobsidian] 이미지 다운로드 재시도 (${attempt + 1}/${maxRetries}): ${pageTitle}`,
          );
        }
        const response = await this.fetchFn(url);
        if (!response.ok) {
          throw new Error(`이미지 다운로드 실패: ${response.status} ${response.statusText}`);
        }

        const contentType = response.headers.get("content-type") ?? "image/png";
        const extension = IMAGE_EXTENSIONS[contentType] ?? this.guessExtension(url) ?? ".png";

        const buffer = Buffer.from(await response.arrayBuffer());
        const fullHash = createHash("sha256").update(buffer).digest("hex");
        const hash = fullHash.slice(0, 12);
        const safeName = pageTitle
          .replace(/[^a-zA-Z0-9가-힣\s-]/g, "")
          .replace(/\s+/g, "-")
          .slice(0, 50);

        const fileName = `${safeName}-${hash}${extension}`;
        const localPath = `${this.attachmentFolder}/${fileName}`;

        return { originalUrl: url, localPath, hash, fullHash, buffer };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError!;
  }

  private async persistImage(fetched: FetchedImage): Promise<ImageDownloadResult> {
    await this.vaultFs.ensureFolder(this.attachmentFolder);
    await this.vaultFs.writeBinary(fetched.localPath, fetched.buffer);
    return {
      originalUrl: fetched.originalUrl,
      localPath: fetched.localPath,
      hash: fetched.hash,
      size: fetched.buffer.length,
    };
  }

  async downloadAllImages(
    markdown: string,
    pageTitle: string,
    pageId?: string,
  ): Promise<{ content: string; downloads: ImageDownloadResult[] }> {
    // F14: 캡션에 중첩 링크가 있으면 정규식이 URL 을 오인하므로 괄호 균형 스캔을 쓴다.
    const embeds = scanMarkdownLinks(markdown).filter((s) => s.isEmbed);
    const notionMatches = embeds.filter(
      (s) => /^https?:\/\//.test(s.url) && this.isNotionImageUrl(s.url),
    );
    const internalMatches = embeds.filter((s) => INTERNAL_FILE_URL_RE.test(s.url));

    if (notionMatches.length === 0 && internalMatches.length === 0) {
      return { content: markdown, downloads: [] };
    }

    // D6: push 는 본문 임베드 이미지를 quote+마커 쌍(제자리) + 페이지 끝 이미지 블록
    // (append)의 이중 표현으로 올린다. pull 에서 그 끝 블록을 그대로 받으면 노트 꼬리에
    // 중복 `![[attachments/...]]` 가 유입되므로, file_registry 해시(전체 sha256)와
    // 본문 마커의 파일명이 모두 일치하는 다운로드는 사본으로 판정해 라인째 버린다.
    const registryByHash = new Map<string, string[]>();
    if (pageId && this.stateDb) {
      for (const entry of this.stateDb.getFilesByPageId(pageId)) {
        const list = registryByHash.get(entry.fileHash) ?? [];
        list.push(entry.localPath);
        registryByHash.set(entry.fileHash, list);
      }
    }
    const markerBasenames = collectLocalMarkerBasenames(markdown);
    const isAppendedCopy = (fetched: FetchedImage): boolean => {
      const paths = registryByHash.get(fetched.fullHash);
      return paths !== undefined && paths.some((p) => markerBasenames.has(baseName(p)));
    };

    const sema = new Sema(this.concurrency);
    const downloads: ImageDownloadResult[] = [];
    let result = markdown;

    const httpResults = await Promise.allSettled(
      notionMatches.map(async (span) => {
        await sema.acquire();
        try {
          return {
            span,
            fetched: await this.fetchImage(span.url, pageTitle),
          };
        } finally {
          sema.release();
        }
      }),
    );

    for (const settled of httpResults) {
      if (settled.status !== "fulfilled") continue;
      const { span, fetched } = settled.value;
      if (isAppendedCopy(fetched)) {
        result = result.replace(span.full, "");
        continue;
      }
      const download = await this.persistImage(fetched);
      downloads.push(download);
      const alias = toWikilinkAlias(span.label);
      const obsidianEmbed = `![[${download.localPath}${alias ? `|${alias}` : ""}]]`;
      result = result.replace(span.full, obsidianEmbed);
    }

    for (const span of internalMatches) {
      await sema.acquire();
      try {
        const parsed = this.parseNotionFileUrl(span.url);
        if (!parsed || !this.notionClient) continue;

        const realUrl = await this.notionClient.getFileBlockUrl(parsed.blockId);
        if (!realUrl) {
          getLogger().warn(`[Im-Nobsidian] 이미지 Block URL 조회 실패: ${parsed.fileName}`);
          continue;
        }

        const fetched = await this.fetchImage(realUrl, pageTitle);
        if (isAppendedCopy(fetched)) {
          result = result.replace(span.full, "");
          continue;
        }
        const download = await this.persistImage(fetched);
        downloads.push(download);
        const alias = toWikilinkAlias(span.label);
        const obsidianEmbed = `![[${download.localPath}${alias ? `|${alias}` : ""}]]`;
        result = result.replace(span.full, obsidianEmbed);
      } catch (error) {
        getLogger().warn(`내부 이미지 다운로드 실패: ${error}`);
      } finally {
        sema.release();
      }
    }

    return { content: result, downloads };
  }

  async uploadLocalImage(localPath: string, noteFolder?: string): Promise<ImageUploadResult> {
    if (!this.notionClient) {
      throw new Error("NotionClient required for image upload");
    }

    const { buffer, resolvedPath } = await this.readImageFromVault(localPath, noteFolder);
    const filename = localPath.split("/").pop() ?? "image.png";
    const contentType = this.getContentTypeFromPath(filename);
    const blob = new Blob([buffer], { type: contentType });
    const fileUploadId = await this.notionClient.uploadFile(blob, filename, contentType);
    // FileHandler.pushAllFiles 의 dedup 비교(전체 sha256)와 동일 산식으로 계산해 두 경로가
    // 같은 첨부를 동일 키로 인식하게 한다. localPath 도 해석된 실제 볼트 경로로 돌려줘야
    // 레지스트리 키가 폴더 스캔(pushAllFiles)의 file.path 와 일치해 중복 업로드가 차단된다.
    const fileHash = createHash("sha256").update(buffer).digest("hex");

    return { localPath: resolvedPath, fileUploadId, fileHash, fileSize: buffer.length };
  }

  async uploadAndAppendImages(
    pageId: string,
    images: ImageReference[],
    notePath?: string,
  ): Promise<ImageUploadResult[]> {
    if (!this.notionClient) return [];

    const localImages = images.filter((img) => !img.isExternal && img.localPath);
    if (localImages.length === 0) return [];

    const noteFolder = notePath?.includes("/")
      ? notePath.slice(0, notePath.lastIndexOf("/"))
      : undefined;
    const results: ImageUploadResult[] = [];
    const imageBlocks: unknown[] = [];

    for (const img of localImages) {
      try {
        const result = await this.uploadLocalImage(img.localPath!, noteFolder);
        results.push(result);
        imageBlocks.push({
          type: "image",
          image: {
            type: "file_upload",
            file_upload: { id: result.fileUploadId },
          },
        });
      } catch (error) {
        // 경로 미해석(ENOENT)은 예상 가능한 상황(폴더 스캔 업로드가 후속 처리) —
        // 스택트레이스 대신 한 줄 경고로 낮춘다(F23). 그 외 오류는 원본을 남긴다.
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          getLogger().warn(`이미지 업로드 건너뜀 — 볼트에서 파일을 찾지 못함: ${img.localPath}`);
        } else {
          getLogger().warn(`이미지 업로드 실패 (${img.localPath}):`, error);
        }
      }
    }

    if (imageBlocks.length > 0) {
      await this.notionClient.appendChildren(pageId, imageBlocks);
      // 업로드 성공분을 file_registry 에 등록한다. 노트 임베드 이미지는 여기서(노트 페이지에)
      // 처리되므로, 이후 FileHandler.pushAllFiles 가 같은 첨부를 폴더 페이지에 standalone
      // 으로 재업로드하는 중복(I6 "중복 업로드 0" 위반)을 공유 레지스트리로 차단한다.
      // 단, replace_content(기본 push)는 노트 블록을 매번 wipe 하므로 임베드 이미지 블록은
      // 노트 본문이 바뀔 때마다 재업로드+재append 가 불가피하다(file_upload 1회용 + atomic
      // replace). 이는 블록 더블링/데이터 손실이 아니며, 무변경 재sync 는 변경감지가 스킵해
      // 재업로드 0 을 보장한다.
      if (this.stateDb) {
        for (const r of results) {
          try {
            this.stateDb.registerFile({
              localPath: r.localPath,
              notionPageId: pageId,
              fileUploadId: r.fileUploadId,
              fileType: "image",
              fileHash: r.fileHash,
              fileSize: r.fileSize,
            });
          } catch (error) {
            getLogger().warn(`이미지 레지스트리 등록 실패 (${r.localPath}):`, error);
          }
        }
      }
    }

    return results;
  }

  /**
   * 임베드 경로를 볼트 실제 파일로 해석한다(F23). Obsidian 위키링크 임베드는 노트 옆
   * 파일을 파일명만으로 참조하는 게 관례라, 노트 폴더 → 볼트 루트 → attachments/ 순으로
   * 시도한다. 폴백은 조용히 진행하고, 전부 실패했을 때만 마지막 오류를 던진다.
   */
  private async readImageFromVault(
    localPath: string,
    noteFolder?: string,
  ): Promise<{ buffer: Buffer; resolvedPath: string }> {
    const candidates: string[] = [];
    if (noteFolder && !localPath.includes("/")) {
      candidates.push(`${noteFolder}/${localPath}`);
    }
    candidates.push(localPath, `${this.attachmentFolder}/${localPath}`);

    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        return { buffer: await this.vaultFs.readBinary(candidate), resolvedPath: candidate };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  private getContentTypeFromPath(filename: string): string {
    const ext = filename.match(/\.[^.]+$/)?.[0]?.toLowerCase();
    return (ext && EXTENSION_TO_MIME[ext]) ?? "application/octet-stream";
  }

  async downloadAllFiles(
    markdown: string,
    pageTitle: string,
  ): Promise<{ content: string; downloads: ImageDownloadResult[] }> {
    // F14: 캡션 중첩 링크 대응 — 괄호 균형 스캔 후 파일 라벨(이모지 프리픽스)만 취한다.
    const fileLinks = scanMarkdownLinks(markdown).filter(
      (s) => !s.isEmbed && FILE_LABEL_PREFIX_RE.test(s.label),
    );
    const notionHttpMatches = fileLinks.filter(
      (s) => /^https?:\/\//.test(s.url) && this.isNotionFileUrl(s.url),
    );
    const mdInternalMatches = fileLinks.filter((s) => INTERNAL_FILE_URL_RE.test(s.url));

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

    const sema = new Sema(this.concurrency);
    const downloads: ImageDownloadResult[] = [];
    let result = markdown;

    for (const span of notionHttpMatches) {
      await sema.acquire();
      try {
        const caption = toWikilinkAlias(span.label.replace(FILE_LABEL_PREFIX_RE, "")) || "file";
        const download = await this.downloadFile(span.url, pageTitle, caption);
        if (!download.localPath) continue;
        downloads.push(download);
        // F19: 다운로드한 미디어는 링크가 아니라 임베드(![[..]])로 복원해야 인라인 렌더된다.
        const obsidianLink = `![[${download.localPath}|${caption}]]`;
        result = result.replace(span.full, obsidianLink);
      } catch (error) {
        getLogger().warn(`파일 다운로드 실패: ${error}`);
      } finally {
        sema.release();
      }
    }

    for (const span of mdInternalMatches) {
      await sema.acquire();
      try {
        const parsed = this.parseNotionFileUrl(span.url);
        if (!parsed || !this.notionClient) continue;

        const blockId = parsed.blockId;
        const fileName = parsed.fileName;
        const realUrl = await this.notionClient.getFileBlockUrl(blockId);
        if (!realUrl) continue;

        const caption =
          fileName || toWikilinkAlias(span.label.replace(FILE_LABEL_PREFIX_RE, "")) || "file";
        const download = await this.downloadFile(realUrl, pageTitle, caption);
        if (!download.localPath) continue;
        downloads.push(download);
        const obsidianLink = `![[${download.localPath}|${caption}]]`;
        result = result.replace(span.full, obsidianLink);
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
        const caption = toWikilinkAlias(match[2] ?? "") || "file";
        const download = await this.downloadFile(url, pageTitle, caption);
        if (!download.localPath) continue;
        downloads.push(download);
        const obsidianLink = `![[${download.localPath}|${caption}]]`;
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

        const caption = fileName || toWikilinkAlias(match[2] ?? "") || "file";
        const download = await this.downloadFile(realUrl, pageTitle, caption);
        if (!download.localPath) continue;
        downloads.push(download);
        const obsidianLink = `![[${download.localPath}|${caption}]]`;
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
    const maxRetries = this.maxRetries;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, this.retryBaseMs * attempt));
          getLogger().info(
            `[Im-Nobsidian] 파일 다운로드 재시도 (${attempt + 1}/${maxRetries}): ${caption}`,
          );
        }
        const response = await this.fetchFn(url);
        if (!response.ok) {
          throw new Error(`파일 다운로드 실패: ${response.status} ${response.statusText}`);
        }

        const contentLength = response.headers.get("content-length");
        const MAX_FILE_SIZE = this.maxFileSizeBytes;
        if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
          const sizeMB = Math.round(parseInt(contentLength, 10) / 1024 / 1024);
          getLogger().debug(`[Im-Nobsidian] 파일 스킵 — 너무 큼 (${sizeMB}MB): ${caption}`);
          return { originalUrl: url, localPath: "", hash: "", size: 0 };
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
