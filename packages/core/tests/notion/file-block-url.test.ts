/**
 * 파일 블록 주소 조회 — 「없음」 과 「읽지 못함」 을 가른다(끝 점검 2026-10-21).
 *
 * 예전에는 모든 실패를 null 로 삼켜, 일시 오류로 받지 못한 첨부도 이유 없이 Notion 링크로 남았다.
 * 이제 블록이 없거나 볼 수 없을 때만 null 이고, 그 밖의 실패는 던져 호출처가 이유를 남긴다.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NotionClient } from "../../src/notion/client.js";

describe("getFileBlockUrl", () => {
  let client: NotionClient;
  let internal: { blocks: { retrieve: (args: { block_id: string }) => Promise<unknown> } };

  beforeEach(() => {
    client = new NotionClient({ token: "offline-test", rateLimitIntervalMs: 0, maxRetries: 0 });
    internal = client.getInternalClient() as unknown as typeof internal;
  });

  it.each([
    ["권한 없음(403)", { status: 403, code: "restricted_resource" }],
    ["없음(404)", { status: 404, code: "object_not_found" }],
  ])("%s 이면 null", async (_name, shape) => {
    vi.spyOn(internal.blocks, "retrieve").mockRejectedValue(
      Object.assign(new Error("거절"), shape) as never,
    );
    expect(await client.getFileBlockUrl("block-1")).toBeNull();
  });

  it("일시 오류(503)는 null 로 바꾸지 않고 던진다", async () => {
    vi.spyOn(internal.blocks, "retrieve").mockRejectedValue(
      Object.assign(new Error("service unavailable"), { status: 503 }) as never,
    );
    await expect(client.getFileBlockUrl("block-1")).rejects.toThrow("service unavailable");
  });
});
