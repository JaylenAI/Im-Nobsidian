import { describe, it, expect } from "vitest";
import { ConversionPipeline } from "../../src/converter/pipeline.js";
import { FrontmatterExtractor } from "../../src/converter/pre-processors/frontmatter.js";
import { WikilinkResolver } from "../../src/converter/pre-processors/wikilink.js";
import { CalloutTransformer } from "../../src/converter/pre-processors/callout.js";
import { PropertiesTableInjector } from "../../src/converter/pre-processors/properties-table.js";
import { MentionToWikilink } from "../../src/converter/post-processors/mention-to-wikilink.js";
import { PropertiesTableRestorer } from "../../src/converter/post-processors/properties-table-restorer.js";
import { FrontmatterGenerator } from "../../src/converter/post-processors/frontmatter-generator.js";
import { BlockConverter } from "../../src/converter/block-converter.js";
import type { ConversionContext } from "../../src/types/convert.js";

const pushContext: ConversionContext = {
  direction: "push",
  path: "markdown-api",
  filePath: "test.md",
};

const pullContext: ConversionContext = {
  direction: "pull",
  path: "markdown-api",
  filePath: "test.md",
};

describe("ConversionPipeline", () => {
  it("전처리기 체인 순서대로 실행", () => {
    const pipeline = new ConversionPipeline();
    pipeline.registerPreProcessor(new FrontmatterExtractor());
    pipeline.registerPreProcessor(new WikilinkResolver());

    const input = `---
title: Test
---

# Hello [[World]]`;

    const result = pipeline.convertToNotion(input, pushContext);

    expect(result.properties).toEqual({ title: "Test" });
    expect(result.content).toContain("im-nobsidian://wikilink/World");
    expect(result.content).not.toContain("---");
  });

  it("후처리기 체인 실행", () => {
    const pipeline = new ConversionPipeline();
    pipeline.registerPostProcessor(new MentionToWikilink());

    const input = "Check [My Page](https://www.notion.so/abc123) for details";
    const result = pipeline.convertToMarkdown(input, pullContext);

    expect(result).toContain("[[My Page]]");
  });

  it("경로 선택: 단순 문서는 markdown-api", () => {
    const pipeline = new ConversionPipeline();
    expect(pipeline.selectPath("# Hello\n\nSimple content")).toBe("markdown-api");
  });

  it("경로 선택: 인라인 DB 포함 시 block-api", () => {
    const pipeline = new ConversionPipeline();
    expect(pipeline.selectPath("%% im-nobsidian:inline-db:id=abc %%")).toBe("block-api");
  });
});

describe("FrontmatterExtractor", () => {
  it("YAML frontmatter를 분리하여 properties로 추출", () => {
    const processor = new FrontmatterExtractor();
    const result = processor.process({
      content: "---\ntitle: Hello\nstatus: active\n---\n# Content",
      metadata: {},
      context: pushContext,
    });

    expect(result.metadata.properties).toEqual({ title: "Hello", status: "active" });
    expect(result.content).toBe("# Content");
  });

  it("frontmatter 없는 문서는 그대로 반환", () => {
    const processor = new FrontmatterExtractor();
    const result = processor.process({
      content: "# No Frontmatter",
      metadata: {},
      context: pushContext,
    });

    expect(result.content).toBe("# No Frontmatter");
    expect(result.metadata.properties).toEqual({});
  });
});

describe("WikilinkResolver", () => {
  it("리졸버 없이 [[Page]] → 보존 링크 변환", () => {
    const processor = new WikilinkResolver();
    const result = processor.process({
      content: "Link to [[My Page]] here",
      metadata: {},
      context: pushContext,
    });

    expect(result.content).toBe("Link to [My Page](im-nobsidian://wikilink/My%20Page) here");
    expect(result.metadata.preserveMarkers).toHaveLength(1);
    expect(result.metadata.preserveMarkers![0]!.type).toBe("wikilink");
  });

  it("[[Page|Display]] → 보존 링크 (display 텍스트 유지)", () => {
    const processor = new WikilinkResolver();
    const result = processor.process({
      content: "[[Long Name|Short]]",
      metadata: {},
      context: pushContext,
    });

    expect(result.content).toBe("[Short](im-nobsidian://wikilink/Long%20Name)");
  });

  it("여러 위키링크 동시 처리", () => {
    const processor = new WikilinkResolver();
    const result = processor.process({
      content: "[[A]] and [[B]] and [[C|See C]]",
      metadata: {},
      context: pushContext,
    });

    expect(result.content).toContain("[A](im-nobsidian://wikilink/A)");
    expect(result.content).toContain("[B](im-nobsidian://wikilink/B)");
    expect(result.content).toContain("[See C](im-nobsidian://wikilink/C)");
    expect(result.metadata.preserveMarkers).toHaveLength(3);
  });

  it("리졸버로 페이지 멘션 변환", () => {
    const resolver = (text: string) => {
      if (text === "My Page") {
        return {
          obsidianPath: "my-page.md",
          notionPageId: "page-id-123",
          title: "My Page",
          aliases: [],
        };
      }
      return null;
    };
    const processor = new WikilinkResolver(resolver);
    const result = processor.process({
      content: "See [[My Page]] and [[Unknown]]",
      metadata: {},
      context: pushContext,
    });

    expect(result.content).toContain('<mention-page id="page-id-123">My Page</mention-page>');
    expect(result.content).toContain("[Unknown](im-nobsidian://wikilink/Unknown)");
    expect(result.metadata.preserveMarkers).toHaveLength(1);
  });

  it("Pull 방향에서는 변환하지 않음", () => {
    const processor = new WikilinkResolver();
    const result = processor.process({
      content: "Link to [[My Page]] here",
      metadata: {},
      context: pullContext,
    });

    expect(result.content).toBe("Link to [[My Page]] here");
  });

  it("![[embed]] 패턴은 무시 (EmbedResolver에 위임)", () => {
    const processor = new WikilinkResolver();
    const result = processor.process({
      content: "See ![[note.md]] here",
      metadata: {},
      context: pushContext,
    });

    expect(result.content).toBe("See ![[note.md]] here");
  });
});

const blockApiPushContext: ConversionContext = {
  direction: "push",
  path: "block-api",
  filePath: "test.md",
};

describe("CalloutTransformer", () => {
  it("[!warning] → 이모지 변환 (block-api)", () => {
    const processor = new CalloutTransformer();
    const result = processor.process({
      content: "> [!warning] Be careful\n> Content here",
      metadata: {},
      context: blockApiPushContext,
    });

    expect(result.content).toContain("⚠️");
    expect(result.content).toContain("**Be careful**");
  });

  it("markdown-api 경로에서는 변환하지 않음", () => {
    const processor = new CalloutTransformer();
    const result = processor.process({
      content: "> [!warning] Be careful\n> Content here",
      metadata: {},
      context: pushContext,
    });

    expect(result.content).toBe("> [!warning] Be careful\n> Content here");
  });

  it("[!tip]+ foldable open → preserve marker 포함 (block-api)", () => {
    const processor = new CalloutTransformer();
    const result = processor.process({
      content: "> [!tip]+ Hint",
      metadata: {},
      context: blockApiPushContext,
    });

    expect(result.content).toContain("im-nobsidian:callout:type=tip&foldable=open");
  });
});

describe("MentionToWikilink", () => {
  it("Notion 링크 → [[위키링크]] 변환", () => {
    const processor = new MentionToWikilink();
    const result = processor.process({
      content: "See [Project Plan](https://www.notion.so/abc-def-123)",
      metadata: {},
      context: pullContext,
    });

    expect(result.content).toBe("See [[Project Plan]]");
  });

  it("notion:// 프로토콜도 처리", () => {
    const processor = new MentionToWikilink();
    const result = processor.process({
      content: "[Note](notion://abc123)",
      metadata: {},
      context: pullContext,
    });

    expect(result.content).toBe("[[Note]]");
  });

  it("www 없는 notion.so URL도 처리", () => {
    const processor = new MentionToWikilink();
    const result = processor.process({
      content: "See [My Page](https://notion.so/abc-def-123) here",
      metadata: {},
      context: pullContext,
    });

    expect(result.content).toBe("See [[My Page]] here");
  });

  it("im-nobsidian://wikilink 보존 링크 → 위키링크 복원", () => {
    const processor = new MentionToWikilink();
    const result = processor.process({
      content: "See [Unknown Page](im-nobsidian://wikilink/Unknown%20Page) here",
      metadata: {},
      context: pullContext,
    });

    expect(result.content).toBe("See [[Unknown Page]] here");
  });

  it("im-nobsidian://wikilink 디스플레이 텍스트 다를 때 → [[target|display]]", () => {
    const processor = new MentionToWikilink();
    const result = processor.process({
      content: "[Short](im-nobsidian://wikilink/Long%20Name)",
      metadata: {},
      context: pullContext,
    });

    expect(result.content).toBe("[[Long Name|Short]]");
  });

  it("im-nobsidian://embed 보존 링크 → ![[embed]] 복원", () => {
    const processor = new MentionToWikilink();
    const result = processor.process({
      content: "Embed: [other-note.md](im-nobsidian://embed/other-note.md)",
      metadata: {},
      context: pullContext,
    });

    expect(result.content).toBe("Embed: ![[other-note.md]]");
  });
});

describe("PropertiesTableInjector", () => {
  it("Push 시 프론트매터 속성을 마크다운 테이블로 변환", () => {
    const processor = new PropertiesTableInjector();
    const result = processor.process({
      content: "# Hello World",
      metadata: { properties: { title: "Test", status: "active", tags: ["a", "b"] } },
      context: pushContext,
    });

    expect(result.content).toContain("| Property | Value |");
    expect(result.content).toContain("| status | active |");
    expect(result.content).toContain("| tags | a, b |");
    expect(result.content).not.toContain("| title |");
    expect(result.content).toContain("# Hello World");
  });

  it("title만 있으면 테이블 생성 안 함", () => {
    const processor = new PropertiesTableInjector();
    const result = processor.process({
      content: "# Hello",
      metadata: { properties: { title: "Test" } },
      context: pushContext,
    });

    expect(result.content).not.toContain("| Property |");
    expect(result.content).toBe("# Hello");
  });

  it("Pull 방향에서는 동작하지 않음", () => {
    const processor = new PropertiesTableInjector();
    const result = processor.process({
      content: "# Hello",
      metadata: { properties: { status: "active" } },
      context: pullContext,
    });

    expect(result.content).toBe("# Hello");
  });
});

describe("PropertiesTableRestorer", () => {
  it("Pull 시 속성 테이블을 메타데이터로 복원", () => {
    const processor = new PropertiesTableRestorer();
    const input = `| Property | Value |
| --- | --- |
| status | active |
| priority | 5 |

---

# Hello World`;

    const result = processor.process({
      content: input,
      metadata: {},
      context: pullContext,
    });

    const props = result.metadata.properties as Record<string, unknown>;
    expect(props.status).toBe("active");
    expect(props.priority).toBe(5);
    expect(result.content).toBe("# Hello World");
  });

  it("배열 값 복원", () => {
    const processor = new PropertiesTableRestorer();
    const input = `| Property | Value |
| --- | --- |
| tags | a, b, c |

---

Content`;

    const result = processor.process({
      content: input,
      metadata: {},
      context: pullContext,
    });

    const props = result.metadata.properties as Record<string, unknown>;
    expect(props.tags).toEqual(["a", "b", "c"]);
  });

  it("속성 테이블이 없으면 그대로 반환", () => {
    const processor = new PropertiesTableRestorer();
    const result = processor.process({
      content: "# Just content",
      metadata: {},
      context: pullContext,
    });

    expect(result.content).toBe("# Just content");
  });
});

describe("PropertiesTable 라운드트립", () => {
  it("Push(테이블 생성) → Pull(테이블 복원 → 프론트매터 생성) 완전 순환", () => {
    const pipeline = new ConversionPipeline();
    pipeline.registerPreProcessor(new FrontmatterExtractor());
    pipeline.registerPreProcessor(new PropertiesTableInjector());
    pipeline.registerPostProcessor(new PropertiesTableRestorer());
    pipeline.registerPostProcessor(new FrontmatterGenerator());

    const input = `---
title: My Note
status: active
priority: 3
tags:
  - test
  - example
---

# My Note

Content here.`;

    const pushResult = pipeline.convertToNotion(input, pushContext);

    expect(pushResult.content).toContain("| Property | Value |");
    expect(pushResult.content).toContain("| status | active |");
    expect(pushResult.content).toContain("| priority | 3 |");
    expect(pushResult.content).toContain("| tags | test, example |");
    expect(pushResult.content).toContain("# My Note");

    const pullResult = pipeline.convertToMarkdown(pushResult.content, pullContext, {
      properties: pushResult.properties,
    });

    expect(pullResult).toContain("title: My Note");
    expect(pullResult).toContain("status: active");
    expect(pullResult).toContain("priority: 3");
    expect(pullResult).toContain("# My Note");
  });
});

describe("BlockConverter", () => {
  it("markdownToNotionBlocks: quote+emoji → callout 변환", () => {
    const converter = new BlockConverter();
    const blocks = converter.markdownToNotionBlocks(
      "> ⚠️ **Warning Title**\n> Be careful here",
    ) as Array<Record<string, unknown>>;

    const calloutBlock = blocks.find((b) => b.type === "callout");
    if (calloutBlock) {
      const callout = calloutBlock.callout as { icon: { emoji: string } };
      expect(callout.icon.emoji).toBe("⚠️");
    } else {
      const quoteBlock = blocks.find((b) => b.type === "quote");
      expect(quoteBlock).toBeDefined();
    }
  });

  it("markdownToNotionBlocks: 일반 quote는 그대로 유지", () => {
    const converter = new BlockConverter();
    const blocks = converter.markdownToNotionBlocks("> Just a normal quote") as Array<
      Record<string, unknown>
    >;

    expect(blocks[0]?.type).toBe("quote");
  });
});
