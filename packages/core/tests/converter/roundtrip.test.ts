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

  it("frontmatter 라운드트립: 추출 → YAML 코드블록 → 재생성", async () => {
    const input = `---\ntitle: Test\nstatus: active\n---\n\n# Hello World`;
    const pushResult = pipeline.convertToNotion(input, pushContext);

    expect(pushResult.properties).toEqual({ title: "Test", status: "active" });
    expect(pushResult.content).toContain("```yaml");
    expect(pushResult.content).toContain("# im-nobsidian:properties");
    expect(pushResult.content).toContain("status: active");
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

    const localImages = pushResult.images.filter((img) => !img.isExternal);
    expect(localImages).toHaveLength(3);
    expect(localImages.map((img) => img.localPath)).toEqual(
      expect.arrayContaining(["screenshot.png", "diagram.jpg", "architecture.png"]),
    );

    const externalImages = pushResult.images.filter((img) => img.isExternal);
    expect(externalImages).toHaveLength(1);
    expect(externalImages[0]!.url).toBe("https://example.com/photo.png");
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

  it("callout-note.md 콜아웃 타입 보존 (block-api 경로)", async () => {
    const blockPush: ConversionContext = {
      direction: "push",
      path: "block-api",
      filePath: "test.md",
    };

    const blockPipeline = new ConversionPipeline();
    blockPipeline.registerPreProcessor(new FrontmatterExtractor());
    blockPipeline.registerPreProcessor(new CalloutTransformer());
    blockPipeline.registerPostProcessor(new CalloutRestorer());
    blockPipeline.registerPostProcessor(new FrontmatterGenerator());

    const input = await readFile(join(FIXTURES_DIR, "callout-note.md"), "utf-8");
    const pushResult = blockPipeline.convertToNotion(input, blockPush);

    expect(pushResult.content).toContain("im-nobsidian:callout:type=note");
    expect(pushResult.content).toContain("im-nobsidian:callout:type=warning");
    expect(pushResult.content).toContain("im-nobsidian:callout:type=tip&foldable=open");
    expect(pushResult.content).toContain("im-nobsidian:callout:type=danger&foldable=closed");

    const pullResult = blockPipeline.convertToMarkdown(pushResult.content, pullContext);

    expect(pullResult).toContain("[!note]");
    expect(pullResult).toContain("[!warning]");
    expect(pullResult).toContain("[!tip]+");
    expect(pullResult).toContain("[!danger]-");
    expect(pullResult).toContain("[!info]");
    expect(pullResult).toContain("[!quote]");
  });

  it("callout-note.md markdown-api 경로 passthrough", async () => {
    const input = await readFile(join(FIXTURES_DIR, "callout-note.md"), "utf-8");
    const pushResult = pipeline.convertToNotion(input, pushContext);

    expect(pushResult.content).toContain("> [!note] Simple Note");
    expect(pushResult.content).toContain("> [!warning] Be Careful");
    expect(pushResult.content).toContain("> [!tip]+ Expandable Tip");
    expect(pushResult.content).toContain("> [!danger]- Hidden Danger");
  });

  it("math-note.md 수식 완전 라운드트립", async () => {
    const input = await readFile(join(FIXTURES_DIR, "math-note.md"), "utf-8");
    const pushResult = pipeline.convertToNotion(input, pushContext);

    expect(pushResult.content).toContain("$E = mc^2$");
    expect(pushResult.content).toContain("$$");
    expect(pushResult.content).toContain("\\int_{-\\infty}^{\\infty}");
    expect(pushResult.content).toContain("\\sum_{i=1}^{n}");
    expect(pushResult.properties).toEqual({ title: "Math Test" });
  });

  it("wikilinks-note.md 다중 위키링크 보존 라운드트립", async () => {
    const wikiPipeline = new ConversionPipeline();
    wikiPipeline.registerPreProcessor(new FrontmatterExtractor());
    wikiPipeline.registerPreProcessor(new WikilinkResolver());
    wikiPipeline.registerPostProcessor(new MentionToWikilink());
    wikiPipeline.registerPostProcessor(new FrontmatterGenerator());

    const input = await readFile(join(FIXTURES_DIR, "wikilinks-note.md"), "utf-8");
    const pushResult = wikiPipeline.convertToNotion(input, pushContext);

    expect(pushResult.content).toContain("im-nobsidian://wikilink/Project%20Plan");
    expect(pushResult.content).toContain("im-nobsidian://wikilink/TODO%20List");
    expect(pushResult.content).toContain("im-nobsidian://wikilink/Architecture");
    expect(pushResult.content).toContain("[markdown link](https://example.com)");

    const pullResult = wikiPipeline.convertToMarkdown(pushResult.content, pullContext);

    expect(pullResult).toContain("[[Project Plan]]");
    expect(pullResult).toContain("[[Meeting Notes|Meetings]]");
    expect(pullResult).toContain("[[TODO List]]");
    expect(pullResult).toContain("[[Architecture]]");
    expect(pullResult).toContain("[[API Design|Design Doc]]");
    expect(pullResult).toContain("[markdown link](https://example.com)");
  });

  it("toggle-note.md 토글 구조 보존", async () => {
    const input = await readFile(join(FIXTURES_DIR, "toggle-note.md"), "utf-8");
    const pushResult = pipeline.convertToNotion(input, pushContext);

    expect(pushResult.content).toContain("<details>");
    expect(pushResult.content).toContain("<summary>Click to expand</summary>");
    expect(pushResult.content).toContain("This content is inside a toggle.");
    expect(pushResult.content).toContain("<summary>Outer Toggle</summary>");
    expect(pushResult.content).toContain("<summary>Inner Toggle</summary>");
    expect(pushResult.content).toContain("Inner content with **bold** and `code`.");
    expect(pushResult.content).toContain("Normal paragraph after toggles.");

    expect(pushResult.properties).toEqual({ title: "Toggle Test", tags: ["toggle"] });
  });

  it("special-chars-note.md 특수문자 프론트매터 왕복", async () => {
    const input = await readFile(join(FIXTURES_DIR, "special-chars-note.md"), "utf-8");
    const pushResult = pipeline.convertToNotion(input, pushContext);

    expect(pushResult.properties).toEqual({
      title: "Special: Characters & More",
      status: "active",
      description: "Pipes | commas, and 'quotes'",
      formula: "x = y + z",
      tags: ["tag with spaces", "normal-tag"],
    });

    const pullResult = pipeline.convertToMarkdown(pushResult.content, pullContext, {
      properties: pushResult.properties,
    });

    expect(pullResult).toContain("'Special: Characters & More'");
    expect(pullResult).toContain("Pipes | commas");
    expect(pullResult).toContain("formula: x = y + z");
    expect(pullResult).toContain("# Special Characters");
  });

  it("minimal-note.md 최소 문서 라운드트립", async () => {
    const input = await readFile(join(FIXTURES_DIR, "minimal-note.md"), "utf-8");
    const pushResult = pipeline.convertToNotion(input, pushContext);

    expect(pushResult.properties).toEqual({ title: "Minimal" });
    expect(pushResult.content).toContain("title: Minimal");
    expect(pushResult.content).toContain("Just one line.");

    const pullResult = pipeline.convertToMarkdown(pushResult.content, pullContext, {
      properties: pushResult.properties,
    });

    expect(pullResult).toContain("title: Minimal");
    expect(pullResult).toContain("Just one line.");
  });

  it("nested-structure-note.md 깊은 중첩 구조 보존", async () => {
    const input = await readFile(join(FIXTURES_DIR, "nested-structure-note.md"), "utf-8");
    const pushResult = pipeline.convertToNotion(input, pushContext);

    expect(pushResult.content).toContain("- A");
    expect(pushResult.content).toContain("  - A-1");
    expect(pushResult.content).toContain("    - A-1-a");
    expect(pushResult.content).toContain("      - A-1-a-i");
    expect(pushResult.content).toContain("1. Ordered top");
    expect(pushResult.content).toContain("   - Unordered child");
    expect(pushResult.content).toContain("> Level 1");
    expect(pushResult.content).toContain("- [ ] Parent task");
    expect(pushResult.content).toContain("  - [x] Sub task done");
    expect(pushResult.content).toContain("    - [x] Sub-sub done");

    expect(pushResult.properties).toEqual({ title: "Nested Structure", status: "review" });
  });

  it("완전 순환 Push→Pull 동일성: simple-note.md", async () => {
    const input = await readFile(join(FIXTURES_DIR, "simple-note.md"), "utf-8");
    const pushResult = pipeline.convertToNotion(input, pushContext);

    const pullResult = pipeline.convertToMarkdown(pushResult.content, pullContext, {
      properties: pushResult.properties,
    });

    const normalizedOutput = normalize(pullResult);

    expect(normalizedOutput).toContain("title: Simple Note");
    expect(normalizedOutput).toContain("status: active");
    expect(normalizedOutput).toContain("# Simple Note");
    expect(normalizedOutput).toContain("- Bullet point 1");
    expect(normalizedOutput).toContain("- [x] Completed task");
    expect(normalizedOutput).toContain("```typescript");
    expect(normalizedOutput).toContain("> This is a blockquote");
    expect(normalizedOutput).toContain("[External Link](https://github.com)");
  });

  it("media-embed-note.md 미디어 임베드 보존", async () => {
    const input = await readFile(join(FIXTURES_DIR, "media-embed-note.md"), "utf-8");
    const pushResult = pipeline.convertToNotion(input, pushContext);

    expect(pushResult.content).toContain("[🔊 Background Music](https://example.com/music.mp3)");
    expect(pushResult.content).toContain("[🎬 Tutorial Video](https://example.com/tutorial.mp4)");
    expect(pushResult.content).toContain("[📄 Project Spec](https://example.com/spec.pdf)");
    expect(pushResult.content).toContain("[📎 Data Export](https://example.com/data.csv)");
    expect(pushResult.properties).toEqual({ title: "Media Embed Test", tags: ["media", "test"] });
  });

  it("color-formatting-note.md 색상/밑줄 보존 마커 Push→Pull", async () => {
    const input = await readFile(join(FIXTURES_DIR, "color-formatting-note.md"), "utf-8");
    const pushResult = pipeline.convertToNotion(input, pushContext);

    expect(pushResult.content).toContain("%%im-nobsidian:color:red%%중요한 텍스트%%/color%%");
    expect(pushResult.content).toContain("%%im-nobsidian:underline%%밑줄 텍스트%%/underline%%");
    expect(pushResult.content).toContain("%%im-nobsidian:color:blue%%파란색%%/color%%");
    expect(pushResult.content).toContain("%%im-nobsidian:color:green%%녹색%%/color%%");

    const pullResult = pipeline.convertToMarkdown(pushResult.content, pullContext, {
      properties: pushResult.properties,
    });

    expect(pullResult).toContain("%%im-nobsidian:color:red%%중요한 텍스트%%/color%%");
    expect(pullResult).toContain("%%im-nobsidian:underline%%밑줄 텍스트%%/underline%%");
  });

  it("notion-only-blocks-note.md unknown 블록 보존 마커 라운드트립", async () => {
    const input = await readFile(join(FIXTURES_DIR, "notion-only-blocks-note.md"), "utf-8");
    const pushResult = pipeline.convertToNotion(input, pushContext);

    expect(pushResult.content).toContain("%%im-nobsidian:unknown:id=abc123&type=bookmark%%");
    expect(pushResult.content).toContain("%%im-nobsidian:unknown:id=def456&type=embed%%");
    expect(pushResult.content).toContain("Some normal text.");
    expect(pushResult.content).toContain("More text between blocks.");

    const pullResult = pipeline.convertToMarkdown(pushResult.content, pullContext, {
      properties: pushResult.properties,
    });

    expect(pullResult).toContain("%%im-nobsidian:unknown:id=abc123&type=bookmark%%");
    expect(pullResult).toContain("%%im-nobsidian:unknown:id=def456&type=embed%%");
  });

  it("complex-table-note.md 대형 테이블 + 서식 셀 보존", async () => {
    const input = await readFile(join(FIXTURES_DIR, "complex-table-note.md"), "utf-8");
    const pushResult = pipeline.convertToNotion(input, pushContext);

    expect(pushResult.content).toContain("| Name");
    expect(pushResult.content).toContain("| Age |");
    expect(pushResult.content).toContain("| Alice |");
    expect(pushResult.content).toContain("| **Bold feature** |");
    expect(pushResult.content).toContain("| `Code feature`");
    expect(pushResult.content).toContain("| R10C1 |");
    expect(pushResult.content).toContain("Text after table.");
    expect(pushResult.properties).toEqual({ title: "Complex Table Test" });
  });

  it("frontmatter-all-types.md 전체 속성 타입 라운드트립", async () => {
    const input = await readFile(join(FIXTURES_DIR, "frontmatter-all-types.md"), "utf-8");
    const pushResult = pipeline.convertToNotion(input, pushContext);

    const props = pushResult.properties;
    expect(props.title).toBe("All Property Types");
    expect(props.status).toBe("active");
    expect(props.tags).toEqual(["metadata", "comprehensive"]);
    expect(props.priority).toBe(7);
    expect(props.category).toBe("documentation");
    expect(props.author).toBe("jaylen");
    expect(props.email).toBe("test@example.com");
    expect(props.phone).toBe("010-1234-5678");
    expect(props.url).toBe("https://github.com/example");
    expect(props.reviewed).toBe(true);
    expect(props.score).toBe(95.5);
    expect(props.related).toEqual(["[[Project Plan]]", "[[Architecture]]"]);

    const pullResult = pipeline.convertToMarkdown(pushResult.content, pullContext, {
      properties: pushResult.properties,
    });

    expect(pullResult).toContain("title: All Property Types");
    expect(pullResult).toContain("priority: 7");
    expect(pullResult).toContain("score: 95.5");
    expect(pullResult).toContain("reviewed: true");
    expect(pullResult).toContain("email: test@example.com");
    expect(pullResult).toMatch(/url:.*https:\/\/github\.com\/example/);
  });

  it("mixed-callout-toggle.md 콜아웃+토글 조합 보존", async () => {
    const input = await readFile(join(FIXTURES_DIR, "mixed-callout-toggle.md"), "utf-8");
    const pushResult = pipeline.convertToNotion(input, pushContext);

    expect(pushResult.content).toContain("> [!note] Important Note");
    expect(pushResult.content).toContain("%%im-nobsidian:toggle:start%%");
    expect(pushResult.content).toContain("- Outer Toggle");
    expect(pushResult.content).toContain("- Inner Toggle");
    expect(pushResult.content).toContain("%%im-nobsidian:toggle:end%%");
    expect(pushResult.content).toContain("> [!warning] Warning with code");
    expect(pushResult.content).toContain("> [!tab] First Tab");
    expect(pushResult.content).toContain("> [!tab] Second Tab");
    expect(pushResult.properties).toEqual({
      title: "Mixed Callout Toggle",
      tags: ["callout", "toggle"],
    });
  });
});
