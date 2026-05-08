import { describe, it, expect } from "vitest";
import { ConversionPipeline } from "../../src/converter/pipeline.js";
import { FrontmatterExtractor } from "../../src/converter/pre-processors/frontmatter.js";
import { WikilinkResolver } from "../../src/converter/pre-processors/wikilink.js";
import { CalloutTransformer } from "../../src/converter/pre-processors/callout.js";
import { MentionToWikilink } from "../../src/converter/post-processors/mention-to-wikilink.js";
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
    expect(result.content).toContain("[World](World)");
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
  it("[[Page]] → [Page](Page) 변환", () => {
    const processor = new WikilinkResolver();
    const result = processor.process({
      content: "Link to [[My Page]] here",
      metadata: {},
      context: pushContext,
    });

    expect(result.content).toBe("Link to [My Page](My%20Page) here");
  });

  it("[[Page|Display]] → [Display](Page) 변환", () => {
    const processor = new WikilinkResolver();
    const result = processor.process({
      content: "[[Long Name|Short]]",
      metadata: {},
      context: pushContext,
    });

    expect(result.content).toBe("[Short](Long%20Name)");
  });

  it("여러 위키링크 동시 처리", () => {
    const processor = new WikilinkResolver();
    const result = processor.process({
      content: "[[A]] and [[B]] and [[C|See C]]",
      metadata: {},
      context: pushContext,
    });

    expect(result.content).toBe("[A](A) and [B](B) and [See C](C)");
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
