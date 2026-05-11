import { describe, it, expect, vi } from "vitest";
import { NotionClient } from "../../src/notion/client.js";

function createClient() {
  return new NotionClient({ token: "ntn_test_fake_token", concurrency: 1, timeoutMs: 1000 });
}

function createMockPage(properties: Record<string, any>) {
  return {
    id: "page-123",
    last_edited_time: "2026-01-01T00:00:00.000Z",
    parent: { type: "page_id", page_id: "parent-123" },
    properties,
  } as any;
}

describe("NotionClient - extractTitle", () => {
  const client = createClient();

  it("title 속성에서 제목 추출", () => {
    const page = createMockPage({
      Name: {
        type: "title",
        title: [{ plain_text: "My Page Title" }],
      },
    });

    expect(client.extractTitle(page)).toBe("My Page Title");
  });

  it("title이 비어있으면 기본값 반환", () => {
    const page = createMockPage({
      Name: {
        type: "title",
        title: [],
      },
    });

    expect(client.extractTitle(page)).toBe("제목 없음");
  });

  it("title 속성이 없으면 기본값 반환", () => {
    const page = createMockPage({
      status: { type: "select", select: { name: "active" } },
    });

    expect(client.extractTitle(page)).toBe("제목 없음");
  });
});

describe("NotionClient - extractProperties", () => {
  const client = createClient();

  it("title 속성은 제외", () => {
    const page = createMockPage({
      Name: { type: "title", title: [{ plain_text: "Title" }] },
      Status: { type: "select", select: { name: "active" } },
    });

    const props = client.extractProperties(page);

    expect(props).not.toHaveProperty("title");
    expect(props).toHaveProperty("Status");
  });

  it("rich_text 속성 추출", () => {
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      Description: {
        type: "rich_text",
        rich_text: [{ plain_text: "Hello " }, { plain_text: "World" }],
      },
    });

    expect(client.extractProperties(page).Description).toBe("Hello World");
  });

  it("number 속성 추출", () => {
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      Count: { type: "number", number: 42 },
    });

    expect(client.extractProperties(page).Count).toBe(42);
  });

  it("select 속성 추출", () => {
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      Priority: { type: "select", select: { name: "High" } },
    });

    expect(client.extractProperties(page).Priority).toBe("High");
  });

  it("select null 처리", () => {
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      Priority: { type: "select", select: null },
    });

    expect(client.extractProperties(page).Priority).toBeNull();
  });

  it("multi_select 속성 추출", () => {
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      Tags: {
        type: "multi_select",
        multi_select: [{ name: "tag1" }, { name: "tag2" }],
      },
    });

    expect(client.extractProperties(page).Tags).toEqual(["tag1", "tag2"]);
  });

  it("checkbox 속성 추출", () => {
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      Done: { type: "checkbox", checkbox: true },
    });

    expect(client.extractProperties(page).Done).toBe(true);
  });

  it("url 속성 추출", () => {
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      Link: { type: "url", url: "https://example.com" },
    });

    expect(client.extractProperties(page).Link).toBe("https://example.com");
  });

  it("email 속성 추출", () => {
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      Email: { type: "email", email: "test@example.com" },
    });

    expect(client.extractProperties(page).Email).toBe("test@example.com");
  });

  it("date 속성 추출", () => {
    const dateObj = { start: "2026-01-01", end: null };
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      Due: { type: "date", date: dateObj },
    });

    expect(client.extractProperties(page).Due).toEqual(dateObj);
  });

  it("phone_number 속성 추출", () => {
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      Phone: { type: "phone_number", phone_number: "010-1234-5678" },
    });

    expect(client.extractProperties(page).Phone).toBe("010-1234-5678");
  });

  it("status 속성 추출", () => {
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      Status: { type: "status", status: { name: "In Progress" } },
    });
    expect(client.extractProperties(page).Status).toBe("In Progress");
  });

  it("status null 처리", () => {
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      Status: { type: "status", status: null },
    });
    expect(client.extractProperties(page).Status).toBeNull();
  });

  it("created_time 속성 추출", () => {
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      Created: { type: "created_time", created_time: "2026-01-15T09:00:00.000Z" },
    });
    expect(client.extractProperties(page).Created).toBe("2026-01-15T09:00:00.000Z");
  });

  it("last_edited_time 속성 추출", () => {
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      Edited: { type: "last_edited_time", last_edited_time: "2026-05-10T12:30:00.000Z" },
    });
    expect(client.extractProperties(page).Edited).toBe("2026-05-10T12:30:00.000Z");
  });

  it("people 속성 추출", () => {
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      Assignees: {
        type: "people",
        people: [
          { id: "user-1", name: "Alice" },
          { id: "user-2", name: "Bob" },
        ],
      },
    });
    expect(client.extractProperties(page).Assignees).toEqual(["Alice", "Bob"]);
  });

  it("people name 없으면 id 사용", () => {
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      Assignees: {
        type: "people",
        people: [{ id: "user-1" }],
      },
    });
    expect(client.extractProperties(page).Assignees).toEqual(["user-1"]);
  });

  it("files 속성 추출", () => {
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      Attachments: {
        type: "files",
        files: [
          { name: "doc.pdf", type: "file", file: { url: "https://s3.example.com/doc.pdf" } },
          {
            name: "photo.png",
            type: "external",
            external: { url: "https://example.com/photo.png" },
          },
        ],
      },
    });
    const result = client.extractProperties(page).Attachments as any[];
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("doc.pdf");
    expect(result[0].url).toBe("https://s3.example.com/doc.pdf");
    expect(result[1].name).toBe("photo.png");
    expect(result[1].url).toBe("https://example.com/photo.png");
  });

  it("formula 속성 추출 (string)", () => {
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      Formula: { type: "formula", formula: { type: "string", string: "hello" } },
    });
    expect(client.extractProperties(page).Formula).toBe("hello");
  });

  it("formula 속성 추출 (number)", () => {
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      Formula: { type: "formula", formula: { type: "number", number: 42 } },
    });
    expect(client.extractProperties(page).Formula).toBe(42);
  });

  it("relation 속성 추출", () => {
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      Related: {
        type: "relation",
        relation: [{ id: "page-a" }, { id: "page-b" }],
      },
    });
    expect(client.extractProperties(page).Related).toEqual(["page-a", "page-b"]);
  });

  it("rollup 속성 추출 (number)", () => {
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      Sum: { type: "rollup", rollup: { type: "number", number: 100 } },
    });
    expect(client.extractProperties(page).Sum).toBe(100);
  });

  it("unique_id 속성 추출", () => {
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      ID: { type: "unique_id", unique_id: { prefix: "TASK", number: 42 } },
    });
    expect(client.extractProperties(page).ID).toBe("TASK-42");
  });

  it("unique_id prefix 없으면 number만 반환", () => {
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      ID: { type: "unique_id", unique_id: { prefix: null, number: 7 } },
    });
    expect(client.extractProperties(page).ID).toBe("7");
  });

  it("지원하지 않는 타입은 null 반환", () => {
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      Unknown: { type: "some_future_type", some_future_type: "data" },
    });
    expect(client.extractProperties(page).Unknown).toBeNull();
  });
});

describe("NotionClient - getInternalClient", () => {
  it("내부 Client 인스턴스 반환", () => {
    const client = createClient();
    const internal = client.getInternalClient();

    expect(internal).toBeDefined();
    expect(typeof internal.pages).toBe("object");
  });
});
