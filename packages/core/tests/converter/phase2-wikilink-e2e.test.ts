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

    // 등록된 페이지: mention 은 라벨을 못 가져 대상 페이지의 현재 제목만 렌더한다 —
    // 별칭을 살리려면 라벨을 가질 수 있는 일반 페이지 링크로 나가야 한다(D-ALIAS-LOST).
    const push1 = pipeline.convertToNotion("See [[My Note|내 노트]] here.", pushCtx);
    expect(push1.content).toContain("[내 노트](https://www.notion.so/pageaaa111)");
    expect(push1.content).not.toContain("<mention-page");

    // 미등록 페이지
    const push2 = pipeline.convertToNotion("See [[Future|미래]] here.", pushCtx);
    expect(push2.content).toContain("[미래](im-nobsidian://wikilink/Future)");

    const pull2 = pipeline.convertToMarkdown(push2.content, pullCtx);
    expect(pull2).toContain("[[Future|미래]]");
  });

  /*
   * 노트 임베드는 의사 프로토콜로 바꾸지 않고 원문 그대로 올린다 — 바꿔 올리면 Notion 이
   * 미지원 스킴을 버려 `![[대상]]` 이 평문으로 영구 붕괴한다(라이브 실측, I13).
   */
  it("![[노트임베드]] 왕복 보존 — 원문 그대로", () => {
    const pipeline = createPipeline();
    const input = "Embed: ![[other-note]]";
    const push = pipeline.convertToNotion(input, pushCtx);

    expect(push.content).toContain("![[other-note]]");

    const pull = pipeline.convertToMarkdown(push.content, pullCtx);
    expect(pull).toContain("![[other-note]]");
  });

  it("![[image.png]] vs ![[note]] 구분 처리", () => {
    const pipeline = createPipeline();
    const input = "Image: ![[photo.png]]\nNote: ![[ref-note]]";
    const push = pipeline.convertToNotion(input, pushCtx);

    // 이미지는 업로드 자리표시자로, 노트는 손대지 않은 원문으로 갈린다.
    expect(push.content).toContain("📎 photo.png");
    expect(push.content).toContain("![[ref-note]]");
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

    // NFM 정준형: 아이콘은 본문 이모지가 아니라 여는 태그의 icon 속성 (ADR-008)
    expect(notion).toContain('<callout icon="⚠️">');
    expect(notion).toContain("\t주의사항");
    expect(notion).not.toContain("::: callout");

    const back = notionEnhancedToObsidian(notion);
    // 기본 아이콘(type 기본 이모지)은 마커 없이 원문 그대로 수렴해야 한다
    expect(back).toContain("> [!warning] 주의사항");
    expect(back).toContain("> 이 부분은 중요합니다.");
    expect(back).not.toContain("callout-style");
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
    expect(push.content).toContain("![[reference-note]]");
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

/*
 * D-WIKI-CODEFENCE — 코드 구간의 `[[…]]` 까지 링크로 바꿔 Notion 화면을 깨뜨리던 결함.
 *
 * Obsidian 은 코드 펜스·인라인 코드 안의 `[[…]]` 를 링크로 렌더하지 않는데, 예전 push 는
 * 본문 전체를 무차별 치환해 위키링크 문법을 설명하는 코드블록이 Notion 에서
 * `[코드 안 링크](im-nobsidian://wikilink/%EC%BD%94…)` 라는 URL 범벅으로 보였다.
 * pull 이 되돌리므로 왕복 테스트는 초록이었다 — Notion 쪽 화면만 깨졌다.
 */
describe("코드 구간 위키링크 보호 (D-WIKI-CODEFENCE)", () => {
  const pipeline = createPipeline();
  const toNotion = (input: string) => pipeline.convertToNotion(input, pushCtx).content;

  it("펜스 코드블록 안 [[링크]] 는 원문 그대로", () => {
    const input = "본문 [[Unknown]] 하나.\n\n```md\n예시: [[코드 안 링크]]\n```";
    const out = toNotion(input);
    expect(out).toContain("```md\n예시: [[코드 안 링크]]\n```");
    // 코드 밖 본문은 여전히 변환된다.
    expect(out).toContain("im-nobsidian://wikilink/Unknown");
  });

  it("인라인 코드 안 [[링크]] 도 원문 그대로", () => {
    expect(toNotion("인라인 `[[인라인 안 링크]]` 하나.")).toBe("인라인 `[[인라인 안 링크]]` 하나.");
  });

  it("해소되는 링크도 코드 안에서는 mention 으로 승격되지 않는다", () => {
    expect(toNotion("```\n[[My Note]]\n```")).toBe("```\n[[My Note]]\n```");
  });

  it("코드 뒤 본문 링크의 보존 마커 offset 이 원문 기준으로 남는다", () => {
    // 코드 구간을 건너뛰면서 조각 단위로 치환하므로, 앵커·offset 이 조각이 아니라
    // **원문** 기준이어야 pull 재삽입이 엉뚱한 자리를 찍지 않는다(F28 교훈).
    const input = "```\n[[코드 안]]\n```\n\n뒤 본문 [[Unknown]] 하나.";
    const markers =
      new WikilinkResolver(fakeResolver).process({
        content: input,
        metadata: {},
        context: pushCtx,
      }).metadata.preserveMarkers ?? [];
    expect(markers).toHaveLength(1);
    expect(markers[0]!.startIndex).toBe(input.indexOf("[[Unknown]]"));
    expect(markers[0]!.params.__anchor).toBe("뒤 본문 ");
  });
});
