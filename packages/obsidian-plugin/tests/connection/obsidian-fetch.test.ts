/**
 * Obsidian 의 requestUrl 로 보내는 fetch — 첨부를 올리는 multipart 본문(P8 실측: 플러그인의 첨부 · 그림 업로드가 모두
 * 「body.file should be defined」 로 거절됐다).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sent: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
vi.mock("obsidian", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestUrl: vi.fn(async (request: (typeof sent)[number]) => {
    sent.push(request);
    return {
      status: 200,
      json: { ok: true },
      headers: { "content-type": "application/json" },
      arrayBuffer: new ArrayBuffer(0),
    };
  }),
}));

const { obsidianFetch } = await import("../../src/connection/connection-engine.js");

beforeEach(() => {
  sent.splice(0);
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
});
