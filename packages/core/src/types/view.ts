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

/** select/multi_select/status 의 선택지 하나. */
export interface BasePropertyOption {
  readonly name: string;
  readonly color?: string;
  /**
   * Notion 내부 옵션 id. 사람이 보는 산출물에는 절대 나가지 않지만,
   * status 그룹(`BaseStatusGroup.optionIds`)을 옵션명으로 되돌리는 유일한 열쇠다 —
   * 뷰 필터가 옵션명 대신 그룹명으로 오기 때문에(예: `["To-do"]`) 이게 없으면
   * 필터를 옮길 수 없다.
   */
  readonly id?: string;
}

/** status 속성의 그룹(To-do/In progress/Complete). 소속 옵션을 id 로 가리킨다. */
export interface BaseStatusGroup {
  readonly name: string;
  readonly color?: string;
  readonly optionIds?: string[];
}

/**
 * Notion DB 속성 스키마 — `.base` 생성·사이드카·필터 번역이 함께 쓰는 SSOT.
 *
 * 같은 모양을 세 군데(클라이언트 반환형·생성기 입력형)에 따로 적어 두면 한쪽만
 * 넓혔을 때 조용히 어긋난다. 실제로 옵션 `id` 가 클라이언트에서만 빠져 있어
 * status 그룹 필터를 옮길 수 없었다.
 */
export interface BasePropertySchema {
  readonly id: string;
  readonly type: string;
  readonly options?: BasePropertyOption[];
  readonly groups?: BaseStatusGroup[];
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
