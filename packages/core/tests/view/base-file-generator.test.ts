import { describe, it, expect } from "vitest";
import { BaseFileGenerator } from "../../src/view/base-file-generator.js";
import type { BaseFileOptions } from "../../src/view/base-file-generator.js";

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

  it("file.inFolder 필터로 데이터 소스를 지정한다", () => {
    const result = generator.generate(makeOptions());

    expect(result).toContain("filters:");
    expect(result).toContain('file.inFolder("databases/Tasks")');
  });

  it("properties 섹션에 displayName을 출력한다", () => {
    const result = generator.generate(makeOptions());

    expect(result).toContain("properties:");
    expect(result).toContain("displayName: Status");
    expect(result).toContain("displayName: Priority");
  });

  it("title 속성은 properties 섹션에서 제외한다", () => {
    const result = generator.generate(makeOptions());

    const lines = result.split("\n");
    const propSection = lines.slice(
      lines.findIndex((l) => l === "properties:"),
      lines.findIndex((l) => l === "views:"),
    );
    const nameEntry = propSection.find((l) => l.trim().startsWith("Name:"));
    expect(nameEntry).toBeUndefined();
  });

  it("views 섹션에 뷰를 올바르게 출력한다", () => {
    const result = generator.generate(makeOptions());

    expect(result).toContain("views:");
    expect(result).toContain("- type: table");
    expect(result).toContain('name: "All Tasks"');
  });

  it("gallery 뷰를 cards 타입으로 변환한다", () => {
    const result = generator.generate(makeOptions());

    expect(result).toContain("- type: cards");
    expect(result).toContain("name: Gallery");
  });

  it("order에 visible 속성만 file.name과 함께 포함한다", () => {
    const result = generator.generate(makeOptions());

    expect(result).toContain("order:");
    expect(result).toContain("- file.name");
    expect(result).toContain("- Status");
    expect(result).toContain("- Tags");
    expect(result).toContain("- Priority");
  });

  it("sort를 column/direction 형식으로 변환한다", () => {
    const result = generator.generate(makeOptions());

    expect(result).toContain("sort:");
    expect(result).toContain("column: Priority");
    expect(result).toContain("direction: DESC");
  });

  it("board 뷰를 cards로 변환하고 groupBy를 올바른 형식으로 출력한다", () => {
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
              groupBy: {
                type: "select",
                propertyId: "s1",
                propertyName: "Status",
                sort: "ascending",
              },
            },
          ],
        },
      }),
    );

    expect(result).toContain("- type: cards");
    expect(result).toContain("name: Board");
    expect(result).toContain("groupBy:");
    expect(result).toContain("property: Status");
    expect(result).toContain("direction: ASC");
  });

  it("calendar/timeline 등 미지원 뷰는 건너뛰고 기본 table로 대체한다", () => {
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
    expect(result).toContain("name: Table");
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
          simple: { id: "s1", type: "select" },
        },
      }),
    );

    expect(result).toContain('"My Property":');
    expect(result).toContain('displayName: "My Property"');
  });

  it("propertyId로 propertyName을 resolve하여 sort에 사용한다", () => {
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

    expect(result).toContain("column: Priority");
    expect(result).toContain("direction: ASC");
  });

  it("gallery의 page_cover를 note.cover로 변환한다", () => {
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
              cover: { type: "page_cover" },
            },
          ],
        },
      }),
    );

    expect(result).toContain("image: note.cover");
  });

  it("gallery의 property cover를 property명으로 변환한다", () => {
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

    expect(result).toContain("image: URL");
  });

  it("timestamp 정렬을 file.ctime/file.mtime으로 변환한다", () => {
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

    expect(result).toContain("column: file.mtime");
    expect(result).toContain("direction: DESC");
  });

  it("--- 프론트매터 래퍼를 사용하지 않는다 (Bases는 순수 YAML)", () => {
    const result = generator.generate(makeOptions());

    expect(result).not.toMatch(/^---/);
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

  it("groupBy에 direction이 없으면 생략한다", () => {
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
              groupBy: {
                type: "select",
                propertyId: "s1",
                propertyName: "Status",
                sort: "manual",
              },
            },
          ],
        },
      }),
    );

    expect(result).toContain("property: Status");
    expect(result).not.toContain("direction:");
  });

  it("created_time 정렬을 file.ctime으로 변환한다", () => {
    const result = generator.generate(
      makeOptions({
        viewsConfig: {
          databaseId: "db-123",
          databaseName: "Tasks",
          lastSynced: "2026-01-01T00:00:00.000Z",
          views: [
            {
              id: "v1",
              name: "Oldest",
              type: "table",
              sorts: [{ timestamp: "created_time", direction: "ascending" }],
            },
          ],
        },
      }),
    );

    expect(result).toContain("column: file.ctime");
    expect(result).toContain("direction: ASC");
  });
});
