import { Client } from "@notionhq/client";
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

export interface NotionClientOptions {
  readonly token: string;
  readonly concurrency?: number;
  readonly timeoutMs?: number;
}

export class NotionClient {
  private readonly client: Client;
  private readonly sema: Sema;
  private readonly propertyMapper = new PropertyMapper();

  constructor(options: NotionClientOptions) {
    this.client = new Client({
      auth: options.token,
      timeoutMs: options.timeoutMs ?? 30000,
    });
    this.sema = new Sema(options.concurrency ?? 3);
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

  async getDatabaseSchema(
    databaseId: string,
  ): Promise<Record<string, { id: string; type: string }>> {
    const db = await this.withRateLimit(() =>
      this.client.databases.retrieve({ database_id: databaseId }),
    );
    const properties = (
      db as unknown as { properties: Record<string, { id: string; type: string }> }
    ).properties;
    const schema: Record<string, { id: string; type: string }> = {};
    for (const [name, prop] of Object.entries(properties)) {
      schema[name] = { id: prop.id, type: prop.type };
    }
    return schema;
  }

  async queryDatabase(
    databaseId: string,
    options?: { startCursor?: string; pageSize?: number; filter?: unknown },
  ): Promise<{ results: PageObjectResponse[]; nextCursor: string | null }> {
    const response = await this.withRateLimit(() =>
      this.client.dataSources.query({
        data_source_id: databaseId,
        start_cursor: options?.startCursor,
        page_size: options?.pageSize ?? 100,
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
        pageSize: 100,
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
        page_size: options?.pageSize ?? 100,
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

  async appendChildren(blockId: string, children: unknown[]): Promise<void> {
    const BATCH_SIZE = 100;
    for (let i = 0; i < children.length; i += BATCH_SIZE) {
      const batch = children.slice(i, i + BATCH_SIZE);
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
        page_size: params.pageSize ?? 100,
      }),
    );
    return {
      results: response.results as PageObjectResponse[],
      nextCursor: response.next_cursor,
    };
  }

  async getChildPages(parentId: string): Promise<PageObjectResponse[]> {
    const blocks = await this.fetchAllChildren(parentId);
    const childPageBlocks = blocks.filter((b) => b.type === "child_page");

    if (childPageBlocks.length === 0) return [];

    const pages = await Promise.all(childPageBlocks.map((b) => this.getPage(b.id)));
    return pages;
  }

  async getChildPagesRecursive(parentId: string): Promise<PageObjectResponse[]> {
    const all: PageObjectResponse[] = [];
    let currentLevel: string[] = [parentId];

    while (currentLevel.length > 0) {
      const childArrays = await Promise.all(currentLevel.map((id) => this.getChildPages(id)));
      const nextLevel: string[] = [];

      for (const children of childArrays) {
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
          page_size: 100,
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

  private async withRateLimit<T>(fn: () => Promise<T>): Promise<T> {
    await this.sema.acquire();
    try {
      return await this.executeWithRetry(fn);
    } finally {
      this.sema.release();
    }
  }

  private async executeWithRetry<T>(fn: () => Promise<T>, attempt: number = 0): Promise<T> {
    try {
      return await fn();
    } catch (error: unknown) {
      if (isRetryable(error) && attempt < 5) {
        const baseDelay = extractRetryAfter(error) ?? 1000 * Math.pow(2, attempt);
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
