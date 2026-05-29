import { describe, it, expect, vi } from "vitest";
import { NotionClient, isNotionObjectNotFound } from "../../src/notion/client.js";

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

  it("빈 제목 행: title이 배열 아닌 빈 객체({})여도 크래시 없이 기본값(결함7)", () => {
    // Notion 은 제목이 빈 DB 행에서 title 을 빈 객체로 돌려주기도 한다.
    // 가드 없이 .map 을 호출하면 "title.map is not a function" 으로 행이 통째 손실됐다.
    const page = createMockPage({
      Category: { type: "title", title: {} },
    });

    expect(() => client.extractTitle(page)).not.toThrow();
    expect(client.extractTitle(page)).toBe("제목 없음");
  });

  it("비배열 title 이어도 뒤따르는 정상 title 속성을 찾아낸다(결함7)", () => {
    const page = createMockPage({
      Broken: { type: "title", title: {} },
      Name: { type: "title", title: [{ plain_text: "복구된 제목" }] },
    });

    expect(client.extractTitle(page)).toBe("복구된 제목");
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

  it("date 속성 추출 (end 없음)", () => {
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      Due: { type: "date", date: { start: "2026-01-01", end: null } },
    });

    expect(client.extractProperties(page).Due).toBe("2026-01-01");
  });

  it("date 속성 추출 (end 있음)", () => {
    const page = createMockPage({
      title: { type: "title", title: [{ plain_text: "T" }] },
      Due: { type: "date", date: { start: "2026-01-01", end: "2026-12-31" } },
    });

    expect(client.extractProperties(page).Due).toEqual({ start: "2026-01-01", end: "2026-12-31" });
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
    // files 는 Obsidian Bases image: 가 렌더할 수 있도록 URL 문자열 배열로 직렬화한다
    // (이전 [{name,url}] 객체 배열은 카드 커버로 렌더되지 않음).
    const result = client.extractProperties(page).Attachments as string[];
    expect(result).toEqual(["https://s3.example.com/doc.pdf", "https://example.com/photo.png"]);
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

describe("NotionClient - extractCover", () => {
  const client = createClient();

  it("file 타입 커버 추출", () => {
    const page = createMockPage({});
    (page as any).cover = {
      type: "file",
      file: { url: "https://s3.example.com/cover.jpg", expiry_time: "2026-05-18T12:00:00.000Z" },
    };

    const cover = client.extractCover(page);
    expect(cover).toEqual({
      type: "file",
      url: "https://s3.example.com/cover.jpg",
      expiryTime: "2026-05-18T12:00:00.000Z",
    });
  });

  it("external 타입 커버 추출", () => {
    const page = createMockPage({});
    (page as any).cover = {
      type: "external",
      external: { url: "https://images.unsplash.com/photo.jpg" },
    };

    const cover = client.extractCover(page);
    expect(cover).toEqual({
      type: "external",
      url: "https://images.unsplash.com/photo.jpg",
    });
  });

  it("커버 없으면 null 반환", () => {
    const page = createMockPage({});
    expect(client.extractCover(page)).toBeNull();
  });
});

describe("NotionClient - extractIcon", () => {
  const client = createClient();

  it("이모지 아이콘 추출", () => {
    const page = createMockPage({});
    (page as any).icon = { type: "emoji", emoji: "🚀" };

    const icon = client.extractIcon(page);
    expect(icon).toEqual({ type: "emoji", value: "🚀" });
  });

  it("external 아이콘 추출", () => {
    const page = createMockPage({});
    (page as any).icon = {
      type: "external",
      external: { url: "https://example.com/icon.png" },
    };

    const icon = client.extractIcon(page);
    expect(icon).toEqual({ type: "external", value: "https://example.com/icon.png" });
  });

  it("file 아이콘 추출", () => {
    const page = createMockPage({});
    (page as any).icon = {
      type: "file",
      file: { url: "https://s3.example.com/icon.png", expiry_time: "2026-05-18T12:00:00.000Z" },
    };

    const icon = client.extractIcon(page);
    expect(icon).toEqual({ type: "file", value: "https://s3.example.com/icon.png" });
  });

  it("native 아이콘 추출", () => {
    const page = createMockPage({});
    (page as any).icon = {
      type: "icon",
      icon: { name: "pizza", color: "blue" },
    };

    const icon = client.extractIcon(page);
    expect(icon).toEqual({ type: "icon", value: "pizza", color: "blue" });
  });

  it("아이콘 없으면 null 반환", () => {
    const page = createMockPage({});
    expect(client.extractIcon(page)).toBeNull();
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

describe("NotionClient - getChildPages: 휴지통/아카이브 페이지 필터링", () => {
  function makeChildPageBlock(id: string) {
    return { id, type: "child_page", has_children: true } as any;
  }
  function makePage(id: string, opts: { archived?: boolean; in_trash?: boolean } = {}) {
    return {
      id,
      last_edited_time: "2026-01-01T00:00:00.000Z",
      parent: { type: "page_id", page_id: "root" },
      archived: opts.archived ?? false,
      in_trash: opts.in_trash ?? false,
      properties: {},
    } as any;
  }

  it("in_trash=true 페이지는 결과에서 제외", async () => {
    const client = createClient();
    vi.spyOn(client as any, "fetchAllChildrenDeep").mockResolvedValue([
      makeChildPageBlock("live-1"),
      makeChildPageBlock("trashed-1"),
      makeChildPageBlock("live-2"),
    ]);
    vi.spyOn(client, "getPage").mockImplementation(async (id: string) => {
      if (id === "trashed-1") return makePage(id, { in_trash: true });
      return makePage(id);
    });

    const pages = await client.getChildPages("root");
    expect(pages.map((p) => p.id)).toEqual(["live-1", "live-2"]);
  });

  it("archived=true 페이지는 결과에서 제외", async () => {
    const client = createClient();
    vi.spyOn(client as any, "fetchAllChildrenDeep").mockResolvedValue([
      makeChildPageBlock("live-1"),
      makeChildPageBlock("archived-1"),
    ]);
    vi.spyOn(client, "getPage").mockImplementation(async (id: string) => {
      if (id === "archived-1") return makePage(id, { archived: true });
      return makePage(id);
    });

    const pages = await client.getChildPages("root");
    expect(pages.map((p) => p.id)).toEqual(["live-1"]);
  });

  it("정상 페이지만 있으면 전부 반환", async () => {
    const client = createClient();
    vi.spyOn(client as any, "fetchAllChildrenDeep").mockResolvedValue([
      makeChildPageBlock("a"),
      makeChildPageBlock("b"),
    ]);
    vi.spyOn(client, "getPage").mockImplementation(async (id: string) => makePage(id));

    const pages = await client.getChildPages("root");
    expect(pages.map((p) => p.id)).toEqual(["a", "b"]);
  });
});

describe("NotionClient - getChildPagesRecursive: 접근 불가 서브트리 graceful skip", () => {
  function makePage(id: string) {
    return {
      id,
      last_edited_time: "2026-01-01T00:00:00.000Z",
      parent: { type: "page_id", page_id: "root" },
      archived: false,
      in_trash: false,
      properties: {},
    } as any;
  }

  it("한 노드가 throw해도 전체 스캔이 중단되지 않고 형제는 보존", async () => {
    const client = createClient();
    // root → [ok-1, bad-1, ok-2]; bad-1의 하위 스캔은 object_not_found로 throw
    vi.spyOn(client, "getChildPages").mockImplementation(async (id: string) => {
      if (id === "root") return [makePage("ok-1"), makePage("bad-1"), makePage("ok-2")];
      if (id === "bad-1") throw new Error("Could not find block with ID: bad-1");
      return []; // ok-1, ok-2는 리프
    });

    const all = await client.getChildPagesRecursive("root");
    const ids = all.map((p) => p.id).sort();
    expect(ids).toEqual(["bad-1", "ok-1", "ok-2"]); // 3건 모두 수집(bad-1 자체는 포함, 하위만 스킵)
  });
});

describe("isNotionObjectNotFound — 404 권위 판별 (결함9)", () => {
  it("code=object_not_found 면 true", () => {
    expect(isNotionObjectNotFound({ code: "object_not_found", status: 404 })).toBe(true);
  });

  it("status=404 만 있어도 true", () => {
    expect(isNotionObjectNotFound({ status: 404 })).toBe(true);
  });

  it("code=object_not_found 만 있어도 true", () => {
    expect(isNotionObjectNotFound({ code: "object_not_found" })).toBe(true);
  });

  it("실 Error 객체에 code 가 붙은 SDK 에러도 인식", () => {
    const err = Object.assign(new Error("Could not find database"), {
      code: "object_not_found",
      status: 404,
    });
    expect(isNotionObjectNotFound(err)).toBe(true);
  });

  it("검증 오류(validation_error)는 false — 일시/실제 오류와 구분", () => {
    expect(isNotionObjectNotFound({ code: "validation_error", status: 400 })).toBe(false);
  });

  it("rate limit(429)·5xx 는 false — 재시도 대상", () => {
    expect(isNotionObjectNotFound({ status: 429 })).toBe(false);
    expect(isNotionObjectNotFound({ code: "internal_server_error", status: 500 })).toBe(false);
  });

  it("null·undefined·문자열·숫자는 false (방어)", () => {
    expect(isNotionObjectNotFound(null)).toBe(false);
    expect(isNotionObjectNotFound(undefined)).toBe(false);
    expect(isNotionObjectNotFound("object_not_found")).toBe(false);
    expect(isNotionObjectNotFound(404)).toBe(false);
    expect(isNotionObjectNotFound(new Error("network"))).toBe(false);
  });
});

describe("NotionClient.getDatabaseSyncability — 접근성 선판별 (결함9)", () => {
  function stubRetrieve(client: NotionClient, value: unknown): void {
    // 내부 SDK 클라이언트의 databases.retrieve 를 교체해 네트워크 없이 응답을 주입한다.
    (client as any).client.databases.retrieve = vi.fn().mockResolvedValue(value);
  }

  it("data_sources 가 1개 이상이면 queryable=true + 제목 추출", async () => {
    const client = createClient();
    stubRetrieve(client, {
      title: [{ plain_text: "프로덕트 위키" }],
      data_sources: [{ id: "ds-1" }],
    });
    const r = await client.getDatabaseSyncability("db-1");
    expect(r).toEqual({ title: "프로덕트 위키", queryable: true });
  });

  it("data_sources 가 빈 배열이면 queryable=false (링크드/미공유 DB)", async () => {
    const client = createClient();
    stubRetrieve(client, { title: [{ plain_text: "링크드 DB" }], data_sources: [] });
    const r = await client.getDatabaseSyncability("db-2");
    expect(r).toEqual({ title: "링크드 DB", queryable: false });
  });

  it("data_sources 필드 자체가 없으면 queryable=false", async () => {
    const client = createClient();
    stubRetrieve(client, { title: [{ plain_text: "구모델 DB" }] });
    const r = await client.getDatabaseSyncability("db-3");
    expect(r.queryable).toBe(false);
  });

  it("title 이 비배열({})로 와도 크래시 없이 빈 제목 (결함7 계열 방어)", async () => {
    const client = createClient();
    stubRetrieve(client, { title: {}, data_sources: [{ id: "ds-x" }] });
    const r = await client.getDatabaseSyncability("db-4");
    expect(r).toEqual({ title: "", queryable: true });
  });
});
