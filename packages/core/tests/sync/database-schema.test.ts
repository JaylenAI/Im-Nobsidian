import { describe, expect, it } from "vitest";
import {
  parseSidecarSchema,
  planDatabaseSchema,
  relationRequest,
} from "../../src/sync/database-schema.js";
import { propertyDefinitionOf } from "../../src/view/property-definition.js";
import { SidecarGenerator } from "../../src/view/sidecar-generator.js";

// 2026-10-23 실측 — dataSources.retrieve 가 돌려준 속성(id 는 지어낸 값).
const RETRIEVED: Record<string, Record<string, unknown>> = {
  이름: { id: "title", name: "이름", type: "title", title: {} },
  수: { id: "Akoo", name: "수", type: "number", number: { format: "won" } },
  고르기: {
    id: "%7DTfS",
    type: "select",
    select: {
      options: [
        { id: "o1", name: "가", color: "red", description: null },
        { id: "o2", name: "나", color: "blue", description: null },
      ],
    },
  },
  상태: {
    id: "%7CPYA",
    type: "status",
    status: {
      options: [
        { id: "s1", name: "Not started", color: "default" },
        { id: "s2", name: "Done", color: "green" },
      ],
      groups: [
        { id: "g1", name: "To-do", color: "gray", option_ids: ["s1"] },
        { id: "g2", name: "Complete", color: "green", option_ids: ["s2"] },
      ],
    },
  },
  식: { id: "EbyA", type: "formula", formula: { expression: 'prop("수") * 2' } },
  관계: {
    id: "%3F%3Bph",
    type: "relation",
    relation: {
      database_id: "11111111-2222-3333-4444-555555555555",
      data_source_id: "99999999-2222-3333-4444-555555555555",
      type: "dual_property",
      dual_property: { synced_property_name: "되짚기", synced_property_id: "kr%3Cc" },
    },
  },
  단방향: {
    id: "%40bHW",
    type: "relation",
    relation: {
      database_id: "aaaaaaaa-2222-3333-4444-555555555555",
      type: "single_property",
      single_property: {},
    },
  },
  모음: {
    id: "X~~Q",
    type: "rollup",
    rollup: {
      rollup_property_name: "이름",
      relation_property_name: "관계",
      rollup_property_id: "title",
      relation_property_id: "?;ph",
      function: "count",
    },
  },
  번호: { id: "%3Fdti", type: "unique_id", unique_id: { prefix: "TK" } },
  날짜: { id: "d", type: "date", date: {} },
  단추: { id: "b", type: "button", button: {} },
  장소: { id: "pl", type: "place", place: {} },
};

function sidecarText(isInline = false): string {
  const schema = Object.fromEntries(
    Object.entries(RETRIEVED).map(([name, prop]) => {
      const definition = propertyDefinitionOf(prop);
      return [
        name,
        { id: prop.id as string, type: prop.type as string, ...(definition ? { definition } : {}) },
      ];
    }),
  );
  const generator = new SidecarGenerator();
  return generator.serialize(
    generator.build({
      databaseId: "abcdabcd-0000-0000-0000-000000000001",
      databaseName: "탐침 DB",
      schema,
      viewsConfig: { databaseId: "x", lastSynced: "", views: [] },
      isInline,
    }),
  );
}

describe("속성 정의 — 다시 만드는 데 드는 것만", () => {
  it("id · 설명 · data source id 는 남기지 않는다", () => {
    expect(propertyDefinitionOf(RETRIEVED["고르기"]!)).toEqual({
      options: [
        { name: "가", color: "red" },
        { name: "나", color: "blue" },
      ],
    });
    expect(propertyDefinitionOf(RETRIEVED["관계"]!)).toEqual({
      database_id: "11111111222233334444555555555555",
      type: "dual_property",
      synced_property_name: "되짚기",
    });
    expect(propertyDefinitionOf(RETRIEVED["모음"]!)).toEqual({
      relation_property_name: "관계",
      rollup_property_name: "이름",
      function: "count",
    });
  });

  it("status 그룹은 옵션 이름으로 적는다", () => {
    expect(propertyDefinitionOf(RETRIEVED["상태"]!)).toEqual({
      options: [
        { name: "Not started", color: "default" },
        { name: "Done", color: "green" },
      ],
      groups: [
        { name: "To-do", color: "gray", options: ["Not started"] },
        { name: "Complete", color: "green", options: ["Done"] },
      ],
    });
  });

  it("타입 이름만으로 되는 속성은 정의가 없다", () => {
    expect(propertyDefinitionOf(RETRIEVED["날짜"]!)).toBeUndefined();
    expect(propertyDefinitionOf(RETRIEVED["이름"]!)).toBeUndefined();
  });
});

describe("사이드카 v2", () => {
  it("인라인 여부와 속성 정의를 적고 다시 읽는다", () => {
    const text = sidecarText(true);
    expect(JSON.parse(text)).toMatchObject({ schemaVersion: 2, isInline: true });
    const schema = parseSidecarSchema(text)!;
    expect(schema).toMatchObject({
      version: 2,
      databaseId: "abcdabcd000000000000000000000001",
      title: "탐침 DB",
      isInline: true,
    });
    expect(schema.properties.find((p) => p.name === "식")?.definition).toEqual({
      expression: 'prop("수") * 2',
    });
  });

  it("im-nobsidian 사이드카가 아니면 읽지 않는다", () => {
    expect(parseSidecarSchema("{}")).toBeNull();
    expect(parseSidecarSchema("깨짐")).toBeNull();
    expect(
      parseSidecarSchema(JSON.stringify({ generator: "x", databaseId: "a", properties: [] })),
    ).toBeNull();
  });
});

describe("DB 를 만드는 차례", () => {
  const plan = planDatabaseSchema(parseSidecarSchema(sidecarText())!);

  it("처음 만들 때 — 제목 · 숫자 형식 · 옵션 색 · prefix · 평범한 속성", () => {
    expect(plan.titleProperty).toBe("이름");
    expect(plan.initial).toEqual({
      이름: { title: {} },
      수: { number: { format: "won" } },
      고르기: {
        select: {
          options: [
            { name: "가", color: "red" },
            { name: "나", color: "blue" },
          ],
        },
      },
      번호: { unique_id: { prefix: "TK" } },
      날짜: { date: {} },
      장소: { place: {} },
    });
  });

  it("status 는 만든 뒤 · relation · rollup · formula 는 따로", () => {
    expect(plan.statuses).toEqual([
      {
        name: "상태",
        options: [
          { name: "Not started", color: "default" },
          { name: "Done", color: "green" },
        ],
        groups: [
          { name: "To-do", color: "gray", options: ["Not started"] },
          { name: "Complete", color: "green", options: ["Done"] },
        ],
      },
    ]);
    expect(plan.relations).toEqual([
      {
        name: "관계",
        targetDatabaseId: "11111111222233334444555555555555",
        dual: true,
        syncedName: "되짚기",
      },
      { name: "단방향", targetDatabaseId: "aaaaaaaa222233334444555555555555", dual: false },
    ]);
    expect([...plan.rollups.keys()]).toEqual(["모음"]);
    expect(plan.formulas).toEqual({ 식: { formula: { expression: 'prop("수") * 2' } } });
  });

  it("API 가 만들지 못하는 속성은 이유와 함께 뺀다", () => {
    expect(plan.skipped).toEqual([
      { name: "단추", reason: "Notion API 가 만들지 못하는 속성(button)" },
    ]);
  });

  it("v1 사이드카 — 옵션 이름으로 만들고 식 · 관계 · 모음은 뺀다", () => {
    const v1 = JSON.stringify({
      generator: "im-nobsidian",
      schemaVersion: 1,
      databaseId: "abcd",
      databaseName: "옛",
      properties: [
        { name: "이름", id: "title", type: "title" },
        { name: "고르기", id: "a", type: "select", options: ["가", "나"] },
        { name: "식", id: "b", type: "formula" },
        { name: "관계", id: "c", type: "relation" },
      ],
      views: [],
      degraded: [],
    });
    const old = planDatabaseSchema(parseSidecarSchema(v1)!);
    expect(old.initial["고르기"]).toEqual({
      select: { options: [{ name: "가" }, { name: "나" }] },
    });
    expect(old.skipped.map((s) => s.name)).toEqual(["식", "관계"]);
    expect(old.skipped[0]!.reason).toContain("사이드카 v1");
  });

  it("relation 요청은 대상 data source 로", () => {
    expect(relationRequest(plan.relations[0]!, "ds-1")).toEqual({
      relation: { data_source_id: "ds-1", type: "dual_property", dual_property: {} },
    });
    expect(relationRequest(plan.relations[1]!, "ds-2")).toEqual({
      relation: { data_source_id: "ds-2", type: "single_property", single_property: {} },
    });
  });
});
