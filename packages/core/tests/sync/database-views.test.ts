/**
 * 사이드카의 보기를 새 DB 의 보기 요청으로 — 속성 id 를 새 DB 의 것으로 바꾼다(ADR-036).
 *
 * 2026-10-23 실측(API 2025-09-03): `views.create` 는 표 · 보드 · 목록 · 갤러리 · 달력 · 타임라인을 받는다.
 * 보기의 속성 id 는 `}TfS` 처럼 풀린 꼴로 오고, 사이드카의 속성 id 는 `%7DTfS` 처럼 인코딩된 꼴이다.
 */
import { describe, expect, it } from "vitest";
import { parseSidecarSchema } from "../../src/sync/database-schema.js";
import { planViews } from "../../src/sync/database-views.js";

function schemaWith(views: unknown[]) {
  return parseSidecarSchema(
    JSON.stringify({
      generator: "im-nobsidian",
      schemaVersion: 2,
      databaseId: "aaaaaaaa000000000000000000000001",
      databaseName: "탐침",
      properties: [
        { name: "이름", id: "title", type: "title" },
        { name: "고르기", id: "%7DTfS", type: "select" },
        { name: "상태", id: "%7CPYA", type: "status" },
        { name: "날짜", id: "CCWZ", type: "date" },
        { name: "체크", id: "gE%40J", type: "checkbox" },
        { name: "수", id: "Akoo", type: "number" },
        { name: "단추", id: "btn1", type: "button" },
      ],
      views,
      degraded: [],
    }),
  )!;
}

// 새 DB 의 속성 — dataSources.retrieve 가 돌려준 꼴(id 인코딩).
const TARGET = {
  이름: { id: "title" },
  고르기: { id: "%3D%3EKw" },
  상태: { id: "ZwGr" },
  날짜: { id: "V%5DDL" },
  체크: { id: "n%40w1" },
  수: { id: "zHTv" },
};

function view(name: string, notionType: string, config: Record<string, unknown>) {
  return { id: `v-${name}`, name, notionType, basesType: null, config };
}

describe("보기 요청 — 속성 id 를 새 DB 의 것으로", () => {
  it("필터 · 정렬 · 그룹 · 날짜 속성을 바꾸고 이름 칸은 보내지 않는다", () => {
    const { requests, skipped } = planViews(
      schemaWith([
        view("필터 표", "table", {
          filter: { property: "gE@J", checkbox: { equals: true } },
          sorts: [{ property: "Akoo", direction: "descending" }],
          configuration: {
            type: "table",
            properties: [
              { property_id: "title", visible: true },
              { property_id: "btn1", visible: true },
            ],
          },
        }),
        view("보드", "board", {
          configuration: {
            type: "board",
            group_by: {
              type: "status",
              property_id: "|PYA",
              group_by: "group",
              sort: { type: "manual" },
            },
          },
        }),
        view("달력", "calendar", {
          configuration: { type: "calendar", date_property_id: "CCWZ" },
        }),
        view("정렬 시각", "list", {
          sorts: [{ timestamp: "created_time", direction: "ascending" }],
          configuration: { type: "list" },
        }),
      ]),
      TARGET,
    );

    expect(skipped).toEqual([]);
    expect(requests).toEqual([
      {
        name: "필터 표",
        type: "table",
        filter: { property: "n@w1", checkbox: { equals: true } },
        sorts: [{ property: "zHTv", direction: "descending" }],
        // 새 DB 에 없는 속성(단추)의 열은 뺀다 — 보기는 만든다.
        configuration: { type: "table", properties: [{ property_id: "title", visible: true }] },
      },
      {
        name: "보드",
        type: "board",
        configuration: {
          type: "board",
          group_by: {
            type: "status",
            property_id: "ZwGr",
            group_by: "group",
            sort: { type: "manual" },
          },
        },
      },
      {
        name: "달력",
        type: "calendar",
        configuration: { type: "calendar", date_property_id: "V]DL" },
      },
      {
        name: "정렬 시각",
        type: "list",
        sorts: [{ timestamp: "created_time", direction: "ascending" }],
        configuration: { type: "list" },
      },
    ]);
  });

  it("빠른 필터는 키가 속성 id 다", () => {
    const { requests } = planViews(
      schemaWith([
        view("빠른", "table", {
          configuration: { type: "table" },
          quickFilters: {
            "}TfS": { select: { equals: "가" } },
            btn1: { checkbox: { equals: true } },
          },
        }),
      ]),
      TARGET,
    );
    expect(requests[0]!.quick_filters).toEqual({ "=>Kw": { select: { equals: "가" } } });
  });

  it("필터 · 그룹이 새 DB 에 없는 속성을 가리키면 그 보기는 만들지 않는다", () => {
    const { requests, skipped } = planViews(
      schemaWith([
        view("단추 필터", "table", {
          filter: { and: [{ property: "btn1", checkbox: { equals: true } }] },
          configuration: { type: "table" },
        }),
        view("단추 그룹", "board", {
          configuration: {
            type: "board",
            group_by: { type: "checkbox", property_id: "btn1", sort: { type: "ascending" } },
          },
        }),
      ]),
      TARGET,
    );
    expect(requests).toEqual([]);
    expect(skipped).toEqual([
      { name: "단추 필터", reason: "새 DB 에 없는 속성(단추)을 가리킨다" },
      { name: "단추 그룹", reason: "새 DB 에 없는 속성(단추)을 가리킨다" },
    ]);
  });

  it("정렬 하나가 없는 속성이면 그 정렬만 뺀다", () => {
    const { requests } = planViews(
      schemaWith([
        view("정렬", "table", {
          sorts: [
            { property: "btn1", direction: "ascending" },
            { property: "Akoo", direction: "ascending" },
          ],
          configuration: { type: "table" },
        }),
      ]),
      TARGET,
    );
    expect(requests[0]!.sorts).toEqual([{ property: "zHTv", direction: "ascending" }]);
  });

  it("설정이 적히기 전의 사이드카 · 대시보드는 이유와 함께 뺀다", () => {
    const { requests, skipped } = planViews(
      schemaWith([
        view("옛", "table", { sorts: [{ property: "Akoo", direction: "ascending" }] }),
        view("판", "dashboard", { configuration: { type: "dashboard" } }),
      ]),
      TARGET,
    );
    expect(requests).toEqual([]);
    expect(skipped.map((s) => s.name)).toEqual(["옛", "판"]);
    expect(skipped[0]!.reason).toContain("다시 pull");
    expect(skipped[1]!.reason).toContain("대시보드");
  });
});
