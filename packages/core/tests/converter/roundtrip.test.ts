import { describe, it, expect, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConversionPipeline } from "../../src/converter/pipeline.js";
import { FrontmatterExtractor } from "../../src/converter/pre-processors/frontmatter.js";
import { WikilinkResolver } from "../../src/converter/pre-processors/wikilink.js";
import { MathNormalizer } from "../../src/converter/pre-processors/math.js";
import { EmbedResolver } from "../../src/converter/pre-processors/embed.js";
import { CalloutTransformer } from "../../src/converter/pre-processors/callout.js";
import { UnsupportedBlockStripper } from "../../src/converter/pre-processors/unsupported-block-stripper.js";
import { PropertiesTableInjector } from "../../src/converter/pre-processors/properties-table.js";
import { MentionToWikilink } from "../../src/converter/post-processors/mention-to-wikilink.js";
import { FrontmatterGenerator } from "../../src/converter/post-processors/frontmatter-generator.js";
import { CalloutRestorer } from "../../src/converter/post-processors/callout-restorer.js";
import { PropertiesTableRestorer } from "../../src/converter/post-processors/properties-table-restorer.js";
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
    pipeline.registerPreProcessor(new UnsupportedBlockStripper());
    pipeline.registerPreProcessor(new FrontmatterExtractor());
    pipeline.registerPreProcessor(new PropertiesTableInjector());
    pipeline.registerPreProcessor(new EmbedResolver());
    pipeline.registerPreProcessor(new CalloutTransformer());
    pipeline.registerPreProcessor(new MathNormalizer());
    pipeline.registerPostProcessor(new PropertiesTableRestorer());
    pipeline.registerPostProcessor(new CalloutRestorer());
    pipeline.registerPostProcessor(new FrontmatterGenerator());
  });

  it("frontmatter 라운드트립: 추출 → 속성 테이블 → 재생성", async () => {
    const input = `---\ntitle: Test\nstatus: active\n---\n\n# Hello World`;
    const pushResult = pipeline.convertToNotion(input, pushContext);

    expect(pushResult.properties).toEqual({ title: "Test", status: "active" });
    expect(pushResult.content).toContain("| Property | Value |");
    expect(pushResult.content).toContain("| status | active |");
    expect(pushResult.content).toContain("# Hello World");

    const pullResult = pipeline.convertToMarkdown(pushResult.content, pullContext, {
      properties: pushResult.properties,
    });

    expect(pullResult).toContain("title: Test");
    expect(pullResult).toContain("status: active");
    expect(pullResult).toContain("# Hello World");
  });

  it("Math 라운드트립: 수식 정규화 보존", () => {
    const input = "Inline $E = mc^2$ and block $$\\sum_{i=1}^{n} i$$";
    const pushResult = pipeline.convertToNotion(input, pushContext);

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

  it("wikilink 라운드트립: [[link]] → 보존 링크 → [[link]]", () => {
    const wikiPipeline = new ConversionPipeline();
    wikiPipeline.registerPreProcessor(new WikilinkResolver());
    wikiPipeline.registerPostProcessor(new MentionToWikilink());

    const input = "See [[Project Plan]] for details";
    const pushResult = wikiPipeline.convertToNotion(input, pushContext);
    expect(pushResult.content).toContain("im-nobsidian://wikilink/Project%20Plan");
    expect(pushResult.content).not.toContain("[[");

    const pullResult = wikiPipeline.convertToMarkdown(pushResult.content, pullContext);
    expect(pullResult).toContain("[[Project Plan]]");
    expect(pullResult).not.toContain("im-nobsidian://");
  });

  it("wikilink 라운드트립: 리졸버로 페이지 멘션 변환 → Pull 시 복원", () => {
    const resolver = (text: string) => {
      if (text === "Project Plan") {
        return {
          obsidianPath: "project-plan.md",
          notionPageId: "page-abc",
          title: "Project Plan",
          aliases: [],
        };
      }
      return null;
    };

    const wikiPipeline = new ConversionPipeline();
    wikiPipeline.registerPreProcessor(new WikilinkResolver(resolver));
    wikiPipeline.registerPostProcessor(new MentionToWikilink());

    const input = "See [[Project Plan]] for details";
    const pushResult = wikiPipeline.convertToNotion(input, pushContext);
    expect(pushResult.content).toContain('<mention-page id="page-abc">Project Plan</mention-page>');
  });

  it("image-embed-note.md 이미지 임베드 보존", async () => {
    const input = await readFile(join(FIXTURES_DIR, "image-embed-note.md"), "utf-8");
    const pushResult = pipeline.convertToNotion(input, pushContext);

    expect(pushResult.content).toContain("📎 screenshot.png");
    expect(pushResult.content).toContain("%% im-nobsidian:local-image:screenshot.png %%");
    expect(pushResult.content).toContain("📎 diagram.jpg");
    expect(pushResult.content).toContain("![External](https://example.com/photo.png)");
    expect(pushResult.properties).toEqual({
      title: "Image Embed Test",
      tags: ["image", "test"],
    });
  });

  it("complex-formatting-note.md 중첩 리스트/복합 서식 보존", async () => {
    const input = await readFile(join(FIXTURES_DIR, "complex-formatting-note.md"), "utf-8");
    const pushResult = pipeline.convertToNotion(input, pushContext);

    expect(pushResult.content).toContain("- Level 1 item A");
    expect(pushResult.content).toContain("  - Level 2 item A-1");
    expect(pushResult.content).toContain("    - Level 3 item A-1-a");
    expect(pushResult.content).toContain("1. First");
    expect(pushResult.content).toContain("**bold _and italic_ together**");
    expect(pushResult.content).toContain("~~strikethrough~~");
    expect(pushResult.content).toContain("> Outer quote");
    expect(pushResult.content).toContain("---");

    expect(pushResult.properties).toEqual({ title: "Complex Formatting", status: "draft" });
  });

  it("code-blocks-note.md 다중 언어 코드 블록 보존", async () => {
    const input = await readFile(join(FIXTURES_DIR, "code-blocks-note.md"), "utf-8");
    const pushResult = pipeline.convertToNotion(input, pushContext);

    expect(pushResult.content).toContain("```typescript");
    expect(pushResult.content).toContain("```python");
    expect(pushResult.content).toContain("```bash");
    expect(pushResult.content).toContain("```json");
    expect(pushResult.content).toContain("interface User {");
    expect(pushResult.content).toContain("def fibonacci");
    expect(pushResult.content).toContain("`npm install`");

    expect(pushResult.properties).toEqual({
      title: "Code Blocks",
      tags: ["code", "programming"],
    });
  });

  it("table-note.md 마크다운 테이블 보존", async () => {
    const input = await readFile(join(FIXTURES_DIR, "table-note.md"), "utf-8");
    const pushResult = pipeline.convertToNotion(input, pushContext);

    expect(pushResult.content).toContain("| Feature |");
    expect(pushResult.content).toMatch(/\| Text\s+\|/);
    expect(pushResult.content).toContain("**Bold cell**");
    expect(pushResult.content).toContain("Content continues after");

    expect(pushResult.properties).toEqual({ title: "Table Test" });
  });

  it("mixed-content-note.md 전체 A등급 요소 조합", async () => {
    const input = await readFile(join(FIXTURES_DIR, "mixed-content-note.md"), "utf-8");
    const pushResult = pipeline.convertToNotion(input, pushContext);

    expect(pushResult.content).toContain("**bold**");
    expect(pushResult.content).toContain("_italic_");
    expect(pushResult.content).toContain("`code`");
    expect(pushResult.content).toContain("- Bullet item");
    expect(pushResult.content).toContain("1. Ordered item");
    expect(pushResult.content).toContain("- [x] Done task");
    expect(pushResult.content).toContain("- [ ] Todo task");
    expect(pushResult.content).toContain("```typescript");
    expect(pushResult.content).toContain("$E = mc^2$");
    expect(pushResult.content).toContain("$$");
    expect(pushResult.content).toContain("| Col A |");
    expect(pushResult.content).toContain("---");

    expect(pushResult.properties).toEqual({
      title: "Mixed Content",
      status: "active",
      tags: ["comprehensive", "a-grade"],
      priority: 1,
    });
  });

  it("frontmatter-heavy-note.md 다양한 프로퍼티 타입 보존", async () => {
    const input = await readFile(join(FIXTURES_DIR, "frontmatter-heavy-note.md"), "utf-8");
    const pushResult = pipeline.convertToNotion(input, pushContext);

    expect(pushResult.properties).toEqual({
      title: "Frontmatter Heavy",
      status: "in-progress",
      tags: ["metadata", "test", "frontmatter"],
      priority: 5,
      category: "documentation",
      created: "2026-01-15",
      due: "2026-06-30",
      author: "jaylen",
      url: "https://github.com/JaylenAI/Im-Nobsidian",
      reviewed: true,
      score: 95.5,
    });

    const pullResult = pipeline.convertToMarkdown(pushResult.content, pullContext, {
      properties: pushResult.properties,
    });

    expect(pullResult).toContain("title: Frontmatter Heavy");
    expect(pullResult).toContain("status: in-progress");
    expect(pullResult).toContain("priority: 5");
    expect(pullResult).toContain("score: 95.5");
    expect(pullResult).toContain("reviewed: true");
    expect(pullResult).toContain("# Frontmatter Heavy");
  });
});
