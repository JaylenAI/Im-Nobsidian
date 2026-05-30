import type { VaultFS } from "../sync/vault-fs.js";
import type { DatabaseViewsConfig, ViewConfig } from "../types/view.js";
import type { DBEntry, PropertyValue, ViewRenderData, PropertySchema } from "./types.js";
import { sortEntries, groupEntries, extractCalendarEntries } from "./filter-engine.js";
import { getVisibleProperties } from "./filter-engine.js";
import matter from "gray-matter";
import { DB_VIEWS_PATH } from "../constants/paths.js";
import { selectDbRowFiles } from "../utils/db-row-path.js";

export class ViewDataProvider {
  constructor(private readonly vaultFs: VaultFS) {}

  async loadAllViewConfigs(): Promise<Record<string, DatabaseViewsConfig>> {
    try {
      const raw = await this.vaultFs.readFile(DB_VIEWS_PATH);
      return JSON.parse(raw) as Record<string, DatabaseViewsConfig>;
    } catch {
      return {};
    }
  }

  async getViewConfigs(databaseId: string): Promise<DatabaseViewsConfig | null> {
    const all = await this.loadAllViewConfigs();
    return all[databaseId] ?? null;
  }

  async collectEntries(folderPath: string): Promise<DBEntry[]> {
    const allFiles = await this.vaultFs.listMarkdownFiles();
    // 직속 행 파일만 — 중첩 하위 폴더(별도 child_database·자식 페이지 본문)는 부모 DB 의
    // 행이 아니므로 카드로 새어 들지 않게 제외한다(I9 오포함 차단).
    const dbFiles = selectDbRowFiles(allFiles, folderPath);

    const entries: DBEntry[] = [];

    for (const file of dbFiles) {
      try {
        const content = await this.vaultFs.readFile(file.path);
        const entry = parseEntry(file.path, content);
        if (entry) entries.push(entry);
      } catch {
        // 파일 읽기 실패 시 스킵
      }
    }

    return entries;
  }

  async buildViewData(
    databaseId: string,
    viewId: string,
    folderPath: string,
    schema?: Record<string, PropertySchema>,
  ): Promise<ViewRenderData | null> {
    const dbConfig = await this.getViewConfigs(databaseId);
    if (!dbConfig) return null;

    const viewConfig = dbConfig.views.find((v) => v.id === viewId);
    if (!viewConfig) return null;

    const entries = await this.collectEntries(folderPath);

    return this.processViewData(entries, viewConfig, databaseId, dbConfig.databaseName, schema);
  }

  async buildDefaultViewData(
    databaseId: string,
    folderPath: string,
    schema?: Record<string, PropertySchema>,
  ): Promise<ViewRenderData | null> {
    const dbConfig = await this.getViewConfigs(databaseId);
    if (!dbConfig || dbConfig.views.length === 0) return null;

    const viewConfig = dbConfig.views[0]!;
    const entries = await this.collectEntries(folderPath);

    return this.processViewData(entries, viewConfig, databaseId, dbConfig.databaseName, schema);
  }

  processViewData(
    entries: DBEntry[],
    viewConfig: ViewConfig,
    databaseId: string,
    databaseName?: string,
    schema?: Record<string, PropertySchema>,
  ): ViewRenderData {
    let processed = entries;

    if (viewConfig.sorts && viewConfig.sorts.length > 0) {
      processed = sortEntries(processed, viewConfig.sorts);
    }

    const visibleProps = getVisibleProperties(viewConfig);
    const propertyNames =
      visibleProps.length > 0 ? visibleProps.map((p) => p.name) : collectPropertyNames(processed);

    const data: ViewRenderData = {
      databaseId,
      databaseName,
      viewConfig,
      entries: processed,
      propertyNames,
      schema,
    };

    if (viewConfig.type === "board" && viewConfig.groupBy) {
      const grouped = groupEntries(
        processed,
        viewConfig.groupBy.propertyName ?? viewConfig.groupBy.propertyId,
        {
          sort: viewConfig.groupBy.sort === "manual" ? undefined : viewConfig.groupBy.sort,
          hideEmptyGroups: viewConfig.groupBy.hideEmptyGroups,
        },
      );
      return { ...data, grouped };
    }

    if (viewConfig.type === "calendar" && viewConfig.datePropertyName) {
      const calendarEntries = extractCalendarEntries(processed, viewConfig.datePropertyName);
      return { ...data, calendarEntries };
    }

    return data;
  }
}

function parseEntry(path: string, content: string): DBEntry | null {
  try {
    const parsed = matter(content);
    const fm = parsed.data as Record<string, unknown>;

    const title = (fm.title as string) ?? extractTitleFromPath(path);
    const icon = fm.icon as string | undefined;
    const cover = coerceCover(fm.cover);

    const properties: Record<string, PropertyValue> = {};
    for (const [key, value] of Object.entries(fm)) {
      if (key === "title" || key === "icon" || key === "cover") continue;
      properties[key] = normalizePropertyValue(value);
    }

    return { path, title, icon, cover, properties };
  } catch {
    return null;
  }
}

/**
 * 갤러리 커버 값을 **렌더 가능한 단일 URL 스칼라**로 강제 변환한다(없으면 undefined).
 *
 * Notion `files` 속성을 갤러리 커버로 쓰면 행마다 파일 수가 달라, property-mapper 는 단일
 * 파일은 스칼라 문자열로·복수 파일은 **URL 배열**로 직렬화한다(데이터 보존). 그러나 카드
 * 커버 `<img src>` 는 스칼라만 받으므로, 배열이 그대로 흘러들면 `src="url1,url2"` 로
 * 합쳐져 **깨진 이미지**가 된다. Notion 도 다중 파일 커버는 **첫 파일**을 쓰므로 동일하게
 * 첫 렌더 가능한 URL 로 degrade 한다. 파일 객체(`{url}`/`{external:{url}}`)도 방어적으로 처리.
 *
 * `DBEntry.cover: string` 타입을 런타임에서 보증한다(과거: `as string` 캐스팅이 배열을
 * 문자열로 단언해 타입이 거짓이었다).
 */
function coerceCover(raw: unknown): string | undefined {
  const firstUrl = (v: unknown): string | undefined => {
    if (typeof v === "string") return v.trim() || undefined;
    if (v && typeof v === "object") {
      const o = v as { url?: unknown; external?: { url?: unknown } };
      const url = o.url ?? o.external?.url;
      if (typeof url === "string") return url.trim() || undefined;
    }
    return undefined;
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      const url = firstUrl(item);
      if (url) return url; // 다중값 → 첫 렌더 가능한 URL 로 degrade
    }
    return undefined;
  }
  return firstUrl(raw);
}

function normalizePropertyValue(value: unknown): PropertyValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value;

  if (value instanceof Date) {
    return value.toISOString().split("T")[0]!;
  }

  if (Array.isArray(value)) {
    return value.map((v) => String(v));
  }

  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    if ("start" in obj) {
      return {
        start: String(obj.start),
        end: obj.end ? String(obj.end) : undefined,
      };
    }
  }

  return String(value);
}

function extractTitleFromPath(filePath: string): string {
  const parts = filePath.split("/");
  const filename = parts[parts.length - 1] ?? "";
  return filename.replace(/\.md$/, "");
}

function collectPropertyNames(entries: DBEntry[]): string[] {
  const names = new Set<string>();
  for (const entry of entries) {
    for (const key of Object.keys(entry.properties)) {
      names.add(key);
    }
  }
  return Array.from(names);
}
