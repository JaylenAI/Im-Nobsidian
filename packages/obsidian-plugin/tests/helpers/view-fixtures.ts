import type { ViewRenderData, DBEntry, ViewConfig, PropertySchema } from "@im-nobsidian/core";

/**
 * I9 컴포넌트 마운트 테스트용 ViewRenderData 픽스처.
 * 실제 pull 이 만들어내는 모양(가시 속성 + 다양한 PropertyValue 타입)을 모사한다.
 */
export const SAMPLE_ENTRIES: DBEntry[] = [
  {
    path: "db/감자.md",
    title: "감자",
    icon: "🥔",
    cover: "https://example.com/potato.png",
    properties: { 상태: "완료", 우선순위: 3, 태그: ["밭", "가을"], 완료: true },
  },
  {
    path: "db/당근.md",
    title: "당근",
    icon: "🥕",
    properties: { 상태: "진행", 우선순위: 1, 태그: ["밭"], 완료: false },
  },
  {
    path: "db/양파.md",
    title: "양파",
    properties: { 상태: "할 일", 우선순위: 2, 태그: [], 완료: false },
  },
];

const SCHEMA: Record<string, PropertySchema> = {
  상태: {
    name: "상태",
    type: "status",
    options: [{ name: "완료" }, { name: "진행" }, { name: "할 일" }],
  },
  우선순위: { name: "우선순위", type: "number" },
  태그: { name: "태그", type: "multi_select" },
  완료: { name: "완료", type: "checkbox" },
};

export function makeViewConfig(
  type: ViewConfig["type"],
  overrides: Partial<ViewConfig> = {},
): ViewConfig {
  return {
    id: "v1",
    name: "기본 뷰",
    type,
    properties: [
      { propertyId: "p-status", propertyName: "상태", visible: true },
      { propertyId: "p-prio", propertyName: "우선순위", visible: true },
      { propertyId: "p-tags", propertyName: "태그", visible: true },
      { propertyId: "p-done", propertyName: "완료", visible: false },
    ],
    ...overrides,
  };
}

export function makeViewData(
  type: ViewConfig["type"],
  overrides: Partial<ViewRenderData> = {},
): ViewRenderData {
  return {
    databaseId: "db-1",
    databaseName: "채소",
    viewConfig: makeViewConfig(type),
    entries: SAMPLE_ENTRIES,
    propertyNames: ["상태", "우선순위", "태그", "완료"],
    schema: SCHEMA,
    ...overrides,
  };
}
