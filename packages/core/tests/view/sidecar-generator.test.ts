import { describe, it, expect } from "vitest";
import { SidecarGenerator, type NotionSidecar } from "../../src/view/sidecar-generator.js";
import type { BasePropertySchema } from "../../src/view/base-file-generator.js";
import type { DatabaseViewsConfig } from "../../src/types/view.js";

const gen = new SidecarGenerator();

const SCHEMA: Record<string, BasePropertySchema> = {
  이름: { id: "title", type: "title" },
  상태: {
    id: "%5BjiM",
    type: "status",
    options: [{ name: "할 일" }, { name: "진행" }, { name: "완료" }],
  },
  마감: { id: "abcd", type: "date" },
};

function build(views: DatabaseViewsConfig["views"]): NotionSidecar {
  return gen.build({
    databaseId: "db-1",
    databaseName: "할 일",
    schema: SCHEMA,
    viewsConfig: { databaseId: "db-1", databaseName: "할 일", lastSynced: "", views },
  });
}

describe("SidecarGenerator", () => {
  it("미지원 뷰(calendar)는 basesType=null + view-unrepresentable degrade + config 무손실", () => {
    const s = build([
      { id: "v1", name: "달력", type: "calendar", datePropertyId: "abcd", viewRange: "month" },
    ]);

    const view = s.views[0]!;
    expect(view.basesType).toBeNull();
    expect(view.config["datePropertyId"]).toBe("abcd");
    expect(view.config["viewRange"]).toBe("month");

    const unrep = s.degraded.filter((d) => d.kind === "view-unrepresentable");
    expect(unrep).toHaveLength(1);
    expect(unrep[0]!.view).toBe("달력");
  });

  it("표현 뷰(table)의 Notion 필터는 config 보존 + setting-dropped 리포트", () => {
    const filter = { property: "상태", status: { equals: "완료" } };
    const s = build([{ id: "v1", name: "표", type: "table", filter }]);

    const view = s.views[0]!;
    expect(view.basesType).toBe("table");
    expect(view.config["filter"]).toEqual(filter);

    const dropped = s.degraded.filter((d) => d.kind === "setting-dropped");
    expect(dropped.some((d) => d.detail.includes("필터"))).toBe(true);
  });

  it("갤러리 커버 크기/비율·컬럼 width/wrap 도 보존 + 각각 degrade 리포트", () => {
    const s = build([
      {
        id: "v1",
        name: "갤러리",
        type: "gallery",
        coverSize: "large",
        coverAspect: "cover",
        properties: [{ propertyId: "%5BjiM", width: 200, wrap: true }],
      },
    ]);

    const view = s.views[0]!;
    expect(view.basesType).toBe("cards");
    expect(view.config["coverSize"]).toBe("large");
    expect(view.config["coverAspect"]).toBe("cover");

    const details = s.degraded.filter((d) => d.kind === "setting-dropped").map((d) => d.detail);
    expect(details.some((d) => d.includes("커버 크기"))).toBe(true);
    expect(details.some((d) => d.includes("커버 비율"))).toBe(true);
    expect(details.some((d) => d.includes("너비"))).toBe(true);
    expect(details.some((d) => d.includes("줄바꿈"))).toBe(true);
  });

  it("속성은 이름 정렬 + select/status 옵션명 보존, title 도 포함", () => {
    const s = build([{ id: "v1", name: "표", type: "table" }]);

    expect(s.properties.map((p) => p.name)).toEqual(["마감", "상태", "이름"]);
    const status = s.properties.find((p) => p.name === "상태")!;
    expect(status.type).toBe("status");
    expect(status.options).toEqual(["할 일", "진행", "완료"]);
    // 옵션 없는 속성은 options 키 자체가 생략된다.
    expect(s.properties.find((p) => p.name === "마감")!.options).toBeUndefined();
  });

  it("깨끗한 DB(table·필터 없음)는 degrade 0", () => {
    const s = build([{ id: "v1", name: "표", type: "table" }]);
    expect(s.degraded).toHaveLength(0);
  });

  it("직렬화는 결정적 — 동일 입력은 바이트 동일(멱등) + 키 정렬", () => {
    const views: DatabaseViewsConfig["views"] = [
      { id: "v1", name: "표", type: "table", filter: { z: 1, a: 2 } },
    ];
    const a = gen.serialize(build(views));
    const b = gen.serialize(build(views));
    expect(a).toBe(b);
    expect(a.endsWith("\n")).toBe(true);

    // 객체 키는 사전순 정렬(필터 내부 { z, a } → "a" 가 "z" 보다 먼저).
    const parsed = JSON.parse(a) as NotionSidecar;
    const filterKeys = Object.keys(parsed.views[0]!.config["filter"] as object);
    expect(filterKeys).toEqual(["a", "z"]);
    // 최상위 키도 정렬되어 있다.
    expect(Object.keys(parsed).slice(0, 3)).toEqual(["databaseId", "databaseName", "degraded"]);
  });

  it("배열 순서(뷰)는 보존 — Notion 뷰 순서가 의미를 가짐", () => {
    const s = build([
      { id: "v1", name: "B", type: "table" },
      { id: "v2", name: "A", type: "calendar" },
    ]);
    expect(s.views.map((v) => v.name)).toEqual(["B", "A"]);
  });
});
