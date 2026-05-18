import type { VaultFS } from "../sync/vault-fs.js";
import type { DatabaseViewsConfig, ViewConfig } from "../types/view.js";
import type { DBEntry, PropertyValue, ViewRenderData, PropertySchema } from "./types.js";
import { sortEntries, groupEntries, extractCalendarEntries } from "./filter-engine.js";
import { getVisibleProperties } from "./filter-engine.js";
import matter from "gray-matter";

const DB_VIEWS_PATH = ".im-nobsidian/db-views.json";

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
    const prefix = folderPath.endsWith("/") ? folderPath : folderPath + "/";
    const dbFiles = allFiles.filter((f) => f.path.startsWith(prefix));

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
    const cover = fm.cover as string | undefined;

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
