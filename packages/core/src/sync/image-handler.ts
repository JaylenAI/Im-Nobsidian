import { createHash } from "node:crypto";
import { Sema } from "async-sema";
import type { VaultFS } from "./vault-fs.js";
import type { NotionClient } from "../notion/client.js";
import type { IStateDB } from "../state/state-db-interface.js";
import type { ImageReference } from "../types/convert.js";
import { MARKER_BRAND_RE } from "../constants/markers.js";
import { getLogger } from "../utils/logger.js";
import { getMimeType } from "../utils/mime.js";
import { isNotionHostedFileUrl, isNotionAttachmentUri } from "../utils/notion-file-url.js";

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

// 경로에 공백이 있을 수 있어(`![[내 사진.png]]`) 닫는 `%%` 까지 비탐욕으로 받는다.
const LOCAL_MARKER_RE = new RegExp(
  `${MARKER_BRAND_RE}:local-(?:image|file):([^%\\n]+?)\\s*%%`,
  "g",
);

/** 자리표시자 블록 안의 마커 — 종류(image/file)와 원본 임베드 대상을 함께 뽑는다(R1). */
const PLACEHOLDER_MARKER_RE = new RegExp(
  `${MARKER_BRAND_RE}:local-(image|file):([^%\\n]+?)\\s*%%`,
  "u",
);

/** 미디어 자리표시자를 실제 블록으로 바꾸기 위해 찾아 둔 위치 한 건. */
interface PlaceholderHit {
  /** 자리표시자가 들어 있는 부모 블록(페이지 또는 콜아웃/토글 등 컨테이너). */
  readonly parentId: string;
  /** 자리표시자 블록 자신 — 실제 블록을 그 뒤에 넣고 지운다. */
  readonly blockId: string;
  readonly kind: "image" | "file";
  /** `![[...]]` 안에 있던 원본 대상 문자열. `경로|별칭` 형태일 수 있다. */
  readonly target: string;
}

/** 제자리 교체 결과 — 어떤 임베드 대상이 처리됐는지 호출자가 알아야 중복 업로드를 막는다. */
export interface MaterializeResult {
  readonly uploaded: ImageUploadResult[];
  /** 실제 블록으로 바뀐 임베드 대상(원본 문자열 + 별칭 제거형 둘 다 담는다). */
  readonly handledTargets: Set<string>;
}

/** 별칭(`경로|300`)을 떼고 실제 볼트 경로만 남긴다. */
function stripAlias(target: string): string {
  return target.split("|")[0]!;
}

/** 서명 URL 경로 끝의 업로드 파일명. 캡션이 우리가 적은 것인지 대조하는 데 쓴다. */
function uploadedFileNameFromUrl(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    return "";
  }
}

/** 하위 탐색에서 제외할 블록 — 별도 페이지이거나 자식이 다른 곳에 사는 것들. */
const NON_DESCENDABLE_TYPES = new Set(["child_page", "child_database", "synced_block", "table"]);

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

/** 노트 경로에서 그 노트가 사는 폴더만 뽑는다(루트 노트면 undefined). */
function folderOf(notePath?: string): string | undefined {
  return notePath?.includes("/") ? notePath.slice(0, notePath.lastIndexOf("/")) : undefined;
}

/** 블록의 rich_text 를 평문으로 이어 붙인다. 자리표시자 탐지에만 쓰므로 타입별 분기 없이 훑는다. */
function plainTextOf(block: { readonly type: string } & Record<string, unknown>): string {
  const body = block[block.type] as { rich_text?: Array<{ plain_text?: string }> } | undefined;
  if (!body?.rich_text) return "";
  return body.rich_text.map((r) => r.plain_text ?? "").join("");
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

  /**
   * 캡션이 push 가 적어 둔 원본 임베드 대상인지 판정한다(R1). 맞으면 그 문자열을
   * 그대로 돌려주고, 호출자는 사본을 내려받는 대신 `![[원본]]` 으로 되살린다.
   *
   * 사용자가 Notion 에서 손으로 쓴 캡션을 경로로 오인하면 깨진 위키링크가 되므로,
   * ① 파일명이 실제 업로드된 파일명과 같고 ② 볼트에 그 파일이 실재할 때만 인정한다.
   * 둘 중 하나라도 어긋나면 null 을 돌려 기존 다운로드 경로로 떨어진다.
   *
   * ②의 실재 확인은 push 와 **같은 후보 사다리**(노트 폴더 → 루트 → attachments/)를
   * 쓴다 — 위키링크는 파일명만 적는 게 관례라 볼트 루트만 보면 노트 옆 파일을 놓친다.
   */
  private async resolveOriginalTarget(
    label: string,
    uploadedName: string,
    noteFolder?: string,
  ): Promise<string | null> {
    if (!label || !uploadedName) return null;
    // NFM 은 캡션의 `|` 를 `\|` 로 이스케이프해서 돌려준다.
    const target = label.replace(FILE_LABEL_PREFIX_RE, "").replace(/\\(.)/g, "$1").trim();
    if (!target || /^https?:\/\//.test(target) || target.includes("\n")) return null;
    const vaultPath = stripAlias(target);
    if (baseName(vaultPath) !== uploadedName) return null;
    for (const candidate of this.vaultCandidates(vaultPath, noteFolder)) {
      try {
        if (await this.vaultFs.exists(candidate)) return target;
      } catch {
        // 후보 하나가 터져도 나머지는 계속 본다.
      }
    }
    return null;
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
    notePath?: string,
  ): Promise<{ content: string; downloads: ImageDownloadResult[] }> {
    const noteFolder = folderOf(notePath);
    // F14: 캡션에 중첩 링크가 있으면 정규식이 URL 을 오인하므로 괄호 균형 스캔을 쓴다.
    const embeds = scanMarkdownLinks(markdown).filter((s) => s.isEmbed);
    const notionMatches = embeds.filter(
      (s) => /^https?:\/\//.test(s.url) && this.isNotionImageUrl(s.url),
    );
    const internalMatches = embeds.filter((s) => INTERNAL_FILE_URL_RE.test(s.url));

    // attachment:{id}:{filename} — 통합이 접근할 수 없는 파일의 불투명 참조(실측: 어떤
    // 공개 API 로도 해소 불가). 다운로드하지 않고 원문을 보존하되, 사용자가 원인을 알 수
    // 있게 경고만 남긴다.
    for (const span of embeds) {
      if (isNotionAttachmentUri(span.url)) {
        getLogger().warn(
          `[Im-Nobsidian] 접근 불가 첨부(attachment:) 감지 — Notion 통합에 공유되지 않은 ` +
            `원본의 파일이라 다운로드할 수 없습니다. 원문을 보존합니다: ${pageTitle}`,
        );
      }
    }

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
      // 제자리 블록(R1)은 캡션에 원본 경로를 달고 온다 — 사본을 만들지 않고 원본을 가리킨다.
      const original = await this.resolveOriginalTarget(
        span.label,
        uploadedFileNameFromUrl(span.url),
        noteFolder,
      );
      if (original) {
        result = result.replace(span.full, `![[${original}]]`);
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
        const original = await this.resolveOriginalTarget(
          span.label,
          parsed.fileName || uploadedFileNameFromUrl(realUrl),
          noteFolder,
        );
        if (original) {
          result = result.replace(span.full, `![[${original}]]`);
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
    const contentType = getMimeType(filename);
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

    const noteFolder = folderOf(notePath);
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
      // 자리표시자가 없어 제자리 교체가 불가능한 잔여분만 여기로 온다(R1 이후). 페이지 끝에
      // 붙이는 폴백이며, 정상 경로는 materializeLocalMedia 가 본문 자리에서 처리한다.
      // replace_content(기본 push)는 노트 블록을 매번 wipe 하므로 임베드 이미지 블록은
      // 노트 본문이 바뀔 때마다 재업로드가 불가피하다(file_upload 1회용 + atomic replace).
      // 이는 블록 더블링/데이터 손실이 아니며, 무변경 재sync 는 변경감지가 스킵해
      // 재업로드 0 을 보장한다.
      await this.notionClient.appendChildren(pageId, imageBlocks);
      this.registerUploads(pageId, results);
    }

    return results;
  }

  /**
   * push 가 심어 둔 자리표시자 quote 를 **제자리에서** 실제 image/file 블록으로 바꾼다(R1).
   *
   * 그 전에는 임베드 하나가 Notion 에서 두 조각으로 갈라졌다 — 본문 자리에는
   * `> 📎 foo.png` + `%% im-nobsidian:local-image:… %%` 리터럴 마커가, 실제 이미지는
   * 페이지 맨 끝에 따로. 실측: 볼트 175개 파일에서 마커 978건이 Notion 에 그대로
   * 텍스트로 새고 있었고 그중 964건(98.6%)이 이 미디어 쌍이었다. 사용자가 Notion 에서
   * 보는 화면이 깨질 뿐 아니라 이미지가 본문 흐름에서 이탈한다.
   *
   * 캡션에는 원본 임베드 대상을 그대로 적는다. pull 이 경로(와 `|별칭`)를 되찾는
   * 진실원이 되고, 사용자에게도 출처가 보인다.
   *
   * 볼트에서 파일을 못 찾으면 자리표시자를 그대로 둔다 — 마커가 남아야 pull 이
   * 임베드를 복원할 수 있으므로, 반쯤 지우는 것보다 안전하다.
   */
  async materializeLocalMedia(
    pageId: string,
    pushedMarkdown: string,
    notePath?: string,
  ): Promise<MaterializeResult> {
    const empty: MaterializeResult = { uploaded: [], handledTargets: new Set() };
    if (!this.notionClient) return empty;
    // 마커가 없는 페이지에서는 블록 조회조차 하지 않는다 — 대부분의 페이지가 여기서 끝난다.
    LOCAL_MARKER_RE.lastIndex = 0;
    if (!LOCAL_MARKER_RE.test(pushedMarkdown)) return empty;

    let hits: PlaceholderHit[];
    try {
      hits = await this.collectPlaceholders(pageId);
    } catch (error) {
      getLogger().warn(`미디어 자리표시자 조회 실패 (${pageId}):`, error);
      return empty;
    }
    if (hits.length === 0) return empty;

    const noteFolder = folderOf(notePath);
    const uploaded: ImageUploadResult[] = [];
    const handledTargets = new Set<string>();

    for (const hit of hits) {
      const vaultTarget = stripAlias(hit.target);
      try {
        const result = await this.uploadLocalImage(vaultTarget, noteFolder);
        const fileName = baseName(vaultTarget);
        const caption = [{ type: "text", text: { content: hit.target } }];
        const block =
          hit.kind === "image"
            ? {
                type: "image",
                image: { type: "file_upload", file_upload: { id: result.fileUploadId }, caption },
              }
            : {
                type: "file",
                file: {
                  type: "file_upload",
                  file_upload: { id: result.fileUploadId },
                  name: fileName,
                  caption,
                },
              };

        await this.notionClient.appendChildren(hit.parentId, [block], { after: hit.blockId });
        await this.notionClient.deleteBlock(hit.blockId);

        uploaded.push(result);
        handledTargets.add(hit.target);
        handledTargets.add(vaultTarget);
        handledTargets.add(result.localPath);
      } catch (error) {
        // 자리표시자는 손대지 않고 남긴다 — 마커가 살아 있어야 pull 이 임베드를 되살린다.
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
          getLogger().warn(`미디어 제자리 삽입 건너뜀 — 볼트에서 파일을 찾지 못함: ${vaultTarget}`);
        } else {
          getLogger().warn(`미디어 제자리 삽입 실패 (${vaultTarget}):`, error);
        }
      }
    }

    this.registerUploads(pageId, uploaded);
    return { uploaded, handledTargets };
  }

  /**
   * 페이지 블록 트리를 훑어 자리표시자를 부모와 함께 모은다. 콜아웃·토글·목록 안에
   * 들어간 임베드도 제자리 교체하려면 부모 id 가 필요하다(append 의 after_block 은
   * 같은 부모의 자식만 기준으로 삼는다).
   */
  private async collectPlaceholders(rootId: string, depth = 0): Promise<PlaceholderHit[]> {
    if (depth > 4) return [];
    const client = this.notionClient!;
    const children = await client.fetchAllChildren(rootId);
    const hits: PlaceholderHit[] = [];

    for (const block of children) {
      const marker = PLACEHOLDER_MARKER_RE.exec(plainTextOf(block));
      if (marker) {
        hits.push({
          parentId: rootId,
          blockId: block.id,
          kind: marker[1] === "image" ? "image" : "file",
          target: marker[2]!,
        });
        continue;
      }
      if (block.has_children && !NON_DESCENDABLE_TYPES.has(block.type)) {
        hits.push(...(await this.collectPlaceholders(block.id, depth + 1)));
      }
    }
    return hits;
  }

  /**
   * 업로드분을 file_registry 에 남긴다. 노트 임베드는 여기서 페이지에 붙으므로,
   * 이후 FileHandler.pushAllFiles 가 같은 첨부를 폴더 페이지에 standalone 으로
   * 재업로드하는 중복을 공유 레지스트리로 차단한다.
   */
  private registerUploads(pageId: string, results: ImageUploadResult[]): void {
    if (!this.stateDb || results.length === 0) return;
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
        getLogger().warn(`미디어 레지스트리 등록 실패 (${r.localPath}):`, error);
      }
    }
  }

  /**
   * 임베드 경로가 가리킬 수 있는 볼트 실제 파일 후보를 우선순위대로 만든다(F23).
   * Obsidian 위키링크 임베드는 노트 옆 파일을 파일명만으로 참조하는 게 관례라
   * 노트 폴더 → 볼트 루트 → attachments/ 순.
   *
   * push(업로드)와 pull(원본 복원)이 **같은 사다리**를 봐야 왕복이 닫힌다. 예전에는
   * pull 쪽이 볼트 루트만 확인해서, `__e2e_probe__/노트.md` 안의 `![[t-img.png]]` 는
   * 올라갈 때는 노트 폴더에서 잘 찾아 올리고도 내려올 때는 원본을 못 찾아 사본을
   * 새로 받았다(실측) — 왕복할 때마다 첨부가 한 벌씩 늘어난다.
   */
  private vaultCandidates(localPath: string, noteFolder?: string): string[] {
    const candidates: string[] = [];
    if (noteFolder && !localPath.includes("/")) {
      candidates.push(`${noteFolder}/${localPath}`);
    }
    candidates.push(localPath, `${this.attachmentFolder}/${localPath}`);
    return candidates;
  }

  /**
   * 임베드 경로를 볼트 실제 파일로 해석해 읽는다(F23).
   * 폴백은 조용히 진행하고, 전부 실패했을 때만 마지막 오류를 던진다.
   */
  private async readImageFromVault(
    localPath: string,
    noteFolder?: string,
  ): Promise<{ buffer: Buffer; resolvedPath: string }> {
    const candidates = this.vaultCandidates(localPath, noteFolder);

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

  async downloadAllFiles(
    markdown: string,
    pageTitle: string,
    notePath?: string,
  ): Promise<{ content: string; downloads: ImageDownloadResult[] }> {
    const noteFolder = folderOf(notePath);
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
        const original = await this.resolveOriginalTarget(
          span.label,
          uploadedFileNameFromUrl(span.url),
          noteFolder,
        );
        if (original) {
          result = result.replace(span.full, `![[${original}]]`);
          continue;
        }
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
        const original = await this.resolveOriginalTarget(span.label, fileName, noteFolder);
        if (original) {
          result = result.replace(span.full, `![[${original}]]`);
          continue;
        }
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
        const original = await this.resolveOriginalTarget(
          match[2] ?? "",
          uploadedFileNameFromUrl(url),
          noteFolder,
        );
        if (original) {
          result = result.replace(match[0]!, `![[${original}]]`);
          continue;
        }
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
        const original = await this.resolveOriginalTarget(match[2] ?? "", fileName, noteFolder);
        if (original) {
          result = result.replace(match[0]!, `![[${original}]]`);
          continue;
        }
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
          // 원본 링크가 노트에 남는 의도된 degrade — 사용자가 이유를 알 수 있게 info 로 알린다.
          // push 는 restoreMediaTags 가 태그로 복원해 Notion 블록을 보존한다(실측: 동일 블록 유지).
          getLogger().info(
            `[Im-Nobsidian] 파일 다운로드 건너뜀 — 크기 상한 초과 (${sizeMB}MB > ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB), Notion 원본 링크 유지: ${caption}`,
          );
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
    return isNotionHostedFileUrl(url);
  }

  /**
   * notion-hosted 파일 URL 하나를 로컬 첨부로 로컬라이즈한다(P3-A).
   * DB 행의 `files` 속성처럼 본문 밖에 있는 서명 URL 용 — 서명 URL 은 약 1시간 뒤
   * 만료되어 frontmatter 에 남으면 깨진 링크가 되고, push 로 되밀면 Notion 원본이
   * external(만료 URL)로 오염된다(실측). notion-hosted 가 아닌 URL(사용자가 넣은
   * 진짜 외부 링크)은 다운로드 대상이 아니므로 null 을 반환한다.
   *
   * @returns 로컬 첨부 경로(`attachments/...`), 다운로드 대상이 아니거나 실패 시 null
   */
  async localizeNotionFileUrl(url: string, caption: string): Promise<string | null> {
    if (!/^https?:\/\//.test(url) || !this.isNotionFileUrl(url)) return null;
    try {
      const download = await this.downloadFile(url, caption, caption);
      return download.localPath || null;
    } catch (error) {
      getLogger().warn(`[Im-Nobsidian] 속성 파일 다운로드 실패 (${caption}): ${error}`);
      return null;
    }
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
