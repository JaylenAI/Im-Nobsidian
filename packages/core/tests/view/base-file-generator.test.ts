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

  it("sort를 property/direction 형식으로 변환한다 (Bases 키는 property, column 아님)", () => {
    const result = generator.generate(makeOptions());

    expect(result).toContain("sort:");
    expect(result).toContain("property: Priority");
    expect(result).toContain("direction: DESC");
    // column: 은 Obsidian Bases가 인식하지 못하는 무효 키 — 절대 출력하면 안 됨
    expect(result).not.toContain("column:");
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

    expect(result).toContain("property: Priority");
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

    expect(result).toContain("property: file.mtime");
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

  it("gallery의 page_content 커버를 formula.coverImage로 변환하고 formulas 섹션을 생성한다", () => {
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
              cover: { type: "page_content" },
            },
          ],
        },
      }),
    );

    expect(result).toContain("formulas:");
    expect(result).toContain("  coverImage: file.embeds[0]");
    expect(result).toContain("image: formula.coverImage");
  });

  it("gallery의 page_content_first 커버를 formula.coverImage로 변환한다", () => {
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
              cover: { type: "page_content_first" },
            },
          ],
        },
      }),
    );

    expect(result).toContain("image: formula.coverImage");
  });

  it("page_cover 갤러리에는 formulas 섹션을 생성하지 않는다", () => {
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

    expect(result).not.toContain("formulas:");
    expect(result).toContain("image: note.cover");
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

    expect(result).toContain("property: file.ctime");
    expect(result).toContain("direction: ASC");
  });

  it("YAML 메타문자가 든 속성 참조는 sort/order에서 인용한다", () => {
    const result = generator.generate(
      makeOptions({
        schema: {
          Name: { id: "title", type: "title" },
          "A: B": { id: "p1", type: "number" },
        },
        viewsConfig: {
          databaseId: "db-123",
          databaseName: "Tasks",
          lastSynced: "2026-01-01T00:00:00.000Z",
          views: [
            {
              id: "v1",
              name: "T",
              type: "table",
              properties: [{ propertyId: "p1", propertyName: "A: B", visible: true }],
              sorts: [{ property: "p1", direction: "ascending" }],
            },
          ],
        },
      }),
    );

    expect(result).toContain('- "A: B"');
    expect(result).toContain('property: "A: B"');
  });

  it("공백 포함 속성명은 평문 스칼라로 출력한다(과인용 금지)", () => {
    const result = generator.generate(
      makeOptions({
        schema: {
          Name: { id: "title", type: "title" },
          "Due Date": { id: "d1", type: "date" },
        },
        viewsConfig: {
          databaseId: "db-123",
          databaseName: "Tasks",
          lastSynced: "2026-01-01T00:00:00.000Z",
          views: [
            {
              id: "v1",
              name: "T",
              type: "table",
              sorts: [{ property: "d1", direction: "ascending" }],
            },
          ],
        },
      }),
    );

    expect(result).toContain("property: Due Date");
    expect(result).not.toContain('property: "Due Date"');
  });

  it("file.* 참조는 인용하지 않는다", () => {
    const result = generator.generate(makeOptions());

    expect(result).toContain("- file.name");
    expect(result).not.toContain('"file.name"');
  });

  it("출력은 말미 개행으로 끝난다", () => {
    const result = generator.generate(makeOptions());

    expect(result.endsWith("\n")).toBe(true);
  });

  it("동명 뷰(Untitled 다수)는 유일한 이름으로 dedupe 한다", () => {
    const result = generator.generate(
      makeOptions({
        viewsConfig: {
          databaseId: "db-123",
          databaseName: "Tasks",
          lastSynced: "2026-01-01T00:00:00.000Z",
          views: [
            { id: "v1", name: "Untitled", type: "table" },
            { id: "v2", name: "Untitled", type: "table" },
            { id: "v3", name: "Untitled", type: "gallery", cover: { type: "page_cover" } },
            { id: "v4", name: "갤러리", type: "gallery", cover: { type: "page_cover" } },
          ],
        },
      }),
    );

    // YAML 인용(공백·비ASCII 이름은 따옴표) 제거 후 비교.
    const names = [...result.matchAll(/^ {4}name: (.+)$/gm)].map((m) =>
      m[1].replace(/^"(.*)"$/, "$1"),
    );
    // 4개 뷰 모두 보존 + 이름 유일.
    expect(names).toHaveLength(4);
    expect(new Set(names).size).toBe(4);
    expect(names).toContain("Untitled");
    expect(names).toContain("Untitled 2");
    expect(names).toContain("Untitled 3");
    expect(names).toContain("갤러리");
  });

  it("이미 존재하는 접미사 이름과도 충돌하지 않게 증가한다", () => {
    const result = generator.generate(
      makeOptions({
        viewsConfig: {
          databaseId: "db-123",
          databaseName: "Tasks",
          lastSynced: "2026-01-01T00:00:00.000Z",
          views: [
            { id: "v1", name: "View", type: "table" },
            { id: "v2", name: "View 2", type: "table" },
            { id: "v3", name: "View", type: "table" },
          ],
        },
      }),
    );

    // YAML 인용(공백·비ASCII 이름은 따옴표) 제거 후 비교.
    const names = [...result.matchAll(/^ {4}name: (.+)$/gm)].map((m) =>
      m[1].replace(/^"(.*)"$/, "$1"),
    );
    expect(new Set(names).size).toBe(3);
    // 'View'(v1) → 'View', 'View 2'(v2) 그대로, 'View'(v3)는 'View 2' 충돌 회피 → 'View 3'.
    expect(names).toEqual(["View", "View 2", "View 3"]);
  });

  // rank12(SSOT): 부분일치(.toContain) 단언은 누락·순서뒤바뀜·잡문자 삽입을 못 잡는다.
  // base 파일 생성은 입력이 같으면 출력이 100% 결정적이므로, 전체 출력 바이트를 골든으로
  // 고정(toBe)해 무손실·결정론을 한 번에 잠근다. 출력 형식이 바뀌면 이 테스트가 즉시 깨져
  // 의도적 변경임을 강제로 검토하게 만든다(거짓종료방지·표현 드리프트 차단).
  it("결정적 전체 출력이 골든과 바이트 단위로 정확히 일치한다(toBe)", () => {
    const GOLDEN =
      "# Auto-generated by Im-Nobsidian from Notion DB: Tasks\n" +
      "# Database ID: db-123\n" +
      "\n" +
      "filters:\n" +
      "  and:\n" +
      '    - file.inFolder("databases/Tasks")\n' +
      '    - file.ext == "md"\n' +
      "\n" +
      "properties:\n" +
      "  Status:\n" +
      "    displayName: Status\n" +
      "  Tags:\n" +
      "    displayName: Tags\n" +
      "  Priority:\n" +
      "    displayName: Priority\n" +
      "  Due:\n" +
      "    displayName: Due\n" +
      "  Done:\n" +
      "    displayName: Done\n" +
      "  URL:\n" +
      "    displayName: URL\n" +
      "\n" +
      "views:\n" +
      "  - type: table\n" +
      '    name: "All Tasks"\n' +
      "    order:\n" +
      "      - file.name\n" +
      "      - Status\n" +
      "      - Tags\n" +
      "      - Priority\n" +
      "    sort:\n" +
      "      - property: Priority\n" +
      "        direction: DESC\n" +
      "  - type: cards\n" +
      "    name: Gallery\n" +
      "    image: note.cover\n";

    expect(generator.generate(makeOptions())).toBe(GOLDEN);
  });

  // rank12(SSOT): filters 블록을 라인 배열로 추출해 `file.ext == "md"` 게이트가 정확한
  // 위치·들여쓰기로 존재함을 toEqual 로 잠근다(.base 가 .md 만 데이터소스로 잡도록 보장).
  it('filters 블록이 file.ext == "md" 게이트를 정확한 순서로 포함한다(toEqual)', () => {
    const lines = generator.generate(makeOptions()).split("\n");
    const start = lines.indexOf("filters:");
    const end = lines.indexOf("properties:");
    // filters: 부터 properties: 직전 빈 줄 전까지.
    const filterBlock = lines.slice(start, end - 1);

    expect(filterBlock).toEqual([
      "filters:",
      "  and:",
      '    - file.inFolder("databases/Tasks")',
      '    - file.ext == "md"',
    ]);
  });
});

// rank13(SSOT): Notion `views.retrieve` 는 RAW 속성 id(`[jiM`)를, `databases.retrieve` 스키마는
// URL-인코딩 id(`%5BjiM`)를 준다. decodeId 로 정규화하지 않으면 title 외 모든 속성 참조
// (order/sort/cover image)가 매칭에 실패해 갤러리 커버·표시 컬럼이 통째로 사라진다.
// 두 인코딩 방향이 **동일한 결정적 출력**으로 수렴하고, 원시 id 가 출력에 누출되지 않음을 잠근다.
describe("BaseFileGenerator — RAW vs URL-인코딩 속성 id 해석 (rank13)", () => {
  const generator = new BaseFileGenerator();

  // schemaId/viewId 로 인코딩 방향을 바꿔 동일 속성을 가리키게 한다(`%5BjiM` decode → `[jiM`).
  function makeIdOptions(schemaId: string, viewId: string): BaseFileOptions {
    return {
      databaseId: "db-123",
      databaseName: "Tasks",
      schema: {
        Name: { id: "title", type: "title" },
        Status: { id: schemaId, type: "select", options: [{ name: "Done", color: "green" }] },
      },
      viewsConfig: {
        databaseId: "db-123",
        databaseName: "Tasks",
        lastSynced: "2026-01-01T00:00:00.000Z",
        views: [
          {
            id: "v1",
            name: "Table",
            type: "table",
            properties: [{ propertyId: viewId, visible: true }],
            sorts: [{ property: viewId, direction: "descending" }],
          },
          {
            id: "v2",
            name: "Cards",
            type: "gallery",
            cover: { type: "property", propertyId: viewId },
          },
        ],
      },
      folderPath: "databases/Tasks",
    };
  }

  // 해석 성공 시의 결정적 골든 — order/sort/image 모두 원시 id 가 아니라 `Status` 로 해석된다.
  const RESOLVED_GOLDEN =
    "# Auto-generated by Im-Nobsidian from Notion DB: Tasks\n" +
    "# Database ID: db-123\n" +
    "\n" +
    "filters:\n" +
    "  and:\n" +
    '    - file.inFolder("databases/Tasks")\n' +
    '    - file.ext == "md"\n' +
    "\n" +
    "properties:\n" +
    "  Status:\n" +
    "    displayName: Status\n" +
    "\n" +
    "views:\n" +
    "  - type: table\n" +
    "    name: Table\n" +
    "    order:\n" +
    "      - file.name\n" +
    "      - Status\n" +
    "    sort:\n" +
    "      - property: Status\n" +
    "        direction: DESC\n" +
    "  - type: cards\n" +
    "    name: Cards\n" +
    "    image: Status\n";

  it("뷰 RAW id([jiM) ↔ 스키마 URL-인코딩 id(%5BjiM) 가 디코드 후 Status로 해석된다(toBe)", () => {
    expect(generator.generate(makeIdOptions("%5BjiM", "[jiM"))).toBe(RESOLVED_GOLDEN);
  });

  it("역방향(스키마 RAW, 뷰 URL-인코딩)도 동일 Status로 해석 — 인코딩 비대칭에 견고(toBe)", () => {
    expect(generator.generate(makeIdOptions("[jiM", "%5BjiM"))).toBe(RESOLVED_GOLDEN);
  });

  it("두 인코딩 방향의 출력이 바이트 단위로 동일하고 원시 id 가 출력에 누출되지 않는다", () => {
    const a = generator.generate(makeIdOptions("%5BjiM", "[jiM"));
    const b = generator.generate(makeIdOptions("[jiM", "%5BjiM"));
    // 인코딩 방향 무관 결정론.
    expect(a).toBe(b);
    // 디코드 누락 시 propRef 가 "[jiM"/"%5BjiM" 를 인용 노출하므로, 누출 0 을 명시 잠금.
    expect(a.includes("[jiM")).toBe(false);
    expect(a.includes("%5BjiM")).toBe(false);
  });
});

// rank14(I7): 스키마 진화(속성 삭제·이름변경)는 매 pull 마다 .base 를 현재 스키마로 **완전
// 재생성**해 반영된다. 뷰는 속성을 **안정적 id** 로 참조하므로, 이름이 바뀌어도(id 동일)
// 새 이름으로 따라가고, 속성이 삭제되면 properties/order 에서 자연히 사라진다.
// 결정적 재생성이라 동일 스키마 → 동일 바이트(멱등). order 배열을 toEqual 로 잠근다.
describe("BaseFileGenerator — 스키마 진화(삭제·이름변경) 반영 (rank14)", () => {
  const generator = new BaseFileGenerator();

  // 뷰는 속성을 id(s1/n1)로만 참조한다(propertyName 미지정 → resolvePropertyName 강제).
  function makeEvoOptions(schema: BaseFileOptions["schema"]): BaseFileOptions {
    return {
      databaseId: "db-123",
      databaseName: "Tasks",
      schema,
      viewsConfig: {
        databaseId: "db-123",
        databaseName: "Tasks",
        lastSynced: "2026-01-01T00:00:00.000Z",
        views: [
          {
            id: "v1",
            name: "Table",
            type: "table",
            properties: [
              { propertyId: "s1", visible: true },
              { propertyId: "n1", visible: true },
            ],
            sorts: [{ property: "n1", direction: "descending" }],
          },
        ],
      },
      folderPath: "databases/Tasks",
    };
  }

  // order: 블록을 라인 배열로 추출(없으면 null).
  function extractOrder(result: string): string[] | null {
    const lines = result.split("\n");
    const start = lines.indexOf("    order:");
    if (start < 0) return null;
    const out: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
      const m = lines[i].match(/^ {6}- (.+)$/);
      if (!m) break;
      out.push(m[1]);
    }
    return out;
  }

  // properties: 섹션의 2칸 들여쓰기 키만 추출.
  function extractPropKeys(result: string): string[] {
    const lines = result.split("\n");
    const start = lines.indexOf("properties:");
    const end = lines.indexOf("views:");
    if (start < 0 || end < 0) return [];
    return lines
      .slice(start + 1, end)
      .filter((l) => /^ {2}\S/.test(l))
      .map((l) => l.trim().replace(/:$/, ""));
  }

  const BASE_SCHEMA: BaseFileOptions["schema"] = {
    Name: { id: "title", type: "title" },
    Status: { id: "s1", type: "select", options: [{ name: "Done", color: "green" }] },
    Priority: { id: "n1", type: "number" },
  };

  it("기준선 — Status·Priority 가 properties·order 에 모두 존재한다", () => {
    const result = generator.generate(makeEvoOptions(BASE_SCHEMA));
    expect(extractPropKeys(result)).toEqual(["Status", "Priority"]);
    expect(extractOrder(result)).toEqual(["file.name", "Status", "Priority"]);
  });

  it("속성 이름변경(Status→State, id 동일 s1)이 properties·order 에 그대로 따라간다", () => {
    const renamed: BaseFileOptions["schema"] = {
      Name: { id: "title", type: "title" },
      State: { id: "s1", type: "select", options: [{ name: "Done", color: "green" }] }, // 이름만 변경
      Priority: { id: "n1", type: "number" },
    };
    const result = generator.generate(makeEvoOptions(renamed));
    // 옛 이름 Status 는 완전히 사라지고 새 이름 State 로 대체.
    expect(extractPropKeys(result)).toEqual(["State", "Priority"]);
    expect(extractOrder(result)).toEqual(["file.name", "State", "Priority"]);
    expect(result.includes("Status")).toBe(false);
  });

  it("속성 삭제(Status 제거)가 properties·order 에서 자연히 사라진다(잔존 0)", () => {
    const deleted: BaseFileOptions["schema"] = {
      Name: { id: "title", type: "title" },
      Priority: { id: "n1", type: "number" }, // Status(s1) 삭제됨
    };
    const result = generator.generate(makeEvoOptions(deleted));
    // 삭제된 Status 는 properties·order 어디에도 없고, Priority 만 남는다.
    expect(extractPropKeys(result)).toEqual(["Priority"]);
    expect(extractOrder(result)).toEqual(["file.name", "Priority"]);
    expect(result.includes("Status")).toBe(false);
    // 미해석 원시 id(s1)도 출력에 누출되지 않는다.
    expect(/(^|\W)s1(\W|$)/.test(result)).toBe(false);
  });
});
