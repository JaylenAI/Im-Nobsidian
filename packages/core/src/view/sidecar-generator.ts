import type { DatabaseViewsConfig, ViewConfig } from "../types/view.js";
import {
  basesViewTypeOf,
  type BasePropertySchema,
  type BasesViewType,
} from "./base-file-generator.js";

/**
 * DB 사이드카(`<db>.notion.json`) — `.base` 로 표현할 수 없는 Notion DB 메타데이터를
 * 무손실 보존하는 단일 파일.
 *
 * ## 왜 필요한가 (I4·I7 "조용한 유실 금지")
 *
 * Obsidian Bases(`.base`)는 Notion DB 뷰의 일부만 표현한다:
 *   · 미지원 뷰(calendar/timeline/form/chart/map/dashboard)는 `.base` 에서 통째 누락.
 *   · 표현되는 뷰도 Notion **필터식·커버 크기/비율·컬럼 width/wrap·빈그룹 숨김** 등은
 *     Bases 문법에 대응이 없어 손실된다.
 *
 * Notion API 는 뷰 생성/수정을 지원하지 않으므로(뷰는 pull-authoritative) 이 메타데이터는
 * push 로 Notion 에 되돌릴 수 없다. 따라서 "무손실"의 의미는 **로컬에 완전·정직하게
 * 보존하고, 무엇이 degrade 됐는지 명시 리포트**하는 것이다. 사이드카는 이를 `.base` 와
 * 같은 폴더에 co-locate 해 사람이 발견 가능하고 도구가 재사용 가능하게 만든다.
 *
 * ## 멱등성
 *
 * 매 pull 마다 재생성되므로 **결정적**이어야 한다(타임스탬프·실행시각 금지, 키 정렬).
 * 동일 DB 상태 → 동일 바이트 → drift 0 / churn 0.
 */
export interface NotionSidecar {
  readonly generator: "im-nobsidian";
  readonly schemaVersion: 1;
  readonly databaseId: string;
  readonly databaseName: string;
  /** 속성 스키마 — 이름 정렬. `.base` displayName 만으로는 잃는 타입/옵션을 보존. */
  readonly properties: SidecarProperty[];
  /** 모든 뷰(표현/미표현 공통) — Notion 순서 유지. */
  readonly views: SidecarView[];
  /** 정직한 손실 리포트 — 무엇이 `.base` 에서 누락/degrade 됐는가. */
  readonly degraded: DegradeNote[];
}

export interface SidecarProperty {
  readonly name: string;
  readonly id: string;
  readonly type: string;
  /** select/multi_select/status 옵션명(있으면). */
  readonly options?: string[];
}

export interface SidecarView {
  readonly id: string;
  readonly name: string;
  readonly notionType: string;
  /** Bases 대응 타입. `null` = `.base` 미표현(사이드카가 유일 보존처). */
  readonly basesType: BasesViewType | null;
  /** 원본 뷰 설정 중 의미 있는 항목(키 정렬). 빈 값은 생략. */
  readonly config: Record<string, unknown>;
}

export interface DegradeNote {
  readonly view: string;
  readonly kind: "view-unrepresentable" | "setting-dropped";
  readonly detail: string;
}

/** `.base` 가 표현하지 못해 사이드카로만 보존되는 뷰 설정 키 → 사람용 사유. */
const DROPPED_SETTING_REASONS: Record<string, string> = {
  filter: "Notion 필터식은 .base 로 표현되지 않음(폴더 필터만 적용)",
  coverSize: "갤러리 커버 크기는 Bases 미지원",
  coverAspect: "갤러리 커버 비율은 Bases 미지원",
  viewRange: "캘린더 표시 범위(week/month)는 Bases 미지원",
  columnWidths: "컬럼 너비(width)는 Bases 미지원",
  columnWraps: "컬럼 줄바꿈(wrap)은 Bases 미지원",
  hideEmptyGroups: "빈 그룹 숨김은 Bases 미지원",
};

export class SidecarGenerator {
  /**
   * 사이드카 객체를 빌드한다(순수 — I/O 없음). 직렬화는 {@link serialize} 가 담당.
   */
  build(options: {
    databaseId: string;
    databaseName: string;
    schema: Record<string, BasePropertySchema>;
    viewsConfig: DatabaseViewsConfig;
  }): NotionSidecar {
    const degraded: DegradeNote[] = [];

    const properties = this.buildProperties(options.schema);
    const views = options.viewsConfig.views.map((v) => this.buildView(v, degraded));

    // 정직성·안정성: 리포트를 (뷰명, kind, detail) 로 정렬해 결정적 순서 보장.
    degraded.sort(
      (a, b) =>
        a.view.localeCompare(b.view) ||
        a.kind.localeCompare(b.kind) ||
        a.detail.localeCompare(b.detail),
    );

    return {
      generator: "im-nobsidian",
      schemaVersion: 1,
      databaseId: options.databaseId,
      databaseName: options.databaseName,
      properties,
      views,
      degraded,
    };
  }

  /**
   * 사이드카를 결정적 JSON 문자열로 직렬화한다(키 재귀 정렬 + 말미 개행).
   * 동일 입력 → 동일 바이트 → 멱등(drift/churn 0).
   */
  serialize(sidecar: NotionSidecar): string {
    return stableStringify(sidecar) + "\n";
  }

  private buildProperties(schema: Record<string, BasePropertySchema>): SidecarProperty[] {
    return Object.entries(schema)
      .map(([name, prop]): SidecarProperty => {
        const options = prop.options?.map((o) => o.name).filter((n) => n.length > 0);
        return {
          name,
          id: prop.id,
          type: prop.type,
          ...(options && options.length > 0 ? { options } : {}),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private buildView(view: ViewConfig, degraded: DegradeNote[]): SidecarView {
    const basesType = basesViewTypeOf(view.type);
    const viewName = view.name || view.type;

    if (basesType === null) {
      degraded.push({
        view: viewName,
        kind: "view-unrepresentable",
        detail: `'${view.type}' 뷰는 Obsidian Bases 대응이 없어 .base 에서 누락 — 사이드카로만 보존`,
      });
    }

    const config = this.extractConfig(view, basesType, viewName, degraded);

    return {
      id: view.id,
      name: viewName,
      notionType: view.type,
      basesType,
      config,
    };
  }

  /**
   * 뷰 설정 중 의미 있는 항목을 추출한다. `.base` 가 표현 못하는 항목(필터·커버크기 등)은
   * config 에 보존하면서 동시에 degrade 리포트에 1줄씩 기록한다(표현되는 뷰에 한해 —
   * 미표현 뷰는 이미 view-unrepresentable 로 통째 보고됨).
   */
  private extractConfig(
    view: ViewConfig,
    basesType: BasesViewType | null,
    viewName: string,
    degraded: DegradeNote[],
  ): Record<string, unknown> {
    const config: Record<string, unknown> = {};
    const noteDrop = (key: string): void => {
      if (basesType !== null && DROPPED_SETTING_REASONS[key]) {
        degraded.push({
          view: viewName,
          kind: "setting-dropped",
          detail: DROPPED_SETTING_REASONS[key]!,
        });
      }
    };

    if (view.filter !== undefined && view.filter !== null) {
      config["filter"] = view.filter;
      noteDrop("filter");
    }
    if (view.sorts && view.sorts.length > 0) config["sorts"] = view.sorts;
    if (view.groupBy) {
      config["groupBy"] = view.groupBy;
      if (view.groupBy.hideEmptyGroups) noteDrop("hideEmptyGroups");
    }
    if (view.cover) config["cover"] = view.cover;
    if (view.coverSize) {
      config["coverSize"] = view.coverSize;
      noteDrop("coverSize");
    }
    if (view.coverAspect) {
      config["coverAspect"] = view.coverAspect;
      noteDrop("coverAspect");
    }
    if (view.datePropertyId) config["datePropertyId"] = view.datePropertyId;
    if (view.datePropertyName) config["datePropertyName"] = view.datePropertyName;
    if (view.viewRange) {
      config["viewRange"] = view.viewRange;
      noteDrop("viewRange");
    }

    if (view.properties && view.properties.length > 0) {
      config["properties"] = view.properties;
      if (view.properties.some((p) => p.width !== undefined)) noteDrop("columnWidths");
      if (view.properties.some((p) => p.wrap !== undefined)) noteDrop("columnWraps");
    }

    return config;
  }
}

/**
 * 키를 재귀 정렬한 결정적 JSON 직렬화기. 배열 순서는 보존(뷰/속성의 원본 순서가 유의미),
 * 객체 키만 사전순 정렬해 동일 입력에 동일 바이트를 보장한다.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
