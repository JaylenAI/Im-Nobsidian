/**
 * Notion 확인(P8) — 토큰이 맞는지, 루트 페이지 · DB 를 읽을 수 있는지 첫 동기화 전에 알린다. 고칠 곳을 말한다.
 */
import { describe, it, expect, vi } from "vitest";
import { checkNotionAccess } from "../../src/notion/access-check.js";
import type { NotionClient } from "../../src/notion/client.js";

function apiError(status: number, code: string): Error {
  return Object.assign(new Error(`Notion ${status} ${code}`), { status, code });
}

function page(title: string, inTrash = false) {
  return {
    in_trash: inTrash,
    properties: { title: { type: "title", title: [{ plain_text: title }] } },
  };
}

function client(
  overrides: Partial<Record<"getBotUserId" | "getPage" | "getDatabaseTitle", unknown>>,
) {
  return {
    getBotUserId: vi.fn().mockResolvedValue("bot"),
    getPage: vi.fn().mockResolvedValue(page("홈")),
    getDatabaseTitle: vi.fn().mockResolvedValue("작업"),
    ...overrides,
  } as unknown as NotionClient;
}

describe("checkNotionAccess", () => {
  it("토큰 · 루트 페이지 · DB 를 읽으면 읽은 것을 말한다", async () => {
    expect(await checkNotionAccess(client({}), { rootPageId: "r", databaseId: "d" })).toEqual({
      ok: true,
      lines: [
        "토큰이 맞습니다.",
        "루트 페이지 「홈」 — 읽을 수 있습니다.",
        "DB 「작업」 — 읽을 수 있습니다.",
      ],
    });
  });

  it("토큰이 틀리면 거기서 멈추고 고칠 곳을 말한다", async () => {
    const notion = client({
      getBotUserId: vi.fn().mockRejectedValue(apiError(401, "unauthorized")),
    });
    const result = await checkNotionAccess(notion, { rootPageId: "r" });
    expect(result.ok).toBe(false);
    expect(result.lines).toEqual([expect.stringContaining("토큰이 맞지 않습니다")]);
    expect(notion.getPage).not.toHaveBeenCalled();
  });

  it("닿지 못하면 「토큰이 틀렸다」 가 아니라 받은 까닭을 그대로", async () => {
    const result = await checkNotionAccess(
      client({
        getBotUserId: vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND api.notion.com")),
      }),
      { rootPageId: "r" },
    );
    expect(result).toEqual({
      ok: false,
      lines: ["Notion 에 닿지 못했습니다 — getaddrinfo ENOTFOUND api.notion.com"],
    });
  });

  it("공유하지 않은 루트 페이지 · 권한 없는 DB · 휴지통의 루트 페이지를 가른다", async () => {
    const unshared = await checkNotionAccess(
      client({
        getPage: vi.fn().mockRejectedValue(apiError(404, "object_not_found")),
        getDatabaseTitle: vi.fn().mockRejectedValue(apiError(403, "restricted_resource")),
      }),
      { rootPageId: "r", databaseId: "d" },
    );
    expect(unshared.ok).toBe(false);
    expect(unshared.lines).toEqual([
      "토큰이 맞습니다.",
      expect.stringContaining(
        "루트 페이지를 읽지 못했습니다 — 없거나 이 통합에 공유하지 않았습니다",
      ),
      expect.stringContaining("이 통합에 DB 를 읽는 권한이 없습니다"),
    ]);

    const trashed = await checkNotionAccess(
      client({ getPage: vi.fn().mockResolvedValue(page("옛 홈", true)) }),
      {
        rootPageId: "r",
      },
    );
    expect(trashed).toEqual({
      ok: false,
      lines: [
        "토큰이 맞습니다.",
        "루트 페이지 「옛 홈」 — Notion 휴지통에 있습니다. 꺼내거나 다른 페이지를 고르세요.",
      ],
    });
  });

  it("루트 페이지를 정하지 않았으면 토큰만 본다", async () => {
    const notion = client({});
    expect(await checkNotionAccess(notion, { rootPageId: "" })).toEqual({
      ok: true,
      lines: ["토큰이 맞습니다."],
    });
    expect(notion.getPage).not.toHaveBeenCalled();
  });
});
