export type ViewType =
  | "table"
  | "board"
  | "list"
  | "calendar"
  | "timeline"
  | "gallery"
  | "form"
  | "chart"
  | "map"
  | "dashboard";

export interface ViewPropertyConfig {
  readonly propertyId: string;
  readonly propertyName?: string;
  readonly visible?: boolean;
  readonly width?: number;
  readonly wrap?: boolean;
}

export interface CoverConfig {
  readonly type: "page_cover" | "page_content" | "page_content_first" | "property";
  readonly propertyId?: string;
}

export interface GroupByConfig {
  readonly type: string;
  readonly propertyId: string;
  readonly propertyName?: string;
  readonly sort?: "manual" | "ascending" | "descending";
  readonly hideEmptyGroups?: boolean;
}

export interface ViewConfig {
  readonly id: string;
  readonly name: string;
  readonly type: ViewType;
  readonly dataSourceId?: string | null;
  readonly filter?: unknown;
  readonly sorts?: Array<{
    readonly property?: string;
    readonly timestamp?: "created_time" | "last_edited_time";
    readonly direction: "ascending" | "descending";
  }>;
  readonly properties?: ViewPropertyConfig[];
  readonly groupBy?: GroupByConfig;
  readonly cover?: CoverConfig;
  readonly coverSize?: "small" | "medium" | "large";
  readonly coverAspect?: "contain" | "cover";
  readonly datePropertyId?: string;
  readonly datePropertyName?: string;
  readonly viewRange?: "week" | "month";
}

export interface DatabaseViewsConfig {
  readonly databaseId: string;
  readonly databaseName?: string;
  readonly lastSynced: string;
  readonly views: ViewConfig[];
}

export interface PageCover {
  readonly type: "file" | "external";
  readonly url: string;
  readonly expiryTime?: string;
}

export interface PageIcon {
  readonly type: "emoji" | "external" | "file" | "icon";
  readonly value: string;
  readonly color?: string;
}
