import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@notionhq/client";
import { markdownToBlocks } from "@tryfabric/martian";
import { NotionToMarkdown } from "notion-to-md";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";

const TOKEN = process.env["NOTION_TOKEN"]!;
const ROOT_PAGE_ID = process.env["NOTION_ROOT_PAGE_ID"]!;
const SKIP = !TOKEN || !ROOT_PAGE_ID;

describe.skipIf(SKIP)("Push/Pull E2E 통합 테스트", { timeout: 30000 }, () => {
  let client: Client;
  let n2m: NotionToMarkdown;
  const createdPageIds: string[] = [];

  beforeAll(() => {
    client = new Client({ auth: TOKEN });
    n2m = new NotionToMarkdown({ notionClient: client });
  });

  afterAll(async () => {
    for (const pageId of createdPageIds) {
      try {
        await client.pages.update({ page_id: pageId, archived: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("마크다운 → Notion 블록 변환 + 업로드 (Push)", async () => {
    const markdown = `# E2E Push 테스트

이 문서는 자동 테스트에서 생성됩니다.

## 기능 목록

- **굵은 텍스트** 지원
- *기울임* 지원
- ~~취소선~~ 지원
- \`인라인 코드\` 지원

### 체크리스트

- [x] 완료된 작업
- [ ] 미완료 작업

## 코드 블록

\`\`\`typescript
interface SyncResult {
  created: number
  updated: number
}
\`\`\`

## 인용

> 어디서 작성하든, 양쪽에서 동일하게.
> — Im-Nobsidian

---

문서 끝.`;

    const blocks = markdownToBlocks(markdown);
    expect(blocks.length).toBeGreaterThan(0);

    const page = (await client.pages.create({
      parent: { page_id: ROOT_PAGE_ID },
      properties: {
        title: { title: [{ text: { content: "[E2E] Push 테스트 문서" } }] },
      },
      children: blocks as never,
    })) as PageObjectResponse;

    createdPageIds.push(page.id);
    console.log(`Push 성공: ${page.id}`);

    const childBlocks = await client.blocks.children.list({ block_id: page.id });
    expect(childBlocks.results.length).toBeGreaterThan(5);
    console.log(`업로드된 블록 수: ${childBlocks.results.length}`);
  });

  it("Notion → 마크다운 변환 (Pull)", async () => {
    const testPage = (await client.pages.create({
      parent: { page_id: ROOT_PAGE_ID },
      properties: {
        title: { title: [{ text: { content: "[E2E] Pull 테스트 문서" } }] },
      },
      children: [
        {
          object: "block",
          type: "heading_1",
          heading_1: { rich_text: [{ type: "text", text: { content: "Pull 테스트" } }] },
        },
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [
              { type: "text", text: { content: "이 페이지를 마크다운으로 변환합니다." } },
            ],
          },
        },
        {
          object: "block",
          type: "bulleted_list_item",
          bulleted_list_item: { rich_text: [{ type: "text", text: { content: "항목 A" } }] },
        },
        {
          object: "block",
          type: "bulleted_list_item",
          bulleted_list_item: { rich_text: [{ type: "text", text: { content: "항목 B" } }] },
        },
        {
          object: "block",
          type: "code",
          code: {
            rich_text: [{ type: "text", text: { content: 'console.log("hello")' } }],
            language: "javascript",
          },
        },
        {
          object: "block",
          type: "quote",
          quote: { rich_text: [{ type: "text", text: { content: "인용문 테스트" } }] },
        },
      ],
    })) as PageObjectResponse;

    createdPageIds.push(testPage.id);

    const mdBlocks = await n2m.pageToMarkdown(testPage.id);
    const result = n2m.toMarkdownString(mdBlocks);
    const markdown = result.parent ?? "";

    console.log("Pull 결과:\n", markdown);

    expect(markdown).toContain("Pull 테스트");
    expect(markdown).toContain("마크다운으로 변환");
    expect(markdown).toContain("항목 A");
    expect(markdown).toContain("항목 B");
    expect(markdown).toContain("console.log");
    expect(markdown).toContain("인용문 테스트");
  });

  it("라운드트립: MD → Notion → MD", async () => {
    const originalMd = `# 라운드트립 테스트

간단한 문단입니다.

- 리스트 1
- 리스트 2
- 리스트 3

> 인용문

---`;

    const blocks = markdownToBlocks(originalMd);

    const page = (await client.pages.create({
      parent: { page_id: ROOT_PAGE_ID },
      properties: {
        title: { title: [{ text: { content: "[E2E] 라운드트립 테스트" } }] },
      },
      children: blocks as never,
    })) as PageObjectResponse;

    createdPageIds.push(page.id);

    await new Promise((r) => setTimeout(r, 1000));

    const mdBlocks = await n2m.pageToMarkdown(page.id);
    const result = n2m.toMarkdownString(mdBlocks);
    const roundtripped = result.parent ?? "";

    console.log("라운드트립 결과:\n", roundtripped);

    expect(roundtripped).toContain("라운드트립 테스트");
    expect(roundtripped).toContain("간단한 문단");
    expect(roundtripped).toContain("리스트 1");
    expect(roundtripped).toContain("인용문");
  });
});
