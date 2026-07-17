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
import { PropertyMapper, type WikilinkResolver } from "./property-mapper.js";
import type { ViewConfig, DatabaseViewsConfig, PageCover, PageIcon } from "../types/view.js";
import type { Config } from "../types/config.js";
import { getLogger } from "../utils/logger.js";
import { normalizeNotionId } from "../utils/id.js";

/**
 * Notion SDK 의 404(`object_not_found`) 판별 — 링크드 DB·미공유 데이터 소스·삭제된
 * 페이지/DB 의 **권위적 신호**다. 그래야 일시적/실제 오류(검증·rate limit·5xx)와 구분해
 * 행 동기화 불가를 정직히 강등(스택트레이스 대신 1줄 + denylist)할 수 있다.
 * SDK 의 `APIResponseError` 는 `code`/`status` 를 노출한다.
 */
export function isNotionObjectNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; status?: unknown };
  return e.code === "object_not_found" || e.status === 404;
}

/**
 * 서브트리 직접 순회(getChildPagesRecursive) 비용이 시간 예산을 초과했을 때 던지는 신호.
 * 순회 비용은 **서브트리 전체 블록 수**에 비례(중첩 페이지 무손실 탐색을 위해 모든 블록을
 * 깊이 순회)하므로, 콘텐츠가 많은 대규모 서브트리에서는 워크스페이스 search 기반 디스커버리
 * (비용이 워크스페이스 페이지 수에 비례·예측가능)가 더 저렴하다. 이 오류를 받은 호출측은
 * search 기반 폴백(getPagesUnderRootViaSearch)으로 전환한다. 작은 볼트는 예산 안에서
 * 순회가 끝나 폴백 없이 빠르게 완료된다(이중 전략의 분기점).
 */
export class DiscoveryTooLargeError extends Error {
  constructor(elapsedMs: number) {
    super(`subtree discovery exceeded time budget (${elapsedMs}ms)`);
    this.name = "DiscoveryTooLargeError";
  }
}

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
  private readonly propertyMapper = new PropertyMapper();

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

  /**
   * 데이터베이스 1개를 신 모델(2025-09-03 data source 분리)로 조회한다.
   * - title: database 객체에 그대로 존재한다.
   * - properties(스키마): 신 모델에선 data source 에 있으므로 1차 data source 를 조회해 채운다.
   *   data source 접근 불가(링크드 DB 등)면 database 객체의 properties 로 폴백한다(제목은 보존).
   *
   * 폐기한 레거시 raw fetch(`GET /v1/databases/{id}`, Notion-Version 2022-06-28)는 신 모델로
   * 업그레이드된 다수 DB에 400 을 반환해 자동 발견 DB 가 통째 드롭(내용 손실)되던 원인이었다.
   * SDK(`databases.retrieve`/`dataSources.retrieve`)는 동일 토큰으로 정상 동작한다.
   */
  private async fetchDatabaseModern(databaseId: string): Promise<Record<string, unknown>> {
    const db = (await this.withRateLimit(() =>
      this.client.databases.retrieve({ database_id: databaseId }),
    )) as unknown as {
      title?: unknown;
      properties?: Record<string, unknown>;
      data_sources?: Array<{ id: string; name?: string }>;
    };

    // 신 모델(2025-09-03): 한 database 가 2개 이상의 data source 를 가질 수 있고, 각 data
    // source 가 자체 스키마(properties)를 갖는다. 1차 data source 만 읽으면 2번째+ 의 컬럼이
    // 침묵 유실되므로 접근 가능한 전 data source 의 properties 를 union 병합한다(이름 충돌은
    // 첫 정의 우선 — 동일 컬럼이 여러 소스에 중복돼도 안정적). 어떤 data source 도 접근
    // 불가하면 database 객체의 properties 로 폴백(제목은 이미 확보).
    const dataSources = db.data_sources ?? [];
    const merged: Record<string, unknown> = {};
    let anyAccessible = false;
    for (const ds of dataSources) {
      try {
        const dsObj = (await this.withRateLimit(() =>
          this.client.dataSources.retrieve({ data_source_id: ds.id }),
        )) as unknown as { properties?: Record<string, unknown> };
        if (dsObj.properties && Object.keys(dsObj.properties).length > 0) {
          anyAccessible = true;
          for (const [name, prop] of Object.entries(dsObj.properties)) {
            if (!(name in merged)) merged[name] = prop;
          }
        }
      } catch {
        // 접근 불가 data source 건너뜀 — 나머지 소스로 계속.
      }
    }

    const properties: Record<string, unknown> = anyAccessible ? merged : (db.properties ?? {});
    return { title: db.title, properties };
  }

  async getDatabaseTitle(databaseId: string): Promise<string> {
    const db = await this.fetchDatabaseModern(databaseId);
    const titleArr = db.title as Array<{ plain_text: string }> | undefined;
    return titleArr?.[0]?.plain_text ?? "";
  }

  /**
   * 발견된 DB 가 **동기화 가능한지**(접근 가능한 data source 가 있는지) 판별한다.
   * 신 모델(2025-09-03)에서 링크드 DB·미공유 데이터 소스·삭제 DB 는 `data_sources` 가
   * 비어, 행 조회(`dataSources.query`)가 404 로 실패하고 그 전에 생성된 빈 폴더/`.base` 만
   * 남긴다. 발견 단계에서 미리 걸러 **빈 폴더/.base 오염 + 매 pull 의 404 노이즈**를 차단한다.
   * 제목은 함께 반환해 호출처가 추가 조회 없이 폴더명을 잡게 한다.
   *
   * F25: 원본이 같은 공유 범위에 있으면 linked view 컨테이너도 `data_sources` 가 **채워져**
   * 온다(실측 — 워크스페이스 8건). 이때 data source 의 parent database 는 원본이므로,
   * 첫 소스의 parent 가 자신이 아니면 `linkedOriginalDbId` 로 알려 컨테이너가 원본과 같은
   * 행 집합을 이중 pull(폴더 릴레이 재배치 churn)하는 것을 발견 단계에서 차단한다.
   */
  async getDatabaseSyncability(
    databaseId: string,
  ): Promise<{ title: string; queryable: boolean; linkedOriginalDbId?: string }> {
    const db = (await this.withRateLimit(() =>
      this.client.databases.retrieve({ database_id: databaseId }),
    )) as unknown as {
      title?: Array<{ plain_text: string }>;
      data_sources?: Array<{ id: string }>;
    };
    const title = Array.isArray(db.title) ? (db.title[0]?.plain_text ?? "") : "";
    const firstDsId = db.data_sources?.[0]?.id;
    if (!firstDsId) return { title, queryable: false };

    try {
      const ds = (await this.withRateLimit(() =>
        this.client.dataSources.retrieve({ data_source_id: firstDsId }),
      )) as unknown as { parent?: { type?: string; database_id?: string } };
      const ownerDbId = ds.parent?.database_id;
      if (ownerDbId && normalizeNotionId(ownerDbId) !== normalizeNotionId(databaseId)) {
        return { title, queryable: true, linkedOriginalDbId: ownerDbId };
      }
    } catch {
      // 소유 판정 실패는 기존 동작(원본 취급) 유지 — 일시 오류로 컨테이너를 오강등하지 않는다.
    }
    return { title, queryable: true };
  }

  /**
   * linked database view 컨테이너를 원본 DB 로 해소한다.
   * 컨테이너 자체는 `data_sources` 가 비어 행 조회가 불가능하지만(getDatabaseSyncability
   * queryable=false), Views API 의 뷰 상세에는 원본 `data_source_id` 가 실리고 그 data source
   * 의 parent 가 원본 database 다. 해소 실패(뷰 없음/권한 없음/자기참조)는 null — 호출처가
   * 기존대로 접근 불가 처리한다.
   */
  async resolveLinkedDatabase(
    databaseId: string,
  ): Promise<{ originalDbId: string; viewName: string } | null> {
    try {
      const views = await this.listDatabaseViews(databaseId);
      for (const view of views) {
        if (!view.dataSourceId) continue;
        const ds = (await this.withRateLimit(() =>
          this.client.dataSources.retrieve({ data_source_id: view.dataSourceId as string }),
        )) as unknown as { parent?: { type?: string; database_id?: string } };
        const originalDbId = ds.parent?.database_id;
        if (!originalDbId) continue;
        // 자기 자신을 가리키면 linked 가 아니라 원본이 정말 소스 없는 상태 — 해소 불가.
        if (originalDbId.replace(/-/g, "") === databaseId.replace(/-/g, "")) continue;
        return { originalDbId, viewName: view.name ?? "" };
      }
      return null;
    } catch {
      return null;
    }
  }

  async getDatabaseSchema(
    databaseId: string,
  ): Promise<Record<string, { id: string; type: string }>> {
    const db = await this.fetchDatabaseModern(databaseId);
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
    const db = await this.fetchDatabaseModern(databaseId);
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

  /** 특정 data source 1개를 직접 쿼리한다(저수준). 다중 data source 순회의 빌딩블록. */
  private async queryDataSource(
    dataSourceId: string,
    options?: { startCursor?: string; pageSize?: number; filter?: unknown },
  ): Promise<{ results: PageObjectResponse[]; nextCursor: string | null }> {
    const response = await this.withRateLimit(() =>
      this.client.dataSources.query({
        data_source_id: dataSourceId,
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

  /**
   * database 의 1차 data source 1페이지를 쿼리한다(증분 detect 등 단일 소스 경로용).
   * 전 행을 빠짐없이 받으려면 {@link queryAllDatabasePages} 를 쓴다(전 data source 순회).
   */
  async queryDatabase(
    databaseId: string,
    options?: { startCursor?: string; pageSize?: number; filter?: unknown },
  ): Promise<{ results: PageObjectResponse[]; nextCursor: string | null }> {
    const dsId = await this.getDataSourceId(databaseId);
    return this.queryDataSource(dsId, options);
  }

  /**
   * database 의 **모든 data source** 행을 빠짐없이 조회한다(2025-09-03 신 모델).
   * 한 database 가 2개 이상의 data source(각자 행 집합)를 가질 수 있어, 1차 data source 만
   * 페이지네이션하면 2번째+ 의 행이 통째 침묵 유실된다. 전 data source 를 순회·페이지네이션
   * 하고 page_id 로 디듀프(소스 간 동일 페이지 방어)한 뒤 합친다. 다중 소스면 1회 경고해
   * "소스별 탭 구분이 한 폴더로 병합"되는 점을 비침묵으로 알린다.
   */
  async queryAllDatabasePages(databaseId: string, filter?: unknown): Promise<PageObjectResponse[]> {
    const metas = await this.getDataSourceMetas(databaseId);
    if (metas.length > 1) {
      const label = metas.map((m) => m.name || m.id).join(", ");
      getLogger().warn(
        `[Notion] DB ${databaseId} 에 data source ${metas.length}개 발견 — 전 소스 행을 한 폴더로 병합 동기화합니다 (${label}). 소스별 탭 구분은 .base 뷰에 보존되지 않습니다.`,
      );
    }

    const all: PageObjectResponse[] = [];
    const seen = new Set<string>();
    for (const meta of metas) {
      let cursor: string | undefined;
      do {
        const response = await this.queryDataSource(meta.id, {
          startCursor: cursor,
          pageSize: this.defaultPageSize,
          filter,
        });
        for (const page of response.results) {
          const key = normalizeNotionId(page.id);
          if (seen.has(key)) continue;
          seen.add(key);
          all.push(page);
        }
        cursor = response.nextCursor ?? undefined;
      } while (cursor);
    }

    return all;
  }

  /** database 의 1차 data source id(없으면 databaseId 폴백). 단일 소스 경로 호환용. */
  async getDataSourceId(databaseId: string): Promise<string> {
    const metas = await this.getDataSourceMetas(databaseId);
    return metas[0]?.id ?? databaseId;
  }

  /**
   * database 의 전 data source 메타(id + 이름)를 반환한다. data source 가 없으면(레거시/단일)
   * databaseId 자체를 단일 소스로 폴백해 호출처가 항상 ≥1 개를 받게 한다.
   */
  async getDataSourceMetas(databaseId: string): Promise<Array<{ id: string; name: string }>> {
    const db = (await this.withRateLimit(() =>
      this.client.databases.retrieve({ database_id: databaseId }),
    )) as unknown as { data_sources?: Array<{ id: string; name?: string }> };
    const list = db.data_sources ?? [];
    if (list.length === 0) return [{ id: databaseId, name: "" }];
    return list.map((ds) => ({ id: ds.id, name: ds.name ?? "" }));
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

  /** single_part 업로드 상한 (Notion API 규격 20MB) */
  private static readonly SINGLE_PART_MAX_BYTES = 20 * 1024 * 1024;
  /** multi_part 파트 크기 — 규격상 마지막 파트 제외 5~20MB, 10MB 고정 사용 */
  private static readonly MULTI_PART_CHUNK_BYTES = 10 * 1024 * 1024;

  async uploadFile(fileData: Blob, filename: string, contentType: string): Promise<string> {
    // create 에 선언한 content_type 과 Blob 자체 타입이 다르면 send 가 400 으로 거부된다
    // (실측: "Current file content type ... does not match the original content type").
    // 호출자가 타입 없는 Blob 을 넘겨도 동작하도록 여기서 정합을 보장한다.
    if (fileData.type !== contentType) {
      fileData = new Blob([fileData], { type: contentType });
    }
    if (fileData.size > NotionClient.SINGLE_PART_MAX_BYTES) {
      return this.uploadFileMultiPart(fileData, filename, contentType);
    }

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

  /** 20MB 초과 파일의 multi_part 업로드 — part_number 는 API 규격상 문자열("1"부터) */
  private async uploadFileMultiPart(
    fileData: Blob,
    filename: string,
    contentType: string,
  ): Promise<string> {
    const chunkSize = NotionClient.MULTI_PART_CHUNK_BYTES;
    const numberOfParts = Math.ceil(fileData.size / chunkSize);

    const upload = await this.withRateLimit(() =>
      this.client.fileUploads.create({
        mode: "multi_part",
        number_of_parts: numberOfParts,
        filename,
        content_type: contentType,
      }),
    );

    const fileUploadId = (upload as unknown as { id: string }).id;

    for (let part = 1; part <= numberOfParts; part++) {
      const chunk = fileData.slice((part - 1) * chunkSize, part * chunkSize, contentType);
      await this.withRateLimit(() =>
        this.client.fileUploads.send({
          file_upload_id: fileUploadId,
          part_number: String(part),
          file: { data: chunk, filename },
        }),
      );
    }

    await this.withRateLimit(() =>
      this.client.fileUploads.complete({ file_upload_id: fileUploadId }),
    );

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
    // 휴지통/아카이브된 페이지 제외: 부모 블록에는 child_page 참조가 남아 있어도
    // 대상 페이지가 삭제(in_trash)·보관(archived)된 경우 블록 조회 시 object_not_found가
    // 발생하므로 동기화 대상에서 사전 제거한다. (재귀 스캔의 무한·실패 전파 차단)
    return pages.filter((p) => !NotionClient.isTrashedOrArchived(p));
  }

  /** 페이지가 휴지통(in_trash)이거나 보관(archived) 상태인지 판정한다. */
  private static isTrashedOrArchived(page: PageObjectResponse): boolean {
    // in_trash는 런타임 응답에는 존재하나 SDK 타입에 미선언 → 안전 캐스트로 접근
    const inTrash = (page as { in_trash?: boolean }).in_trash === true;
    return inTrash || page.archived === true;
  }

  async getChildDatabaseIds(parentId: string): Promise<string[]> {
    const children = await this.fetchAllChildren(parentId);
    return children.filter((b) => b.type === "child_database").map((b) => b.id);
  }

  /**
   * root 서브트리를 직접 BFS 순회해 하위 페이지를 모두 수집한다(중첩 깊이 무관·무손실).
   * 비용은 서브트리 전체 블록 수에 비례한다.
   *
   * @param opts.deadlineMs `Date.now()` 기준 마감 시각. 각 페이지 처리 전 초과를 검사해
   *   초과 시 {@link DiscoveryTooLargeError}를 던진다(대규모 서브트리 → search 폴백 유도).
   *   미지정 시 무제한(기존 동작 유지 — 테스트 mock 경로는 영향 없음).
   */
  async getChildPagesRecursive(
    parentId: string,
    opts?: { deadlineMs?: number },
  ): Promise<PageObjectResponse[]> {
    const all: PageObjectResponse[] = [];
    let currentLevel: string[] = [parentId];
    const start = Date.now();

    while (currentLevel.length > 0) {
      const nextLevel: string[] = [];

      for (const id of currentLevel) {
        if (opts?.deadlineMs !== undefined && Date.now() > opts.deadlineMs) {
          throw new DiscoveryTooLargeError(Date.now() - start);
        }
        let children: PageObjectResponse[];
        try {
          children = await this.getChildPages(id);
        } catch (error) {
          // 한 서브트리가 접근 불가(공유 해제·삭제 등)여도 전체 스캔이 중단되지 않도록
          // 해당 노드만 건너뛴다. 형제·다른 가지의 페이지 손실을 방지한다.
          getLogger().warn(
            `[Im-Nobsidian] 하위 페이지 스캔 건너뜀 (${id}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }
        for (const child of children) {
          all.push(child);
          nextLevel.push(child.id);
        }
      }

      currentLevel = nextLevel;
    }

    return all;
  }

  /** 워크스페이스에서 통합에 공유된 모든 페이지를 bulk search 로 열거한다(100/요청). */
  async searchAllPages(): Promise<PageObjectResponse[]> {
    const pages: PageObjectResponse[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.search({
        filter: { property: "object", value: "page" },
        startCursor: cursor,
      });
      pages.push(...r.results);
      cursor = r.nextCursor ?? undefined;
    } while (cursor);
    return pages;
  }

  /**
   * root 하위 페이지를 **search 기반**으로 디스커버리한다(대규모 서브트리용 폴백).
   *
   * 전략: 워크스페이스 전체 페이지를 1회 bulk search 로 열거(비용 ∝ 워크스페이스 페이지 수,
   * 예측가능·유한)한 뒤, 각 페이지의 부모 체인을 따라 root 도달 여부를 판정한다. page_id
   * 부모는 메모리 맵으로 추가 호출 없이 즉시 해석하고, block_id 부모(컬럼·토글 등 레이아웃에
   * 중첩된 페이지)만 getBlock 으로 소유 페이지를 해석(memo)한다. search 는 중첩 깊이와 무관하게
   * 모든 페이지를 반환하므로 직접 순회와 동일하게 **무손실**이다.
   *
   * getChildPagesRecursive 와 동일 집합을 보장하기 위해:
   *  - DB 행(parent=data_source_id/database_id)은 child_page 로 도달 불가 → 제외
   *  - 휴지통/보관(in_trash/archived) 페이지 제외
   *  - root 자신은 제외(직접 순회도 root 의 *자식*부터 수집)
   */
  async getPagesUnderRootViaSearch(rootId: string): Promise<PageObjectResponse[]> {
    const all = await this.searchAllPages();
    const rootN = normalizeNotionId(rootId);
    const byId = new Map<string, PageObjectResponse>();
    for (const p of all) byId.set(normalizeNotionId(p.id), p);

    type Parent = {
      type: string;
      page_id?: string;
      block_id?: string;
      data_source_id?: string;
      database_id?: string;
    };

    // block_id → 소유 페이지 id(없으면 null). 같은 블록 재해석을 막는 memo.
    const blockOwner = new Map<string, string | null>();
    const resolveBlockOwner = async (blockId: string): Promise<string | null> => {
      let bid = blockId;
      const seen = new Set<string>();
      for (let i = 0; i < 20 && bid && !seen.has(bid); i++) {
        seen.add(bid);
        const cached = blockOwner.get(bid);
        if (cached !== undefined) return cached;
        let bp: Parent;
        try {
          bp = ((await this.getBlock(bid)) as unknown as { parent: Parent }).parent;
        } catch {
          blockOwner.set(bid, null);
          return null;
        }
        if (bp.type === "page_id" && bp.page_id) {
          const owner = bp.page_id;
          blockOwner.set(blockId, owner);
          return owner;
        }
        if (bp.type === "block_id" && bp.block_id) {
          bid = bp.block_id;
          continue;
        }
        blockOwner.set(blockId, null);
        return null; // data_source_id/database_id/workspace → 페이지 소유자 아님
      }
      return null;
    };

    // pageId(normalized) → root 하위 여부. 체인 전체를 한 번에 memo 한다.
    const memo = new Map<string, boolean>();
    const isUnderRoot = async (startId: string): Promise<boolean> => {
      const chain: string[] = [];
      let cur: string | null = normalizeNotionId(startId);
      const seen = new Set<string>();
      let result = false;
      while (cur && !seen.has(cur)) {
        if (cur === rootN) {
          result = true;
          break;
        }
        const cached = memo.get(cur);
        if (cached !== undefined) {
          result = cached;
          break;
        }
        seen.add(cur);
        chain.push(cur);
        const pg = byId.get(cur);
        if (!pg) break; // 부모가 열거 집합 밖(root 위/미공유) → root 하위 아님
        const parent = pg.parent as Parent;
        if (parent.type === "page_id" && parent.page_id) {
          cur = normalizeNotionId(parent.page_id);
        } else if (parent.type === "block_id" && parent.block_id) {
          const owner = await resolveBlockOwner(parent.block_id);
          cur = owner ? normalizeNotionId(owner) : null;
        } else {
          cur = null; // workspace/data_source_id/database_id → 체인 종료
        }
      }
      for (const c of chain) memo.set(c, result);
      return result;
    };

    const out: PageObjectResponse[] = [];
    for (const p of all) {
      const pid = normalizeNotionId(p.id);
      if (pid === rootN) continue; // root 자신 제외
      const ptype = (p.parent as Parent).type;
      if (ptype === "data_source_id" || ptype === "database_id") continue; // DB 행 제외
      if (NotionClient.isTrashedOrArchived(p)) continue;
      if (await isUnderRoot(p.id)) out.push(p);
    }
    return out;
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
      // 빈 제목 행은 Notion 이 title 을 배열이 아닌 빈 객체({})로 돌려주기도 한다.
      // Array.isArray 가드 없이 .map 을 호출하면 "title.map is not a function" 으로
      // 그 행 전체가 pull 실패→손실되고 매 pull 마다 churn 이 남는다(멱등성 위반).
      if (prop.type === "title" && Array.isArray(prop.title)) {
        const joined = prop.title.map((t) => t.plain_text ?? "").join("");
        if (joined) return joined;
      }
    }
    return "제목 없음";
  }

  /**
   * 페이지 모드 pull(extractProperties)의 relation/people 속성을 raw Notion UUID 가
   * 아니라 [[제목]] 위키링크로 해소하도록 resolver 를 주입한다. 주입하지 않으면 매
   * pull 마다 relation 이 raw UUID 로 재생성돼, 후처리(resolveNotionLinks)에만 의존하는
   * 2-write churn 이 남는다(M1). DB 모드는 orchestrator/DatabaseSyncer 의 자체 mapper 가
   * 이미 resolver 를 주입받아 면역이다.
   */
  setWikilinkResolver(resolver: WikilinkResolver): void {
    this.propertyMapper.setWikilinkResolver(resolver);
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
