/**
 * N-04 — Notion 은 markdown 으로 페이지 · 행을 만들 때(`pages.create`) 맨 앞 `# H1` 을 버린다.
 * 가운데 H1 · 맨 앞 `##` 는 남기고, 본문 교체(`replace_content`)는 맨 앞 H1 도 남긴다(2026-09-27
 * 실측). 그래서 만든 뒤 H1 으로 시작하는 본문만 한 번 더 보낸다 — 나머지는 요청을 더하지 않는다.
 */
import { describe, it, expect, vi } from "vitest";
import { NotionClient, startsWithHeading1 } from "../../src/notion/client.js";

describe("startsWithHeading1 — Notion 이 만들며 버리는 맨 앞 H1", () => {
  it.each([
    ["# 제목\n\n본문", true],
    ["\n\n# 제목", true],
    ["  \n# 제목", true],
    ["   # 들여쓴 제목", true],
    ["#\t탭 제목", true],
    ["# 제목\r\n본문", true],
  ])("%j → H1 으로 시작한다", (markdown, expected) => {
    expect(startsWithHeading1(markdown)).toBe(expected);
  });

  it.each([
    ["## 부제목", false],
    ["#태그 본문", false],
    ["본문\n\n# 가운데 제목", false],
    ["    # 네 칸 들여쓰기는 코드", false],
    ["# ", false],
    ["", false],
    ["\n\n", false],
  ])("%j → H1 으로 시작하지 않는다", (markdown, expected) => {
    expect(startsWithHeading1(markdown)).toBe(expected);
  });
});

describe("NotionClient.restoreLeadingHeading", () => {
  const makeClient = () => {
    const client = new NotionClient({ token: "ntn_test_fake_token", concurrency: 1 });
    const replace = vi
      .spyOn(client, "replacePageMarkdown")
      .mockResolvedValue({ markdown: "", truncated: false, unknown_block_ids: [] } as never);
    return { client, replace };
  };

  it("H1 으로 시작하면 같은 markdown 으로 본문을 한 번 바꾼다", async () => {
    const { client, replace } = makeClient();

    await expect(client.restoreLeadingHeading("page-1", "# 제목\n\n본문")).resolves.toBe(true);

    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("page-1", "# 제목\n\n본문");
  });

  it("H1 으로 시작하지 않으면 요청하지 않는다", async () => {
    const { client, replace } = makeClient();

    await expect(client.restoreLeadingHeading("page-1", "## 부제목\n\n본문")).resolves.toBe(false);
    await expect(client.restoreLeadingHeading("page-1", "본문\n\n# 가운데")).resolves.toBe(false);

    expect(replace).not.toHaveBeenCalled();
  });

  it("본문 교체가 실패하면 그 오류를 그대로 던진다", async () => {
    const { client, replace } = makeClient();
    replace.mockRejectedValueOnce(new Error("Notion 500"));

    await expect(client.restoreLeadingHeading("page-1", "# 제목")).rejects.toThrow("Notion 500");
  });
});
