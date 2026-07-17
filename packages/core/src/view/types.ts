import type { ViewConfig } from "../types/view.js";

export interface DBEntry {
  readonly path: string;
  readonly title: string;
  readonly icon?: string;
  readonly cover?: string;
  readonly properties: Record<string, PropertyValue>;
}

export type PropertyValue =
  string | number | boolean | null | string[] | { start: string; end?: string };

export interface GroupedEntries {
  readonly groupName: string;
  readonly groupColor?: NotionColor;
  readonly entries: DBEntry[];
}

export interface CalendarEntry {
  readonly entry: DBEntry;
  readonly date: string;
  readonly endDate?: string;
}

export type NotionColor =
  "default" | "gray" | "brown" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink" | "red";

export interface ViewRenderData {
  readonly databaseId: string;
  readonly databaseName?: string;
  readonly viewConfig: ViewConfig;
  readonly entries: DBEntry[];
  readonly grouped?: GroupedEntries[];
  readonly calendarEntries?: CalendarEntry[];
  readonly propertyNames: string[];
  readonly schema?: Record<string, PropertySchema>;
}

export interface PropertySchema {
  readonly name: string;
  readonly type: string;
  readonly options?: PropertyOption[];
}

export interface PropertyOption {
  readonly name: string;
  readonly color?: NotionColor;
}
