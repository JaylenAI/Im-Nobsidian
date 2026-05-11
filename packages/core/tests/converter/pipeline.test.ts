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
    expect(result.content).toContain("**World**");
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
    expect(pipeline.selectPath("%% obsinotion:inline-db:id=abc %%")).toBe("block-api");
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
  it("[[Page]] → **Page** 볼드 변환", () => {
    const processor = new WikilinkResolver();
    const result = processor.process({
      content: "Link to [[My Page]] here",
      metadata: {},
      context: pushContext,
    });

    expect(result.content).toBe("Link to **My Page** here");
  });

  it("[[Page|Display]] → **Display** 변환", () => {
    const processor = new WikilinkResolver();
    const result = processor.process({
      content: "[[Long Name|Short]]",
      metadata: {},
      context: pushContext,
    });

    expect(result.content).toBe("**Short**");
  });

  it("여러 위키링크 동시 처리", () => {
    const processor = new WikilinkResolver();
    const result = processor.process({
      content: "[[A]] and [[B]] and [[C|See C]]",
      metadata: {},
      context: pushContext,
    });

    expect(result.content).toBe("**A** and **B** and **See C**");
  });
});

describe("CalloutTransformer", () => {
  it("[!warning] → 이모지 변환", () => {
    const processor = new CalloutTransformer();
    const result = processor.process({
      content: "> [!warning] Be careful\n> Content here",
      metadata: {},
      context: pushContext,
    });

    expect(result.content).toContain("⚠️");
    expect(result.content).toContain("**Be careful**");
  });

  it("[!tip]+ foldable open → preserve marker 포함", () => {
    const processor = new CalloutTransformer();
    const result = processor.process({
      content: "> [!tip]+ Hint",
      metadata: {},
      context: pushContext,
    });

    expect(result.content).toContain("obsinotion:callout:type=tip&foldable=open");
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
