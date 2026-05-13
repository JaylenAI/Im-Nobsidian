import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "@notionhq/client";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";

const TOKEN = process.env["NOTION_TOKEN"];
const ROOT_PAGE_ID = process.env["NOTION_ROOT_PAGE_ID"];

const SKIP = !TOKEN || !ROOT_PAGE_ID;

describe.skipIf(SKIP)("Notion API 연결 테스트", () => {
  let client: Client;

  beforeAll(() => {
    client = new Client({ auth: TOKEN });
  });

  it("인증 성공 (현재 사용자 조회)", async () => {
    const user = await client.users.me({});
    expect(user).toBeDefined();
    expect(user.type).toBe("bot");
  });

  it("루트 페이지 접근 가능", async () => {
    const page = (await client.pages.retrieve({ page_id: ROOT_PAGE_ID! })) as PageObjectResponse;
    expect(page.id).toBeDefined();
    expect(page.archived).toBe(false);

    const title = extractTitle(page);
    console.log(`루트 페이지: "${title}" (${page.id})`);
  });

  it("루트 페이지 하위 블록 조회", async () => {
    const blocks = await client.blocks.children.list({ block_id: ROOT_PAGE_ID! });
    console.log(`하위 블록 수: ${blocks.results.length}`);
    expect(blocks).toBeDefined();
  });

  it("검색 API 동작", async () => {
    const result = await client.search({
      page_size: 5,
      filter: { property: "object", value: "page" },
    });
    console.log(`검색 결과: ${result.results.length}개 페이지`);
    expect(result.results).toBeDefined();
  });

  it("테스트 페이지 생성 → 수정 → 삭제", async () => {
    const created = (await client.pages.create({
      parent: { page_id: ROOT_PAGE_ID! },
      properties: {
        title: { title: [{ text: { content: "[E2E Test] 자동 생성 페이지" } }] },
      },
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              {
                type: "text",
                text: { content: "이 페이지는 E2E 테스트에서 자동 생성되었습니다." },
              },
            ],
          },
        },
        {
          object: "block",
          type: "heading_2",
          heading_2: {
            rich_text: [{ type: "text", text: { content: "테스트 제목" } }],
          },
        },
        {
          object: "block",
          type: "bulleted_list_item",
          bulleted_list_item: {
            rich_text: [{ type: "text", text: { content: "항목 1" } }],
          },
        },
        {
          object: "block",
          type: "bulleted_list_item",
          bulleted_list_item: {
            rich_text: [{ type: "text", text: { content: "항목 2" } }],
          },
        },
      ],
    })) as PageObjectResponse;

    expect(created.id).toBeDefined();
    console.log(`생성된 테스트 페이지: ${created.id}`);

    const blocks = await client.blocks.children.list({ block_id: created.id });
    expect(blocks.results.length).toBe(4);

    await client.pages.update({
      page_id: created.id,
      archived: true,
    });
    console.log("테스트 페이지 아카이브 완료");

    const archived = (await client.pages.retrieve({ page_id: created.id })) as PageObjectResponse;
    expect(archived.archived).toBe(true);
  });
});

function extractTitle(page: PageObjectResponse): string {
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title" && "title" in prop) {
      const titleArr = prop.title as Array<{ plain_text?: string }>;
      if (titleArr[0]?.plain_text) return titleArr[0].plain_text;
    }
  }
  return "(제목 없음)";
}
