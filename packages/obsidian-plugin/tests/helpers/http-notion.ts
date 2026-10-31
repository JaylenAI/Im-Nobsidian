/**
 * HTTP 로 받는 메모리 Notion — 플러그인이 `requestUrl` 로 보내는 요청을 받는다(P11 모바일 시험). 페이지 · 자식 목록 ·
 * Markdown 본문만 안다. 모르는 요청은 적어 두고 400 을 준다 — 시험이 그것을 본다.
 */
import type { RequestUrlParam, RequestUrlResponse } from "./mobile-host.js";

interface FakePage {
  id: string;
  parent: string;
  title: string;
  markdown: string;
  archived: boolean;
  edited: string;
}

const dashed = (id: string): string => {
  const hex = id.replace(/-/g, "");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export function httpNotion(rootId: string) {
  const root = dashed(rootId);
  const pages = new Map<string, FakePage>();
  const unknown: string[] = [];
  let clock = Date.parse("2026-10-31T00:00:00.000Z");
  let serial = 0;
  const now = () => new Date((clock += 60_000)).toISOString();
  pages.set(root, {
    id: root,
    parent: "workspace",
    title: "루트",
    markdown: "",
    archived: false,
    edited: now(),
  });

  const pageObject = (page: FakePage) => ({
    object: "page",
    id: page.id,
    created_time: page.edited,
    last_edited_time: page.edited,
    archived: page.archived,
    in_trash: page.archived,
    icon: null,
    cover: null,
    url: `https://www.notion.so/${page.id.replace(/-/g, "")}`,
    parent:
      page.parent === "workspace"
        ? { type: "workspace", workspace: true }
        : { type: "page_id", page_id: page.parent },
    properties: {
      title: {
        id: "title",
        type: "title",
        title: [
          {
            type: "text",
            text: { content: page.title, link: null },
            plain_text: page.title,
            annotations: {},
            href: null,
          },
        ],
      },
    },
  });
  const childBlock = (page: FakePage) => ({
    object: "block",
    id: page.id,
    type: "child_page",
    child_page: { title: page.title },
    has_children: false,
    archived: page.archived,
    in_trash: page.archived,
    created_time: page.edited,
    last_edited_time: page.edited,
    parent: { type: "page_id", page_id: page.parent },
  });
  const markdownObject = (page: FakePage) => ({
    object: "page_markdown",
    id: page.id,
    markdown: page.markdown,
    truncated: false,
    unknown_block_ids: [],
  });
  const ok = (json: unknown, status = 200): RequestUrlResponse => {
    const text = JSON.stringify(json);
    return {
      status,
      headers: { "content-type": "application/json" },
      text,
      json,
      arrayBuffer: new TextEncoder().encode(text).buffer as ArrayBuffer,
    };
  };
  const fail = (status: number, code: string, message: string) =>
    ok({ object: "error", status, code, message }, status);
  const find = (id: string) => pages.get(dashed(id));

  async function requestUrl(param: RequestUrlParam): Promise<RequestUrlResponse> {
    const url = new URL(param.url);
    const method = (param.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/v1\//, "");
    const body =
      typeof param.body === "string" && param.body !== ""
        ? (JSON.parse(param.body) as Record<string, any>)
        : {};
    let match: RegExpMatchArray | null;
    if (method === "POST" && path === "pages") {
      const parent = dashed(body.parent.page_id);
      const title = body.properties.title.title.map((t: any) => t.text.content).join("");
      const id = dashed((++serial).toString(16).padStart(32, "a"));
      const page = {
        id,
        parent,
        title,
        markdown: body.markdown ?? "",
        archived: false,
        edited: now(),
      };
      pages.set(id, page);
      return ok(pageObject(page));
    }
    if ((match = path.match(/^pages\/([0-9a-f-]+)\/markdown$/))) {
      const page = find(match[1]!);
      if (!page) return fail(404, "object_not_found", "no page");
      if (method === "GET") return ok(markdownObject(page));
      if (method === "PATCH" && body.type === "replace_content") {
        page.markdown = body.replace_content.new_str;
        page.edited = now();
        return ok(markdownObject(page));
      }
    }
    if ((match = path.match(/^pages\/([0-9a-f-]+)$/))) {
      const page = find(match[1]!);
      if (!page) return fail(404, "object_not_found", "no page");
      if (method === "GET") return ok(pageObject(page));
      if (method === "PATCH") {
        if (typeof body.archived === "boolean") page.archived = body.archived;
        if (typeof body.in_trash === "boolean") page.archived = body.in_trash;
        if (body.properties?.title)
          page.title = body.properties.title.title.map((t: any) => t.text.content).join("");
        page.edited = now();
        return ok(pageObject(page));
      }
    }
    if ((match = path.match(/^blocks\/([0-9a-f-]+)\/children$/)) && method === "GET") {
      const parent = find(match[1]!);
      if (!parent) return fail(404, "object_not_found", "no block");
      const children = [...pages.values()].filter(
        (page) => page.parent === parent.id && !page.archived,
      );
      return ok({
        object: "list",
        results: children.map(childBlock),
        has_more: false,
        next_cursor: null,
        type: "block",
        block: {},
      });
    }
    if ((match = path.match(/^blocks\/([0-9a-f-]+)$/)) && method === "GET") {
      const page = find(match[1]!);
      if (!page) return fail(404, "object_not_found", "no block");
      return ok(childBlock(page));
    }
    if (path === "users/me") return ok({ object: "user", id: "bot", type: "bot", bot: {} });
    unknown.push(`${method} ${path}`);
    return fail(400, "invalid_request", `fake Notion: ${method} ${path}`);
  }

  return {
    requestUrl,
    pages,
    unknown,
    root,
    children: (parent = root) =>
      [...pages.values()].filter((page) => page.parent === parent && !page.archived),
    /** Notion 에서 손으로 고친 것처럼. */
    edit(id: string, markdown: string) {
      const page = find(id)!;
      page.markdown = markdown;
      page.edited = now();
    },
  };
}
