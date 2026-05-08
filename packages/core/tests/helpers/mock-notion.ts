import { vi } from "vitest";

export function createMockNotionClient() {
  return {
    getPage: vi.fn().mockResolvedValue({
      id: "page-123",
      object: "page",
      archived: false,
      last_edited_time: "2026-05-08T10:00:00.000Z",
      properties: {
        title: {
          type: "title",
          title: [{ plain_text: "Test Page" }],
        },
      },
    }),
    createPage: vi.fn().mockResolvedValue({
      id: "new-page-456",
      object: "page",
      last_edited_time: "2026-05-08T10:00:00.000Z",
    }),
    updatePageProperties: vi.fn().mockResolvedValue({
      id: "page-123",
      object: "page",
      last_edited_time: "2026-05-08T10:05:00.000Z",
    }),
    archivePage: vi.fn().mockResolvedValue(undefined),
    listChildren: vi.fn().mockResolvedValue({
      results: [],
      nextCursor: null,
    }),
    fetchAllChildren: vi.fn().mockResolvedValue([]),
    appendChildren: vi.fn().mockResolvedValue(undefined),
    deleteBlock: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue({
      results: [],
      nextCursor: null,
    }),
  };
}

export function createMockBlocks() {
  return {
    heading: {
      object: "block",
      id: "block-h1",
      type: "heading_1",
      heading_1: {
        rich_text: [
          { type: "text", text: { content: "Test Heading" }, plain_text: "Test Heading" },
        ],
        is_toggleable: false,
      },
      has_children: false,
    },
    paragraph: {
      object: "block",
      id: "block-p1",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: "Hello world" }, plain_text: "Hello world" }],
      },
      has_children: false,
    },
    bulletedList: {
      object: "block",
      id: "block-ul1",
      type: "bulleted_list_item",
      bulleted_list_item: {
        rich_text: [{ type: "text", text: { content: "Item 1" }, plain_text: "Item 1" }],
      },
      has_children: false,
    },
    todoChecked: {
      object: "block",
      id: "block-todo1",
      type: "to_do",
      to_do: {
        rich_text: [{ type: "text", text: { content: "Done task" }, plain_text: "Done task" }],
        checked: true,
      },
      has_children: false,
    },
    todoUnchecked: {
      object: "block",
      id: "block-todo2",
      type: "to_do",
      to_do: {
        rich_text: [
          { type: "text", text: { content: "Pending task" }, plain_text: "Pending task" },
        ],
        checked: false,
      },
      has_children: false,
    },
    codeBlock: {
      object: "block",
      id: "block-code1",
      type: "code",
      code: {
        rich_text: [{ type: "text", text: { content: "const x = 1" }, plain_text: "const x = 1" }],
        language: "typescript",
      },
      has_children: false,
    },
    quote: {
      object: "block",
      id: "block-q1",
      type: "quote",
      quote: {
        rich_text: [
          { type: "text", text: { content: "A wise quote" }, plain_text: "A wise quote" },
        ],
      },
      has_children: false,
    },
    divider: {
      object: "block",
      id: "block-div1",
      type: "divider",
      divider: {},
      has_children: false,
    },
    callout: {
      object: "block",
      id: "block-callout1",
      type: "callout",
      callout: {
        rich_text: [
          { type: "text", text: { content: "Important note" }, plain_text: "Important note" },
        ],
        icon: { type: "emoji", emoji: "⚠️" },
        color: "yellow_background",
      },
      has_children: false,
    },
  };
}
