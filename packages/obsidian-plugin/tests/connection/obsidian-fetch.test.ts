/**
 * Obsidian 의 requestUrl 로 보내는 fetch — 첨부를 올리는 multipart 본문(P8 실측: 플러그인의 첨부 · 그림 업로드가 모두
 * 「body.file should be defined」 로 거절됐다).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sent: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
// 다음 응답 — 시험이 바꾼다. 없으면 JSON `{"ok":true}`.
let reply: { status: number; contentType: string; text: string } | null = null;
vi.mock("obsidian", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestUrl: vi.fn(async (request: (typeof sent)[number]) => {
    sent.push(request);
    const { status, contentType, text } = reply ?? {
      status: 200,
      contentType: "application/json",
      text: '{"ok":true}',
    };
    return {
      status,
      headers: { "content-type": contentType },
      arrayBuffer: new TextEncoder().encode(text).buffer,
      text,
      // requestUrl 의 json 은 글을 JSON 으로 읽는다 — JSON 이 아니면 던진다.
      get json() {
        return JSON.parse(text);
      },
    };
  }),
}));

const { obsidianFetch } = await import("../../src/connection/connection-engine.js");

beforeEach(() => {
  sent.splice(0);
  reply = null;
});

describe("obsidianFetch", () => {
  it("FormData 는 multipart 바이트와 경계가 든 content-type 으로 보낸다", async () => {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }),
      "그림.png",
    );

    const response = await obsidianFetch("https://api.notion.com/v1/file_uploads/x/send", {
      method: "POST",
      headers: { Authorization: "Bearer t", "Notion-Version": "2025-09-03" },
      body: form,
    });

    expect(response.status).toBe(200);
    const [request] = sent;
    expect(request!.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(request!.headers.Authorization).toBe("Bearer t");
    expect(request!.body).toBeInstanceOf(ArrayBuffer);
    const text = new TextDecoder().decode(request!.body as ArrayBuffer);
    const boundary = request!.headers["content-type"]!.split("boundary=")[1]!;
    expect(text).toContain(`--${boundary}`);
    expect(text).toContain('name="file"');
    expect(text).toContain("Content-Type: image/png");
  });

  it("FormData 에는 SDK 가 남긴 content-type 을 버리고 경계가 든 것을 쓴다", async () => {
    const form = new FormData();
    form.append("part_number", "1");
    await obsidianFetch("https://api.notion.com/v1/file_uploads/x/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: form,
    });
    expect(Object.keys(sent[0]!.headers).filter((k) => k.toLowerCase() === "content-type")).toEqual(
      ["content-type"],
    );
    expect(sent[0]!.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
  });

  it("JSON 글 본문은 그대로 보낸다", async () => {
    await obsidianFetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
    });
    expect(sent[0]).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
    });
  });

  it("JSON 응답은 json() 으로 읽는다", async () => {
    const response = await obsidianFetch("https://api.notion.com/v1/pages/x");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("글 첨부(text/*)는 받은 바이트 그대로 — JSON 으로 읽지 않는다", async () => {
    reply = { status: 200, contentType: "text/plain; charset=utf-8", text: "첨부 글\n" };
    const text = await obsidianFetch("https://prod-files-secure.s3.amazonaws.com/x/memo.txt");
    expect(await text.text()).toBe("첨부 글\n");
    reply = { status: 200, contentType: "text/html", text: "<!doctype html><p>차트</p>\n" };
    const html = await obsidianFetch("https://prod-files-secure.s3.amazonaws.com/x/chart.html");
    expect(new TextDecoder().decode(await html.arrayBuffer())).toBe("<!doctype html><p>차트</p>\n");
  });

  it("본문이 없는 응답(204)도 Response 로 돌려준다", async () => {
    reply = { status: 204, contentType: "", text: "" };
    const response = await obsidianFetch("https://api.notion.com/v1/blocks/x", {
      method: "DELETE",
    });
    expect(response.status).toBe(204);
  });
});
