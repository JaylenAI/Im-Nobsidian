/**
 * 요청 간격 (P10) — 동시 칸이 여럿이어도 요청이 나가는 시각은 `rateLimitIntervalMs` 만큼 벌어진다.
 *
 * 예전에는 칸마다 마지막 요청 시각을 같이 읽고 같이 잔 뒤 한꺼번에 나갔다 — 기본값(칸 3 · 350ms)이 초당 3회가
 * 아니라 8회 남짓이 되어, 1,000 노트 첫 push 가 429 를 거듭 맞고 Retry-After 40초를 기다렸다(실 Notion 실측).
 */
import { describe, it, expect, vi } from "vitest";
import { NotionClient } from "../../src/notion/client.js";

function clientWith(
  options: { concurrency: number; rateLimitIntervalMs: number },
  retrieve: (pageId: string) => Promise<unknown>,
) {
  const client = new NotionClient({
    token: "ntn_test_fake_token",
    maxRetries: 2,
    retryBaseDelayMs: 5,
    ...options,
  });
  (client as unknown as { client: { pages: unknown } }).client.pages = {
    retrieve: vi.fn(({ page_id }: { page_id: string }) => retrieve(page_id)),
  };
  return client;
}

describe("요청 간격 (P10)", () => {
  it("동시 칸 3 · 간격 40ms — 아홉 요청이 여덟 간격에 걸쳐 나간다", async () => {
    const started: number[] = [];
    const client = clientWith({ concurrency: 3, rateLimitIntervalMs: 40 }, async (id) => {
      started.push(performance.now());
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { id };
    });

    await Promise.all(Array.from({ length: 9 }, (_, i) => client.getPage(`p${i}`)));

    expect(started).toHaveLength(9);
    // 아홉 요청은 여덟 간격(320ms)에 걸쳐 나간다 — 옛 코드는 셋씩 몰려 80ms 남짓에 다 나갔다. 낱낱의 간격은
    // 보지 않는다: 시험이 몰려 도는 동안 이벤트 루프가 밀리면 한 요청의 시작 기록이 늦어져 간격 하나가 좁아 보인다.
    expect(Math.max(...started) - Math.min(...started)).toBeGreaterThanOrEqual(8 * 40 - 10);
  });

  it("한 칸이 429 를 맞으면 이미 줄 선 다른 칸도 쿨다운이 끝난 뒤에 나간다", async () => {
    const started: Array<{ id: string; at: number }> = [];
    let limited = false;
    const client = clientWith({ concurrency: 3, rateLimitIntervalMs: 20 }, async (id) => {
      started.push({ id, at: performance.now() });
      if (id === "p0" && !limited) {
        limited = true;
        throw Object.assign(new Error("rate limited"), {
          status: 429,
          code: "rate_limited",
          headers: { "retry-after": "0.2" },
        });
      }
      return { id };
    });

    const begin = performance.now();
    await Promise.all(["p0", "p1", "p2", "p3"].map((id) => client.getPage(id)));

    const limitedAt = started[0]!.at;
    // 429 뒤에 나간 요청은 모두 Retry-After(200ms) 뒤다 — p1 은 429 앞에 이미 나갔을 수 있다
    const after = started.filter((s) => s.at > limitedAt + 1);
    expect(after.length).toBeGreaterThanOrEqual(3);
    for (const s of after.filter((s) => s.id !== "p1")) {
      expect(s.at - limitedAt).toBeGreaterThanOrEqual(195);
    }
    expect(performance.now() - begin).toBeLessThan(2000);
  });
});
