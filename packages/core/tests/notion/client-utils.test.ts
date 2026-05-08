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

  it("지원하지 않는 타입은 null 반환", () => {
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      Formula: { type: "formula", formula: { type: "string", string: "hello" } },
    });

    expect(client.extractProperties(page).Formula).toBeNull();
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
