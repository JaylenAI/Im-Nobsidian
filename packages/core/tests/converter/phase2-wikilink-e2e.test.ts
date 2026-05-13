import { describe, it, expect } from "vitest";
import { ConversionPipeline } from "../../src/converter/pipeline.js";
import { FrontmatterExtractor } from "../../src/converter/pre-processors/frontmatter.js";
import { WikilinkResolver } from "../../src/converter/pre-processors/wikilink.js";
import { EmbedResolver } from "../../src/converter/pre-processors/embed.js";
import { MentionToWikilink } from "../../src/converter/post-processors/mention-to-wikilink.js";
import { FrontmatterGenerator } from "../../src/converter/post-processors/frontmatter-generator.js";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";
import type { ConversionContext, WikilinkEntry } from "../../src/types/convert.js";

const pushCtx: ConversionContext = {
  direction: "push",
  path: "markdown-api",
  filePath: "test.md",
};
const pullCtx: ConversionContext = {
  direction: "pull",
  path: "markdown-api",
  filePath: "test.md",
};

const fakeDb: Record<string, WikilinkEntry> = {
  "My Note": {
    obsidianPath: "my-note.md",
    notionPageId: "page-aaa-111",
    title: "My Note",
    aliases: [],
  },
  "Project Plan": {
    obsidianPath: "project-plan.md",
    notionPageId: "page-bbb-222",
    title: "Project Plan",
    aliases: [],
  },
};
const fakeResolver = (text: string) => fakeDb[text] ?? null;

function createPipeline() {
  const pipeline = new ConversionPipeline();
  pipeline.registerPreProcessor(new FrontmatterExtractor());
  pipeline.registerPreProcessor(new WikilinkResolver(fakeResolver));
  pipeline.registerPreProcessor(new EmbedResolver());
  pipeline.registerPostProcessor(new MentionToWikilink());
  pipeline.registerPostProcessor(new FrontmatterGenerator());
  return pipeline;
}

describe("Phase 2 E2E: 위키링크 ↔ 페이지 멘션 완전 왕복", () => {
  it("등록된 [[위키링크]] → <mention-page> 변환", () => {
    const pipeline = createPipeline();
    const input = "See [[My Note]] and [[Project Plan]] for details.";
    const result = pipeline.convertToNotion(input, pushCtx);

    expect(result.content).toContain('<mention-page id="page-aaa-111">My Note</mention-page>');
    expect(result.content).toContain('<mention-page id="page-bbb-222">Project Plan</mention-page>');
    expect(result.content).not.toContain("[[");
  });

  it("미등록 [[위키링크]] → 보존 링크 → Pull 완전 복원", () => {
    const pipeline = createPipeline();
    const input = "Link to [[Unknown Page]] here.";
    const push = pipeline.convertToNotion(input, pushCtx);

    expect(push.content).toContain("im-nobsidian://wikilink/Unknown%20Page");

    const pull = pipeline.convertToMarkdown(push.content, pullCtx);
    expect(pull).toContain("[[Unknown Page]]");
    expect(pull).not.toContain("im-nobsidian://");
  });

  it("[[target|display]] 별명 위키링크 왕복", () => {
    const pipeline = createPipeline();

    // 등록된 페이지
    const push1 = pipeline.convertToNotion("See [[My Note|내 노트]] here.", pushCtx);
    expect(push1.content).toContain('<mention-page id="page-aaa-111">내 노트</mention-page>');

    // 미등록 페이지
    const push2 = pipeline.convertToNotion("See [[Future|미래]] here.", pushCtx);
    expect(push2.content).toContain("[미래](im-nobsidian://wikilink/Future)");

    const pull2 = pipeline.convertToMarkdown(push2.content, pullCtx);
    expect(pull2).toContain("[[Future|미래]]");
  });

  it("![[노트임베드]] 왕복 보존", () => {
    const pipeline = createPipeline();
    const input = "Embed: ![[other-note]]";
    const push = pipeline.convertToNotion(input, pushCtx);

    expect(push.content).toContain("im-nobsidian://embed/other-note");
    expect(push.content).not.toContain("![[");

    const pull = pipeline.convertToMarkdown(push.content, pullCtx);
    expect(pull).toContain("![[other-note]]");
  });

  it("![[image.png]] vs ![[note]] 구분 처리", () => {
    const pipeline = createPipeline();
    const input = "Image: ![[photo.png]]\nNote: ![[ref-note]]";
    const push = pipeline.convertToNotion(input, pushCtx);

    expect(push.content).toContain("📎 photo.png");
    expect(push.content).toContain("im-nobsidian://embed/ref-note");
  });

  it("프론트매터 내 [[위키링크]] 보존 (제거 안 됨)", () => {
    const pipeline = createPipeline();
    const input = `---
title: Doc
related: "[[My Note]]"
---

# Content`;

    const push = pipeline.convertToNotion(input, pushCtx);
    expect((push.properties as Record<string, unknown>).related).toBe("[[My Note]]");
  });

  it("Notion enhanced markdown → [[위키링크]] 변환 (Pull)", () => {
    const notion = 'Check <mention-page id="xyz">Important Doc</mention-page> here.';
    const obsidian = notionEnhancedToObsidian(notion);

    expect(obsidian).toContain("[[Important Doc]]");
    expect(obsidian).not.toContain("<mention-page");
  });

  it("callout 왕복 (obsidian → notion → obsidian)", () => {
    const obsidian = "> [!warning] 주의사항\n> 이 부분은 중요합니다.";
    const notion = obsidianToNotionEnhanced(obsidian);

    expect(notion).toContain("::: callout");

    const back = notionEnhancedToObsidian(notion);
    expect(back).toContain("> [!warning] 주의사항");
    expect(back).toContain("> 이 부분은 중요합니다.");
  });

  it("복합 문서 전체 왕복 (등록/미등록/임베드/이미지/코드)", () => {
    const pipeline = createPipeline();
    const input = `---
title: Complex Doc
tags:
  - test
aliases:
  - CD
related: "[[My Note]]"
---

# Complex Document

See [[My Note]] for context and [[Unknown Future Note]] for plans.

## Embedded Notes

![[reference-note]]
![[diagram.png]]

## Code

\`\`\`typescript
const x = 42;
\`\`\``;

    const push = pipeline.convertToNotion(input, pushCtx);

    expect(push.content).toContain('<mention-page id="page-aaa-111">My Note</mention-page>');
    expect(push.content).toContain("im-nobsidian://wikilink/Unknown%20Future%20Note");
    expect(push.content).toContain("im-nobsidian://embed/reference-note");
    expect(push.content).toContain("📎 diagram.png");
    expect(push.content).toContain("```typescript");
    expect((push.properties as Record<string, unknown>).related).toBe("[[My Note]]");

    const pull = pipeline.convertToMarkdown(push.content, pullCtx, {
      properties: push.properties,
    });

    expect(pull).toContain("[[Unknown Future Note]]");
    expect(pull).toContain("![[reference-note]]");
    expect(pull).toContain("```typescript");
    expect(pull).not.toContain("im-nobsidian://");
  });
});
