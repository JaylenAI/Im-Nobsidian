import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import {
  DECORATION_KEYS,
  DECORATION_LABELS,
  coverSource,
  iconSource,
  isDecorationValue,
  type DecorationKey,
  type DecorationSource,
} from "../notion/decoration-values.js";
import { isNotionValidationError, type NotionClient } from "../notion/client.js";
import { isEmptyFrontmatterValue, plainFrontmatterValue } from "../utils/frontmatter.js";
import { getLogger } from "../utils/logger.js";
import type { ImageHandler } from "./image-handler.js";

/**
 * 페이지 · 행의 아이콘 · 커버를 frontmatter 의 `icon` · `cover` 로 받고 보낸다. 값의 꼴은
 * `notion/decoration-values.ts`.
 *
 * 예전에는 행만 받고(Notion 아이콘의 색은 버렸다) 아무것도 보내지 않았다 — 볼트에서 바꾼 아이콘은 Notion 에
 * 가지 않고, 새 워크스페이스로 push 한 페이지에는 아이콘 · 커버가 없었다. 페이지는 받지도 않았다.
 *
 * 보낼 때는 바뀐 것만 보낸다 — 지난 동기화 사본과 견준다(행 속성과 같다, S-01). 바꾸지 않은 아이콘을 다시
 * 보내면 그 사이 Notion 에서 바꾼 아이콘을 되돌린다. 원격을 로컬로 맞출 때(충돌 해소 · 입양)만 원격과 견준다.
 */
export class PageDecorations {
  /** 사용자 이모지 이름 → id. 한 번 찾은 것은 다시 묻지 않는다. */
  private readonly customEmojiIds = new Map<string, string | null>();

  constructor(
    private readonly notionClient: NotionClient,
    private readonly imageHandler: ImageHandler,
  ) {}

  /**
   * 받은 페이지의 아이콘 · 커버 — frontmatter 에 적을 값. Notion 에 올린 파일은 볼트로 내려받는다(서명
   * 주소는 약 1시간 뒤 만료된다). 내려받지 못했거나 `download` 가 아니면 주소를 그대로 적는다.
   *
   * @param baseName 내려받은 파일 이름의 앞부분 — 보통 노트 이름
   */
  async pulled(
    page: PageObjectResponse,
    baseName: string,
    download: boolean,
  ): Promise<Partial<Record<DecorationKey, string>>> {
    const out: Partial<Record<DecorationKey, string>> = {};
    // 커버 → 아이콘 차례 — 예전 버전이 행에 적던 차례다.
    const cover = this.notionClient.extractCover(page);
    if (cover) {
      const local = download
        ? await this.imageHandler.localizeNotionFileUrl(cover.url, `${baseName}-cover`)
        : null;
      out.cover = local ? `[[${local}]]` : cover.url;
    }
    const icon = this.notionClient.extractIcon(page);
    if (icon) {
      const local =
        download && icon.type === "file"
          ? await this.imageHandler.localizeNotionFileUrl(icon.value, `${baseName}-icon`)
          : null;
      out.icon = local ? `[[${local}]]` : icon.value;
    }
    return out;
  }

  /**
   * frontmatter 에서 바뀐 아이콘 · 커버를 보낸다. 보내지 못한 것은 알리고 넘어간다 — 본문 · 속성은 그대로
   * 보낸다.
   *
   * @param against 무엇과 견주나. `base` 는 지난 동기화 때의 frontmatter, `remote` 는 원격 페이지. `base` 가
   *   있으면 바뀐 것만 — 다만 원격이 지난 동기화 뒤 그대로(`remoteSettled`)인데 원격에 없는 값이 로컬에
   *   있으면 그것도 보낸다.
   *   예전 버전이 아이콘 · 커버를 본문 속성 블록으로 보냈거나 보내지 못한 것이다 — 그대로 두면 이번 push 가
   *   속성 블록에서 빼면서 Notion 에서 사라진다. `base` 가 없으면 원격과 견주고(원격을 로컬로 맞출 때), 둘 다
   *   없으면(새 페이지) 적힌 것을 모두 보낸다.
   * @returns 바꿨으면 바꾼 뒤의 페이지, 보낸 것이 없으면 null
   */
  async push(
    pageId: string,
    path: string,
    current: Readonly<Record<string, unknown>>,
    against: DecorationBaseline,
  ): Promise<PageObjectResponse | null> {
    const changed = DECORATION_KEYS.filter((key) => this.changed(key, current[key], against));
    const body = await this.requests(current, path, changed);
    const keys = Object.keys(body);
    if (keys.length === 0) return null;
    const written = await this.send(pageId, path, body);
    if (written !== undefined || keys.length === 1) return written ?? null;
    // 하나가 거절되면 요청 전체가 거절된다 — Notion 은 없는 아이콘 이름 · 사용자 이모지를 검증 오류로 돌려준다
    // (2026-09-23 · 09-25 API). 아이콘 하나 때문에 커버까지 잃지 않게 하나씩 다시 보낸다.
    let last: PageObjectResponse | null = null;
    for (const key of keys) {
      last = (await this.send(pageId, path, { [key]: body[key] })) ?? last;
    }
    return last;
  }

  /** 꾸밈 요청 하나 — Notion 이 거절하면 알리고 undefined. 그 밖의 실패는 올린다. */
  private async send(
    pageId: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<PageObjectResponse | undefined> {
    try {
      return await this.notionClient.updatePageDecorations(pageId, body);
    } catch (error) {
      if (!isNotionValidationError(error)) throw error;
      getLogger().warn(
        `[Im-Nobsidian] Notion 이 거절한 꾸밈(${Object.keys(body)
          .map((key) => DECORATION_LABELS[key as DecorationKey])
          .join(" · ")}) — ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  /**
   * `keys` 의 값을 보낼 요청으로 — `{ icon?, cover? }`, 비운 값은 null. 보낼 수 없는 값은 알리고 뺀다.
   * 볼트 파일은 여기서 올린다.
   *
   * @param path 알림에 적을 곳 · 볼트 파일을 먼저 찾을 노트
   */
  async requests(
    values: Readonly<Record<string, unknown>>,
    path: string,
    keys: readonly DecorationKey[] = DECORATION_KEYS,
  ): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {};
    for (const key of keys) {
      const source = key === "icon" ? iconSource(values[key]) : coverSource(values[key]);
      const request = await this.requestOf(source, path);
      if (request === undefined) {
        if (source.kind === "invalid") {
          getLogger().warn(
            `[Im-Nobsidian] ${key} 를 보내지 않음 — ${source.reason} (${path}): ${String(values[key])}`,
          );
        }
        continue;
      }
      body[key] = request;
    }
    return body;
  }

  private changed(key: DecorationKey, value: unknown, against: DecorationBaseline): boolean {
    if (against.base) {
      if (!sameText(against.base[key], value)) return true;
      // 원격에 «없을» 때만 — 받기 전 버전의 볼트는 원격에 있는 아이콘을 적지 않았거나(페이지) 색을 뺐다(행).
      // 그런 노트와 원격이 다르다고 보내면 Notion 의 아이콘을 지우거나 회색으로 바꾼다.
      return (
        against.remoteSettled === true &&
        against.remote !== undefined &&
        remoteDecorationOf(this.notionClient, against.remote, key) === null &&
        isDecorationValue(key, value)
      );
    }
    if (against.remote) {
      return !sameDecoration(remoteDecorationOf(this.notionClient, against.remote, key), value);
    }
    return !isEmptyFrontmatterValue(plainFrontmatterValue(value));
  }

  /** 보낼 값 — `null` 은 지운다. 보낼 수 없으면 undefined. */
  private async requestOf(source: DecorationSource, path: string): Promise<unknown> {
    switch (source.kind) {
      case "clear":
        return null;
      case "request":
        return source.request;
      case "custom-emoji": {
        const id = await this.customEmojiId(source.name);
        if (id === null) {
          getLogger().warn(
            `[Im-Nobsidian] 워크스페이스에 없는 사용자 이모지라 아이콘을 보내지 않음 (${path}): :${source.name}:`,
          );
          return undefined;
        }
        return { type: "custom_emoji", custom_emoji: { id } };
      }
      case "local":
        try {
          const uploaded = await this.imageHandler.uploadLocalImage(source.target, folderOf(path));
          return { type: "file_upload", file_upload: { id: uploaded.fileUploadId } };
        } catch (error) {
          getLogger().warn(
            `[Im-Nobsidian] 아이콘 · 커버 파일을 올리지 못함 (${path}): ${source.target} — ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return undefined;
        }
      // Notion 에 올린 파일의 서명 주소는 다시 보낼 수 없다 — 원격의 파일을 그대로 둔다.
      case "hosted":
      case "invalid":
        return undefined;
    }
  }

  private async customEmojiId(name: string): Promise<string | null> {
    if (!this.customEmojiIds.has(name)) {
      this.customEmojiIds.set(name, await this.notionClient.findCustomEmojiId(name));
    }
    return this.customEmojiIds.get(name) ?? null;
  }
}

/** {@link PageDecorations.push} 가 무엇과 견주나. */
export interface DecorationBaseline {
  /** 지난 동기화 때의 frontmatter. */
  readonly base?: Readonly<Record<string, unknown>> | null;
  /** 원격 페이지의 지금 모습. */
  readonly remote?: PageObjectResponse;
  /** 원격이 지난 동기화 뒤 그대로인가 — 수정 시각이 지난번에 본 것과 같다. */
  readonly remoteSettled?: boolean;
}

/**
 * 원격 페이지의 아이콘 · 커버가 `frontmatter` 에 적힌 그대로인가 — {@link PageDecorations.pulled} 가 적는
 * 모양으로 견준다(N-05). Notion 에 올린 파일은 읽을 때마다 주소가 바뀌고(서명) 볼트로 내려받아 적으므로,
 * 있는지만 견준다.
 */
export function decorationsUnchanged(
  notionClient: NotionClient,
  page: PageObjectResponse,
  frontmatter: Readonly<Record<string, unknown>>,
): boolean {
  return DECORATION_KEYS.every((key) =>
    sameDecoration(remoteDecorationOf(notionClient, page, key), frontmatter[key]),
  );
}

function remoteDecorationOf(
  notionClient: NotionClient,
  page: PageObjectResponse,
  key: DecorationKey,
): { readonly uploaded: boolean; readonly value: string } | null {
  if (key === "icon") {
    const icon = notionClient.extractIcon(page);
    return icon === null ? null : { uploaded: icon.type === "file", value: icon.value };
  }
  const cover = notionClient.extractCover(page);
  return cover === null ? null : { uploaded: cover.type === "file", value: cover.url };
}

/**
 * 원격 아이콘 · 커버 하나가 frontmatter 에 적힌 값과 같은가. Notion 에 올린 파일(`uploaded`)은 있는지만
 * 본다. `remote` 는 원격에 없으면 null.
 */
function sameDecoration(
  remote: { readonly uploaded: boolean; readonly value: string } | null,
  written: unknown,
): boolean {
  const present = !isEmptyFrontmatterValue(plainFrontmatterValue(written));
  if (remote === null) return !present;
  return remote.uploaded ? present : written === remote.value;
}

function sameText(a: unknown, b: unknown): boolean {
  const before = plainFrontmatterValue(a);
  const after = plainFrontmatterValue(b);
  if (isEmptyFrontmatterValue(before) && isEmptyFrontmatterValue(after)) return true;
  return String(before) === String(after);
}

/** 노트가 사는 폴더 — 루트 노트면 undefined. 볼트 파일을 노트 옆에서 먼저 찾는다. */
function folderOf(notePath: string): string | undefined {
  return notePath.includes("/") ? notePath.slice(0, notePath.lastIndexOf("/")) : undefined;
}
