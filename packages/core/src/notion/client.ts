import { Client, LogLevel } from "@notionhq/client";
import { Sema } from "async-sema";
import type {
  BlockObjectResponse,
  PageObjectResponse,
  PartialBlockObjectResponse,
  PageMarkdownResponse,
} from "@notionhq/client/build/src/api-endpoints.js";
import type {
  DataSourceViewObjectResponse,
  ListDatabaseViewsResponse,
} from "@notionhq/client/build/src/api-endpoints/views.js";
import { PropertyMapper } from "./property-mapper.js";
import type { ViewConfig, DatabaseViewsConfig, PageCover, PageIcon } from "../types/view.js";
import type { Config } from "../types/config.js";

export interface NotionClientOptions {
  readonly token: string;
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  readonly rateLimitIntervalMs?: number;
  readonly maxRetries?: number;
  readonly retryBaseDelayMs?: number;
  readonly retryBackoffFactor?: number;
  readonly pageSize?: number;
  readonly batchSize?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export class NotionClient {
  private readonly client: Client;
  private readonly sema: Sema;
  private readonly token: string;
  private readonly propertyMapper = new PropertyMapper();

  private readonly customFetch?: typeof globalThis.fetch;

  private readonly minRequestInterval: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryBackoffFactor: number;
  private readonly defaultPageSize: number;
  private readonly batchSize: number;

  constructor(options: NotionClientOptions) {
    this.client = new Client({
      auth: options.token,
      timeoutMs: options.timeoutMs ?? 30000,
      logLevel: LogLevel.ERROR,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.token = options.token;
    this.customFetch = options.fetch;
    this.sema = new Sema(options.concurrency ?? 3);
    this.minRequestInterval = options.rateLimitIntervalMs ?? 350;
    this.maxRetries = options.maxRetries ?? 5;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1000;
    this.retryBackoffFactor = options.retryBackoffFactor ?? 2;
    this.defaultPageSize = options.pageSize ?? 100;
    this.batchSize = options.batchSize ?? 100;
  }

  /** config.advanced 의 운영 튜닝값으로 클라이언트를 생성한다 (매직넘버 단일 진실원). */
  static fromConfig(config: Config, fetch?: typeof globalThis.fetch): NotionClient {
    const a = config.advanced;
    return new NotionClient({
      token: config.notion.token,
      concurrency: a.concurrency,
      timeoutMs: a.timeoutMs,
      rateLimitIntervalMs: a.rateLimitIntervalMs,
      maxRetries: a.maxRetries,
      retryBaseDelayMs: a.retryBaseDelayMs,
      retryBackoffFactor: a.retryBackoffFactor,
      pageSize: a.pageSize,
      batchSize: a.batchSize,
      ...(fetch ? { fetch } : {}),
    });
  }

  getInternalClient(): Client {
    return this.client;
  }

  // ─── Page CRUD ───

  async getPage(pageId: string): Promise<PageObjectResponse> {
    return this.withRateLimit(
      () => this.client.pages.retrieve({ page_id: pageId }) as Promise<PageObjectResponse>,
    );
  }

  async createPage(params: {
    parentId: string;
    parentType: "page" | "database";
    title: string;
    properties?: Record<string, unknown>;
    children?: BlockObjectResponse[];
  }): Promise<PageObjectResponse> {
    const parent =
      params.parentType === "database"
        ? { database_id: params.parentId }
        : { page_id: params.parentId };

    const properties =
      params.parentType === "page"
        ? { title: { title: [{ text: { content: params.title } }] } }
        : ((params.properties as never) ?? {
            title: { title: [{ text: { content: params.title } }] },
          });

    return this.withRateLimit(
      () =>
        this.client.pages.create({
          parent,
          properties: properties as never,
          children: params.children as never,
        }) as Promise<PageObjectResponse>,
    );
  }

  async createPageWithMarkdown(params: {
    parentId: string;
    parentType: "page" | "database";
    title: string;
    markdown: string;
    properties?: Record<string, unknown>;
  }): Promise<PageObjectResponse> {
    const parent =
      params.parentType === "database"
        ? { database_id: params.parentId }
        : { page_id: params.parentId };

    const properties =
      params.parentType === "page"
        ? { title: { title: [{ text: { content: params.title } }] } }
        : ((params.properties as never) ?? {
            title: { title: [{ text: { content: params.title } }] },
          });

    return this.withRateLimit(
      () =>
        this.client.pages.create({
          parent,
          properties: properties as never,
          markdown: params.markdown,
        }) as Promise<PageObjectResponse>,
    );
  }

  async updatePageProperties(
    pageId: string,
    properties: Record<string, unknown>,
  ): Promise<PageObjectResponse> {
    return this.withRateLimit(
      () =>
        this.client.pages.update({
          page_id: pageId,
          properties: properties as never,
        }) as Promise<PageObjectResponse>,
    );
  }

  // ─── Markdown API ───

  async getPageMarkdown(pageId: string): Promise<PageMarkdownResponse> {
    return this.withRateLimit(() => this.client.pages.retrieveMarkdown({ page_id: pageId }));
  }

  async replacePageMarkdown(pageId: string, markdown: string): Promise<PageMarkdownResponse> {
    return this.withRateLimit(() =>
      this.client.pages.updateMarkdown({
        page_id: pageId,
        type: "replace_content",
        replace_content: {
          new_str: markdown,
          allow_deleting_content: true,
        },
      }),
    );
  }

  async updatePageMarkdownPartial(
    pageId: string,
    patches: Array<{ oldStr: string; newStr: string; replaceAll?: boolean }>,
  ): Promise<PageMarkdownResponse> {
    return this.withRateLimit(() =>
      this.client.pages.updateMarkdown({
        page_id: pageId,
        type: "update_content",
        update_content: {
          content_updates: patches.map((p) => ({
            old_str: p.oldStr,
            new_str: p.newStr,
            replace_all_matches: p.replaceAll ?? false,
          })),
          allow_deleting_content: true,
        },
      }),
    );
  }

  // ─── Page Move ───

  async movePage(
    pageId: string,
    newParentId: string,
    newParentType: "page" | "database",
  ): Promise<PageObjectResponse> {
    const parent =
      newParentType === "database" ? { database_id: newParentId } : { page_id: newParentId };
    return this.withRateLimit(
      () =>
        this.client.pages.update({
          page_id: pageId,
          parent,
        } as never) as Promise<PageObjectResponse>,
    );
  }

  // ─── Database / DataSource ───

  private async fetchDatabaseLegacy(databaseId: string): Promise<Record<string, unknown>> {
    const cleanId = databaseId.replace(/-/g, "");
    const formatted = `${cleanId.slice(0, 8)}-${cleanId.slice(8, 12)}-${cleanId.slice(12, 16)}-${cleanId.slice(16, 20)}-${cleanId.slice(20)}`;
    const resp = await this.withRateLimit(async () => {
      const doFetch = this.customFetch ?? globalThis.fetch;
      const r = await doFetch(`https://api.notion.com/v1/databases/${formatted}`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
      });
      if (!r.ok) throw new Error(`Database fetch failed: ${r.status}`);
      return (await r.json()) as Record<string, unknown>;
    });
    return resp;
  }

  async getDatabaseTitle(databaseId: string): Promise<string> {
    const db = await this.fetchDatabaseLegacy(databaseId);
    const titleArr = db.title as Array<{ plain_text: string }> | undefined;
    return titleArr?.[0]?.plain_text ?? "";
  }

  async getDatabaseSchema(
    databaseId: string,
  ): Promise<Record<string, { id: string; type: string }>> {
    const db = await this.fetchDatabaseLegacy(databaseId);
    const properties = db.properties as Record<string, { id: string; type: string }> | undefined;
    if (!properties) return {};
    const schema: Record<string, { id: string; type: string }> = {};
    for (const [name, prop] of Object.entries(properties)) {
      schema[name] = { id: prop.id, type: prop.type };
    }
    return schema;
  }

  async getDatabaseSchemaFull(databaseId: string): Promise<
    Record<
      string,
      {
        id: string;
        type: string;
        options?: Array<{ name: string; color?: string }>;
        groups?: Array<{ name: string; color?: string; optionIds?: string[] }>;
      }
    >
  > {
    const db = await this.fetchDatabaseLegacy(databaseId);
    const properties = db.properties as Record<string, Record<string, unknown>> | undefined;
    if (!properties) return {};

    const schema: Record<
      string,
      {
        id: string;
        type: string;
        options?: Array<{ name: string; color?: string }>;
        groups?: Array<{ name: string; color?: string; optionIds?: string[] }>;
      }
    > = {};

    for (const [name, prop] of Object.entries(properties)) {
      const entry: {
        id: string;
        type: string;
        options?: Array<{ name: string; color?: string }>;
        groups?: Array<{ name: string; color?: string; optionIds?: string[] }>;
      } = {
        id: prop.id as string,
        type: prop.type as string,
      };

      if (prop.type === "select" || prop.type === "multi_select") {
        const typeData = prop[prop.type as string] as
          | {
              options?: Array<{ name: string; color?: string }>;
            }
          | undefined;
        if (typeData?.options) {
          entry.options = typeData.options.map((o) => ({ name: o.name, color: o.color }));
        }
      }

      if (prop.type === "status") {
        const statusData = prop.status as
          | {
              options?: Array<{ name: string; color?: string }>;
              groups?: Array<{ name: string; color?: string; option_ids?: string[] }>;
            }
          | undefined;
        if (statusData?.options) {
          entry.options = statusData.options.map((o) => ({ name: o.name, color: o.color }));
        }
        if (statusData?.groups) {
          entry.groups = statusData.groups.map((g) => ({
            name: g.name,
            color: g.color,
            optionIds: g.option_ids,
          }));
        }
      }

      schema[name] = entry;
    }

    return schema;
  }

  async queryDatabase(
    databaseId: string,
    options?: { startCursor?: string; pageSize?: number; filter?: unknown },
  ): Promise<{ results: PageObjectResponse[]; nextCursor: string | null }> {
    const dsId = await this.getDataSourceId(databaseId);
    const response = await this.withRateLimit(() =>
      this.client.dataSources.query({
        data_source_id: dsId,
        start_cursor: options?.startCursor,
        page_size: options?.pageSize ?? this.defaultPageSize,
        filter: options?.filter as never,
      }),
    );
    return {
      results: response.results as PageObjectResponse[],
      nextCursor: response.next_cursor,
    };
  }

  async queryAllDatabasePages(databaseId: string, filter?: unknown): Promise<PageObjectResponse[]> {
    const all: PageObjectResponse[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.queryDatabase(databaseId, {
        startCursor: cursor,
        pageSize: this.defaultPageSize,
        filter,
      });
      all.push(...response.results);
      cursor = response.nextCursor ?? undefined;
    } while (cursor);

    return all;
  }

  async getDataSourceId(databaseId: string): Promise<string> {
    const db = await this.withRateLimit(() =>
      this.client.databases.retrieve({ database_id: databaseId }),
    );
    const dataSources = (db as unknown as { data_sources?: Array<{ id: string }> }).data_sources;
    return dataSources?.[0]?.id ?? databaseId;
  }

  async archivePage(pageId: string): Promise<void> {
    await this.withRateLimit(() => this.client.pages.update({ page_id: pageId, archived: true }));
  }

  async getFileBlockUrl(blockId: string): Promise<string | null> {
    try {
      const block = await this.withRateLimit(() =>
        this.client.blocks.retrieve({ block_id: blockId }),
      );
      const b = block as unknown as {
        type: string;
        file?: { file?: { url: string }; external?: { url: string } };
        pdf?: { file?: { url: string }; external?: { url: string } };
        video?: { file?: { url: string }; external?: { url: string } };
        audio?: { file?: { url: string }; external?: { url: string } };
        image?: { file?: { url: string }; external?: { url: string } };
      };
      const media = b.file ?? b.pdf ?? b.video ?? b.audio ?? b.image;
      return media?.file?.url ?? media?.external?.url ?? null;
    } catch {
      return null;
    }
  }

  async getBlock(blockId: string): Promise<BlockObjectResponse> {
    return this.withRateLimit(() =>
      this.client.blocks.retrieve({ block_id: blockId }),
    ) as Promise<BlockObjectResponse>;
  }

  // ─── Block CRUD ───

  async listChildren(
    blockId: string,
    options?: { startCursor?: string; pageSize?: number },
  ): Promise<{
    results: (BlockObjectResponse | PartialBlockObjectResponse)[];
    nextCursor: string | null;
  }> {
    const response = await this.withRateLimit(() =>
      this.client.blocks.children.list({
        block_id: blockId,
        start_cursor: options?.startCursor,
        page_size: options?.pageSize ?? this.defaultPageSize,
      }),
    );
    return {
      results: response.results,
      nextCursor: response.next_cursor,
    };
  }

  async fetchAllChildren(blockId: string): Promise<BlockObjectResponse[]> {
    const blocks: BlockObjectResponse[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.listChildren(blockId, { startCursor: cursor });
      blocks.push(...response.results.filter((b): b is BlockObjectResponse => "type" in b));
      cursor = response.nextCursor ?? undefined;
    } while (cursor);

    return blocks;
  }

  private static readonly CONTAINER_BLOCK_TYPES = new Set([
    "column_list",
    "column",
    "callout",
    "toggle",
    "quote",
  ]);

  async fetchAllChildrenDeep(blockId: string): Promise<BlockObjectResponse[]> {
    const directChildren = await this.fetchAllChildren(blockId);
    const allBlocks: BlockObjectResponse[] = [...directChildren];

    const toExpand = directChildren.filter((b) => {
      if (!b.has_children) return false;
      if (b.type === "child_page" || b.type === "child_database") return false;
      if (NotionClient.CONTAINER_BLOCK_TYPES.has(b.type)) return true;
      if (b.type === "synced_block") {
        const sb = b as unknown as { synced_block: { synced_from: { block_id: string } | null } };
        return sb.synced_block?.synced_from === null;
      }
      return true;
    });

    for (const container of toExpand) {
      try {
        const nested = await this.fetchAllChildrenDeep(container.id);
        allBlocks.push(...nested);
      } catch {
        // 접근 권한 없는 블록 무시
      }
    }

    return allBlocks;
  }

  async appendChildren(blockId: string, children: unknown[]): Promise<void> {
    const batchSize = this.batchSize;
    for (let i = 0; i < children.length; i += batchSize) {
      const batch = children.slice(i, i + batchSize);
      await this.withRateLimit(() =>
        this.client.blocks.children.append({
          block_id: blockId,
          children: batch as never,
        }),
      );
    }
  }

  async deleteBlock(blockId: string): Promise<void> {
    await this.withRateLimit(() => this.client.blocks.delete({ block_id: blockId }));
  }

  // ─── File Upload ───

  async uploadFile(fileData: Blob, filename: string, contentType: string): Promise<string> {
    const upload = await this.withRateLimit(() =>
      this.client.fileUploads.create({ filename, content_type: contentType }),
    );

    const fileUploadId = (upload as unknown as { id: string }).id;

    const sendResult = await this.withRateLimit(() =>
      this.client.fileUploads.send({
        file_upload_id: fileUploadId,
        file: { data: fileData, filename },
      }),
    );

    const status = (sendResult as unknown as { status: string }).status;
    if (status === "pending") {
      await this.withRateLimit(() =>
        this.client.fileUploads.complete({ file_upload_id: fileUploadId }),
      );
    }

    return fileUploadId;
  }

  // ─── Search & Navigation ───

  async search(params: {
    query?: string;
    filter?: { property: "object"; value: "page" | "data_source" };
    startCursor?: string;
    pageSize?: number;
  }): Promise<{ results: PageObjectResponse[]; nextCursor: string | null }> {
    const response = await this.withRateLimit(() =>
      this.client.search({
        query: params.query,
        filter: params.filter,
        start_cursor: params.startCursor,
        page_size: params.pageSize ?? this.defaultPageSize,
      }),
    );
    return {
      results: response.results as PageObjectResponse[],
      nextCursor: response.next_cursor,
    };
  }

  async searchRecentPages(since: string): Promise<Array<{ id: string; last_edited_time: string }>> {
    const results: Array<{ id: string; last_edited_time: string }> = [];
    let cursor: string | undefined;
    const sinceDate = new Date(since);

    outer: do {
      const response = await this.withRateLimit(() =>
        this.client.search({
          filter: { property: "object", value: "page" },
          sort: { direction: "descending", timestamp: "last_edited_time" },
          start_cursor: cursor,
          page_size: this.defaultPageSize,
        }),
      );

      for (const page of response.results) {
        const p = page as PageObjectResponse;
        if (new Date(p.last_edited_time) <= sinceDate) {
          break outer;
        }
        results.push({ id: p.id, last_edited_time: p.last_edited_time });
      }

      cursor = response.next_cursor ?? undefined;
    } while (cursor);

    return results;
  }

  async getChildPages(parentId: string): Promise<PageObjectResponse[]> {
    const blocks = await this.fetchAllChildrenDeep(parentId);
    const childPageBlocks = blocks.filter((b) => b.type === "child_page");

    if (childPageBlocks.length === 0) return [];

    const pages = await Promise.all(childPageBlocks.map((b) => this.getPage(b.id)));
    return pages;
  }

  async getChildDatabaseIds(parentId: string): Promise<string[]> {
    const children = await this.fetchAllChildren(parentId);
    return children.filter((b) => b.type === "child_database").map((b) => b.id);
  }

  async getChildPagesRecursive(parentId: string): Promise<PageObjectResponse[]> {
    const all: PageObjectResponse[] = [];
    let currentLevel: string[] = [parentId];

    while (currentLevel.length > 0) {
      const nextLevel: string[] = [];

      for (const id of currentLevel) {
        const children = await this.getChildPages(id);
        for (const child of children) {
          all.push(child);
          nextLevel.push(child.id);
        }
      }

      currentLevel = nextLevel;
    }

    return all;
  }

  // ─── Views API ───

  async listDatabaseViews(databaseId: string): Promise<ViewConfig[]> {
    const allViews: ViewConfig[] = [];
    let cursor: string | undefined;

    do {
      const response = await this.withRateLimit(() =>
        this.client.views.list({
          database_id: databaseId,
          start_cursor: cursor,
          page_size: this.defaultPageSize,
        }),
      );

      const viewRefs = (response as ListDatabaseViewsResponse).results;
      for (const ref of viewRefs) {
        try {
          const detail = await this.getView(ref.id as string);
          if (detail) allViews.push(detail);
        } catch {
          // 뷰 상세 조회 실패 시 스킵
        }
      }

      cursor = (response as ListDatabaseViewsResponse).next_cursor as string | undefined;
    } while (cursor);

    return allViews;
  }

  async getView(viewId: string): Promise<ViewConfig | null> {
    const view = await this.withRateLimit(() => this.client.views.retrieve({ view_id: viewId }));

    const v = view as DataSourceViewObjectResponse;
    if (!v.type) return null;

    return parseViewResponse(v);
  }

  async getDatabaseViewsConfig(databaseId: string): Promise<DatabaseViewsConfig> {
    const views = await this.listDatabaseViews(databaseId);
    return {
      databaseId,
      lastSynced: new Date().toISOString(),
      views,
    };
  }

  // ─── Cover / Icon Extraction ───

  extractCover(page: PageObjectResponse): PageCover | null {
    const raw = page as unknown as {
      cover?: {
        type: string;
        file?: { url: string; expiry_time?: string };
        external?: { url: string };
      };
    };
    if (!raw.cover) return null;

    if (raw.cover.type === "file" && raw.cover.file) {
      return {
        type: "file",
        url: raw.cover.file.url,
        expiryTime: raw.cover.file.expiry_time,
      };
    }
    if (raw.cover.type === "external" && raw.cover.external) {
      return { type: "external", url: raw.cover.external.url };
    }
    return null;
  }

  extractIcon(page: PageObjectResponse): PageIcon | null {
    const raw = page as unknown as {
      icon?: {
        type: string;
        emoji?: string;
        external?: { url: string };
        file?: { url: string; expiry_time?: string };
        icon?: { name: string; color?: string };
      };
    };
    if (!raw.icon) return null;

    switch (raw.icon.type) {
      case "emoji":
        return { type: "emoji", value: raw.icon.emoji! };
      case "external":
        return { type: "external", value: raw.icon.external!.url };
      case "file":
        return { type: "file", value: raw.icon.file!.url };
      case "icon":
        return { type: "icon", value: raw.icon.icon!.name, color: raw.icon.icon!.color };
      default:
        return null;
    }
  }

  // ─── Property Extraction ───

  extractTitle(page: PageObjectResponse): string {
    const props = page.properties as Record<
      string,
      { type: string; title?: Array<{ plain_text?: string }> }
    >;
    for (const prop of Object.values(props)) {
      if (prop.type === "title" && prop.title) {
        const joined = prop.title.map((t) => t.plain_text ?? "").join("");
        if (joined) return joined;
      }
    }
    return "제목 없음";
  }

  extractProperties(page: PageObjectResponse): Record<string, unknown> {
    return this.propertyMapper.fromNotionProperties(page.properties as Record<string, unknown>);
  }

  // ─── Internal ───

  private lastRequestTime = 0;

  private async withRateLimit<T>(fn: () => Promise<T>): Promise<T> {
    await this.sema.acquire();
    try {
      const now = Date.now();
      const elapsed = now - this.lastRequestTime;
      if (elapsed < this.minRequestInterval) {
        await sleep(this.minRequestInterval - elapsed);
      }
      this.lastRequestTime = Date.now();
      return await this.executeWithRetry(fn);
    } finally {
      this.sema.release();
    }
  }

  private async executeWithRetry<T>(fn: () => Promise<T>, attempt: number = 0): Promise<T> {
    try {
      return await fn();
    } catch (error: unknown) {
      if (isRetryable(error) && attempt < this.maxRetries) {
        const baseDelay =
          extractRetryAfter(error) ??
          this.retryBaseDelayMs * Math.pow(this.retryBackoffFactor, attempt);
        const jitter = baseDelay * (0.5 + Math.random() * 0.5);
        await sleep(jitter);
        return this.executeWithRetry(fn, attempt + 1);
      }
      throw error;
    }
  }
}

function isRetryable(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: string }).code;
  if (code === "notionhq_client_request_timeout" || code === "ECONNRESET" || code === "ETIMEDOUT") {
    return true;
  }
  if (!("status" in error)) return false;
  const status = (error as { status: number }).status;
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function extractRetryAfter(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "headers" in error) {
    const headers = (error as { headers: Record<string, string> }).headers;
    const retryAfter = headers?.["retry-after"];
    if (retryAfter) return Number(retryAfter) * 1000;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseViewResponse(v: DataSourceViewObjectResponse): ViewConfig {
  const config: ViewConfig = {
    id: v.id as string,
    name: v.name,
    type: v.type,
    dataSourceId: v.data_source_id,
    filter: v.filter,
    sorts: v.sorts?.map((s) => {
      if ("property" in s) {
        return { property: s.property, direction: s.direction };
      }
      return { timestamp: s.timestamp, direction: s.direction };
    }),
    ...extractViewTypeConfig(v.configuration),
  };
  return config;
}

type MutableViewConfig = {
  -readonly [K in keyof ViewConfig]: ViewConfig[K];
};

function extractViewTypeConfig(
  cfg: DataSourceViewObjectResponse["configuration"],
): Partial<MutableViewConfig> {
  if (!cfg) return {};

  const result: Partial<MutableViewConfig> = {};

  if ("properties" in cfg && cfg.properties) {
    result.properties = cfg.properties.map((p) => ({
      propertyId: p.property_id,
      propertyName: p.property_name,
      visible: p.visible,
      width: p.width,
      wrap: p.wrap,
    }));
  }

  if ("group_by" in cfg && cfg.group_by) {
    const gb = cfg.group_by;
    result.groupBy = {
      type: gb.type,
      propertyId: gb.property_id,
      propertyName: "property_name" in gb ? (gb.property_name as string) : undefined,
      sort:
        "sort" in gb && gb.sort
          ? ((gb.sort as { type: string }).type as "manual" | "ascending" | "descending")
          : undefined,
      hideEmptyGroups: "hide_empty_groups" in gb ? (gb.hide_empty_groups as boolean) : undefined,
    };
  }

  if ("cover" in cfg && cfg.cover) {
    result.cover = {
      type: cfg.cover.type,
      propertyId: cfg.cover.property_id,
    };
  }

  if ("cover_size" in cfg) result.coverSize = cfg.cover_size;
  if ("cover_aspect" in cfg) result.coverAspect = cfg.cover_aspect;

  if ("date_property_id" in cfg) {
    result.datePropertyId = cfg.date_property_id;
    result.datePropertyName = cfg.date_property_name;
  }

  if ("view_range" in cfg) result.viewRange = cfg.view_range;

  return result;
}
