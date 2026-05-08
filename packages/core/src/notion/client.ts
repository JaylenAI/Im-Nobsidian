import { Client } from "@notionhq/client";
import { Sema } from "async-sema";
import type {
  BlockObjectResponse,
  PageObjectResponse,
  PartialBlockObjectResponse,
} from "@notionhq/client/build/src/api-endpoints.js";

export interface NotionClientOptions {
  readonly token: string;
  readonly concurrency?: number;
  readonly timeoutMs?: number;
}

export class NotionClient {
  private readonly client: Client;
  private readonly sema: Sema;

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

    return this.withRateLimit(
      () =>
        this.client.pages.create({
          parent,
          properties: (params.properties as never) ?? {
            title: { title: [{ text: { content: params.title } }] },
          },
          children: params.children as never,
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

  async archivePage(pageId: string): Promise<void> {
    await this.withRateLimit(() => this.client.pages.update({ page_id: pageId, archived: true }));
  }

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

  async search(params: {
    query?: string;
    filter?: { property: "object"; value: "page" | "database" };
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

  extractTitle(page: PageObjectResponse): string {
    for (const prop of Object.values(page.properties)) {
      if (prop.type === "title" && "title" in prop) {
        const titleArr = prop.title as Array<{ plain_text?: string }>;
        if (titleArr[0]?.plain_text) return titleArr[0].plain_text;
      }
    }
    return "제목 없음";
  }

  extractProperties(page: PageObjectResponse): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(page.properties)) {
      if (key === "title") continue;
      result[key] = this.extractPropertyValue(prop);
    }
    return result;
  }

  private extractPropertyValue(prop: { type: string } & Record<string, unknown>): unknown {
    switch (prop.type) {
      case "rich_text": {
        const arr = prop.rich_text as Array<{ plain_text: string }>;
        return arr.map((t) => t.plain_text).join("");
      }
      case "number":
        return prop.number;
      case "select":
        return (prop.select as { name: string } | null)?.name ?? null;
      case "multi_select":
        return (prop.multi_select as Array<{ name: string }>).map((s) => s.name);
      case "checkbox":
        return prop.checkbox;
      case "date":
        return prop.date;
      case "url":
        return prop.url;
      case "email":
        return prop.email;
      case "phone_number":
        return prop.phone_number;
      default:
        return null;
    }
  }

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
      if (isRateLimited(error) && attempt < 5) {
        const retryAfter = extractRetryAfter(error) ?? 1000 * Math.pow(2, attempt);
        await sleep(retryAfter);
        return this.executeWithRetry(fn, attempt + 1);
      }
      throw error;
    }
  }
}

function isRateLimited(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: number }).status === 429
  );
}

function extractRetryAfter(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "headers" in error) {
    const headers = (error as { headers: Record<string, string> }).headers;
    const retryAfter = headers["retry-after"];
    if (retryAfter) return Number(retryAfter) * 1000;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
