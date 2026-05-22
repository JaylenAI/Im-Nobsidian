import { describe, it, expect } from "vitest";
import { BaseFileGenerator } from "../../src/view/base-file-generator.js";
import type { BaseFileOptions } from "../../src/view/base-file-generator.js";
import type { DatabaseViewsConfig } from "../../src/types/view.js";

function makeOptions(overrides?: Partial<BaseFileOptions>): BaseFileOptions {
  return {
    databaseId: "db-123",
    databaseName: "Tasks",
    schema: {
      Name: { id: "title", type: "title" },
      Status: {
        id: "s1",
        type: "select",
        options: [
          { name: "To Do", color: "gray" },
          { name: "In Progress", color: "blue" },
          { name: "Done", color: "green" },
        ],
      },
      Tags: {
        id: "t1",
        type: "multi_select",
        options: [
          { name: "bug", color: "red" },
          { name: "feature", color: "purple" },
        ],
      },
      Priority: { id: "n1", type: "number" },
      Due: { id: "d1", type: "date" },
      Done: { id: "c1", type: "checkbox" },
      URL: { id: "u1", type: "url" },
    },
    viewsConfig: {
      databaseId: "db-123",
      databaseName: "Tasks",
      lastSynced: "2026-01-01T00:00:00.000Z",
      views: [
        {
          id: "v1",
          name: "All Tasks",
          type: "table",
          properties: [
            { propertyId: "s1", propertyName: "Status", visible: true },
            { propertyId: "t1", propertyName: "Tags", visible: true },
            { propertyId: "n1", propertyName: "Priority", visible: true },
            { propertyId: "d1", propertyName: "Due", visible: false },
          ],
          sorts: [{ property: "n1", direction: "descending" }],
        },
        {
          id: "v2",
          name: "Gallery",
          type: "gallery",
          cover: { type: "page_cover" },
        },
      ],
    },
    folderPath: "databases/Tasks",
    ...overrides,
  };
}

describe("BaseFileGenerator", () => {
  const generator = new BaseFileGenerator();

  it("기본 .base YAML을 올바르게 생성한다", () => {
    const result = generator.generate(makeOptions());

    expect(result).toContain("---");
    expect(result).toContain("source: folder");
    expect(result).toContain("folder: databases/Tasks");
    expect(result).toContain("properties:");
    expect(result).toContain("views:");
  });

  it("Notion 속성 타입을 Bases 타입으로 변환한다", () => {
    const result = generator.generate(makeOptions());

    expect(result).toContain("Status:");
    expect(result).toContain("type: text");
    expect(result).toContain("Priority:");
    expect(result).toContain("type: number");
    expect(result).toContain("Due:");
    expect(result).toContain("type: date");
    expect(result).toContain("Done:");
    expect(result).toContain("type: checkbox");
  });

  it("title 속성은 properties 섹션에서 제외한다", () => {
    const result = generator.generate(makeOptions());
    const lines = result.split("\n");

    const propSection = lines.slice(
      lines.findIndex((l) => l === "properties:"),
      lines.findIndex((l) => l === "source: folder"),
    );

    const nameEntry = propSection.find((l) => l.trim().startsWith("Name:"));
    expect(nameEntry).toBeUndefined();
  });

  it("select/multi_select의 options을 출력한다", () => {
    const result = generator.generate(makeOptions());

    expect(result).toContain("options:");
    expect(result).toContain('- "To Do"');
    expect(result).toContain('- "In Progress"');
    expect(result).toContain("- Done");
    expect(result).toContain("- bug");
    expect(result).toContain("- feature");
  });

  it("table 뷰를 올바르게 변환한다", () => {
    const result = generator.generate(makeOptions());

    expect(result).toContain("- type: table");
    expect(result).toContain('name: "All Tasks"');
  });

  it("gallery 뷰를 cards로 변환한다", () => {
    const result = generator.generate(makeOptions());

    expect(result).toContain("- type: cards");
    expect(result).toContain("name: Gallery");
  });

  it("visible: true 속성만 포함한다", () => {
    const result = generator.generate(makeOptions());

    expect(result).toContain("- Status");
    expect(result).toContain("- Tags");
    expect(result).toContain("- Priority");
    expect(result).not.toMatch(/properties:[\s\S]*?- Due[\s\S]*?- type:/);
  });

  it("정렬 설정을 변환한다", () => {
    const result = generator.generate(makeOptions());

    expect(result).toContain("sortBy: Priority");
    expect(result).toContain("sortOrder: descending");
  });

  it("board 뷰를 cards로 변환하고 groupBy를 포함한다", () => {
    const result = generator.generate(
      makeOptions({
        viewsConfig: {
          databaseId: "db-123",
          databaseName: "Tasks",
          lastSynced: "2026-01-01T00:00:00.000Z",
          views: [
            {
              id: "v3",
              name: "Board",
              type: "board",
              groupBy: { type: "select", propertyId: "s1", propertyName: "Status" },
            },
          ],
        },
      }),
    );

    expect(result).toContain("- type: cards");
    expect(result).toContain("name: Board");
    expect(result).toContain("groupBy: Status");
  });

  it("calendar/timeline 등 지원 안 되는 뷰는 건너뛴다", () => {
    const result = generator.generate(
      makeOptions({
        viewsConfig: {
          databaseId: "db-123",
          databaseName: "Tasks",
          lastSynced: "2026-01-01T00:00:00.000Z",
          views: [
            { id: "v4", name: "Calendar", type: "calendar", datePropertyName: "Due" },
            { id: "v5", name: "Timeline", type: "timeline" },
          ],
        },
      }),
    );

    expect(result).not.toContain("type: calendar");
    expect(result).not.toContain("type: timeline");
    expect(result).toContain("- type: table");
  });

  it("뷰가 하나도 없으면 기본 table 뷰를 생성한다", () => {
    const result = generator.generate(
      makeOptions({
        viewsConfig: {
          databaseId: "db-123",
          databaseName: "Tasks",
          lastSynced: "2026-01-01T00:00:00.000Z",
          views: [],
        },
      }),
    );

    expect(result).toContain("- type: table");
  });

  it("DB 이름과 ID를 주석으로 포함한다", () => {
    const result = generator.generate(makeOptions());

    expect(result).toContain("# Auto-generated by Im-Nobsidian from Notion DB: Tasks");
    expect(result).toContain("# Database ID: db-123");
  });

  it("특수문자가 포함된 속성명을 올바르게 이스케이프한다", () => {
    const result = generator.generate(
      makeOptions({
        schema: {
          Name: { id: "title", type: "title" },
          "My Property": { id: "mp1", type: "rich_text" },
          "할 일": { id: "td1", type: "select", options: [{ name: "긴급", color: "red" }] },
        },
      }),
    );

    expect(result).toContain('"My Property":');
    expect(result).toContain('"할 일":');
  });

  it("status 속성의 options을 출력한다", () => {
    const result = generator.generate(
      makeOptions({
        schema: {
          Name: { id: "title", type: "title" },
          Status: {
            id: "s1",
            type: "status",
            options: [
              { name: "Not started", color: "default" },
              { name: "In progress", color: "blue" },
              { name: "Done", color: "green" },
            ],
            groups: [
              { name: "To-do", color: "gray" },
              { name: "In progress", color: "blue" },
              { name: "Complete", color: "green" },
            ],
          },
        },
      }),
    );

    expect(result).toContain("options:");
    expect(result).toContain('"Not started"');
    expect(result).toContain('"In progress"');
    expect(result).toContain("- Done");
  });

  it("propertyId로 propertyName을 resolve한다", () => {
    const result = generator.generate(
      makeOptions({
        viewsConfig: {
          databaseId: "db-123",
          databaseName: "Tasks",
          lastSynced: "2026-01-01T00:00:00.000Z",
          views: [
            {
              id: "v1",
              name: "Table",
              type: "table",
              sorts: [{ property: "n1", direction: "ascending" }],
            },
          ],
        },
      }),
    );

    expect(result).toContain("sortBy: Priority");
  });

  it("gallery cover property를 포함한다", () => {
    const result = generator.generate(
      makeOptions({
        viewsConfig: {
          databaseId: "db-123",
          databaseName: "Tasks",
          lastSynced: "2026-01-01T00:00:00.000Z",
          views: [
            {
              id: "v2",
              name: "Gallery",
              type: "gallery",
              cover: { type: "property", propertyId: "u1" },
            },
          ],
        },
      }),
    );

    expect(result).toContain("coverProperty: URL");
  });

  it("timestamp 정렬을 올바르게 처리한다", () => {
    const result = generator.generate(
      makeOptions({
        viewsConfig: {
          databaseId: "db-123",
          databaseName: "Tasks",
          lastSynced: "2026-01-01T00:00:00.000Z",
          views: [
            {
              id: "v1",
              name: "Recent",
              type: "table",
              sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
            },
          ],
        },
      }),
    );

    expect(result).toContain("sortBy: last_edited_time");
    expect(result).toContain("sortOrder: descending");
  });

  it("--- 프론트매터 래퍼로 감싼다", () => {
    const result = generator.generate(makeOptions());
    const lines = result.split("\n");

    expect(lines[0]).toBe("---");
    expect(lines[lines.length - 1]).toBe("---");
  });

  it("list 뷰를 올바르게 변환한다", () => {
    const result = generator.generate(
      makeOptions({
        viewsConfig: {
          databaseId: "db-123",
          databaseName: "Tasks",
          lastSynced: "2026-01-01T00:00:00.000Z",
          views: [{ id: "v1", name: "Simple List", type: "list" }],
        },
      }),
    );

    expect(result).toContain("- type: list");
    expect(result).toContain('name: "Simple List"');
  });
});
