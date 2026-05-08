import { describe, it, expect, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConversionPipeline } from "../../src/converter/pipeline.js";
import { FrontmatterExtractor } from "../../src/converter/pre-processors/frontmatter.js";
import { WikilinkResolver } from "../../src/converter/pre-processors/wikilink.js";
import { MathNormalizer } from "../../src/converter/pre-processors/math.js";
import { MentionToWikilink } from "../../src/converter/post-processors/mention-to-wikilink.js";
import { FrontmatterGenerator } from "../../src/converter/post-processors/frontmatter-generator.js";
import type { ConversionContext } from "../../src/types/convert.js";

const FIXTURES_DIR = join(import.meta.dirname, "../fixtures/obsidian");

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

function normalize(md: string): string {
  return md
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

describe("Roundtrip 테스트", () => {
  let pipeline: ConversionPipeline;

  beforeEach(() => {
    pipeline = new ConversionPipeline();
    pipeline.registerPreProcessor(new FrontmatterExtractor());
    pipeline.registerPostProcessor(new FrontmatterGenerator());
  });

  it("frontmatter 라운드트립: 추출 → 재생성", async () => {
    const input = `---\ntitle: Test\nstatus: active\n---\n\n# Hello World`;
    const pushResult = pipeline.convertToNotion(input, pushContext);

    expect(pushResult.properties).toEqual({ title: "Test", status: "active" });
    expect(pushResult.content).not.toContain("---");

    const pullResult = pipeline.convertToMarkdown(pushResult.content, pullContext, {
      properties: pushResult.properties,
    });

    expect(pullResult).toContain("title: Test");
    expect(pullResult).toContain("status: active");
    expect(pullResult).toContain("# Hello World");
  });

  it("Math 라운드트립: 수식 정규화 보존", () => {
    const mathPipeline = new ConversionPipeline();
    mathPipeline.registerPreProcessor(new MathNormalizer());

    const input = "Inline $E = mc^2$ and block $$\\sum_{i=1}^{n} i$$";
    const pushResult = mathPipeline.convertToNotion(input, pushContext);

    expect(pushResult.content).toContain("$E = mc^2$");
    expect(pushResult.content).toContain("$$");
  });

  it("simple-note.md A등급 요소 보존", async () => {
    const input = await readFile(join(FIXTURES_DIR, "simple-note.md"), "utf-8");
    const pushResult = pipeline.convertToNotion(input, pushContext);

    expect(pushResult.content).toContain("# Simple Note");
    expect(pushResult.content).toContain("- Bullet point 1");
    expect(pushResult.content).toContain("1. First item");
    expect(pushResult.content).toContain("- [x] Completed task");
    expect(pushResult.content).toContain("- [ ] Pending task");
    expect(pushResult.content).toContain("**bold**");
    expect(pushResult.content).toContain("_italic_");
    expect(pushResult.content).toContain("`inline code`");
    expect(pushResult.content).toContain("```typescript");
    expect(pushResult.content).toContain("> This is a blockquote");
    expect(pushResult.content).toContain("---");
    expect(pushResult.content).toContain("[External Link](https://github.com)");

    expect(pushResult.properties).toEqual({
      title: "Simple Note",
      status: "active",
      tags: ["test", "example"],
    });
  });

  it("wikilink 라운드트립: [[link]] → markdown → [[link]]", () => {
    const wikiPipeline = new ConversionPipeline();
    wikiPipeline.registerPreProcessor(new WikilinkResolver());
    wikiPipeline.registerPostProcessor(new MentionToWikilink());

    const input = "See [[Project Plan]] for details";
    const pushResult = wikiPipeline.convertToNotion(input, pushContext);
    expect(pushResult.content).toContain("[Project Plan]");
    expect(pushResult.content).not.toContain("[[");
  });
});
