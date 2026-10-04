/**
 * F-02 — Markdown API 는 사용자 멘션을 이름 없이 내보낸다(`<mention-user url="user://…"/>`). 보일
 * 이름은 `users.retrieve` 로 따로 묻는다. 같은 사람은 한 번만 묻고, 읽지 못한 사람은 이유를 남기고
 * 맵에서 뺀다 — 그 멘션은 정해 둔 글로 보이고 멘션 자체는 id 로 남는다.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { NotionClient } from "../../src/notion/client.js";
import { getLogger, setLogger } from "../../src/utils/logger.js";

const previous = getLogger();
afterEach(() => setLogger(previous));

function makeClient() {
  const client = new NotionClient({
    token: "ntn_test_fake_token",
    concurrency: 1,
    rateLimitIntervalMs: 0,
    maxRetries: 0,
  });
  const retrieve = vi
    .spyOn(client.getInternalClient().users, "retrieve")
    .mockImplementation(async ({ user_id }) => {
      if (user_id === "u-gone") throw new Error("Could not find user with ID: u-gone.");
      return { object: "user", id: user_id, name: `이름-${user_id}` } as never;
    });
  return { client, retrieve };
}

describe("NotionClient.getUserNames", () => {
  it("물은 사용자의 이름을 돌려주고 같은 사용자는 다시 묻지 않는다", async () => {
    const { client, retrieve } = makeClient();

    const first = await client.getUserNames(["u-1", "u-2", "u-1"]);
    const second = await client.getUserNames(["u-2"]);

    expect([...first]).toEqual([
      ["u-1", "이름-u-1"],
      ["u-2", "이름-u-2"],
    ]);
    expect([...second]).toEqual([["u-2", "이름-u-2"]]);
    expect(retrieve).toHaveBeenCalledTimes(2);
  });

  it("읽지 못한 사용자는 이유를 남기고 빼며, 다시 묻지 않는다", async () => {
    const warn = vi.fn();
    setLogger({ ...previous, warn });
    const { client, retrieve } = makeClient();

    const names = await client.getUserNames(["u-gone", "u-1"]);
    await client.getUserNames(["u-gone"]);

    expect([...names]).toEqual([["u-1", "이름-u-1"]]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("Could not find user");
    expect(retrieve).toHaveBeenCalledTimes(2);
  });
});
