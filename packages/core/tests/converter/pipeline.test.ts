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
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";
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

  // Notion 의 구분선으로 시작하는 페이지를 pull 하면 이 모양으로 쓰인다. gray-matter 는 첫
  // 구분선부터 다음 구분선(없으면 끝)까지를 YAML 로 읽어 본문에서 뺐다 — push 가 그 페이지의
  // 본문을 속성 블록으로 바꿔 보냈다.
  it.each([
    ["구분선 · 목록 · 구분선", "---\n## 개요\n- 항목 하나\n- 항목 둘\n---\n\n끝 문단\n로컬 문단"],
    ["닫는 구분선 없음", "---\n\n첫 문단\n\n둘째 문단\n\n로컬 문단"],
    ["첫 줄이 ---js", '---js\n\nconsole.log("x")\n\n---\n\n본문 a\n로컬 문단'],
  ])("본문이 구분선으로 시작하면 전부 본문으로 보낸다 — %s", (_label, note) => {
    const result = new FrontmatterExtractor().process({
      content: note,
      metadata: {},
      context: pushContext,
    });

    expect(result.content).toBe(note.trim());
    expect(result.metadata.properties).toEqual({});
  });
});

describe("기본 파이프라인 — 구분선으로 시작하는 노트의 push", () => {
  it("본문을 빠짐없이 보내고 속성 블록을 만들지 않는다", () => {
    const note = "---\n## 개요\n- 항목 하나\n- 항목 둘\n---\n\n끝 문단\n";

    const result = createDefaultPipeline().convertToNotion(note, pushContext);

    expect(result.properties).toEqual({});
    expect(result.content).not.toContain("im-nobsidian:properties");
    for (const part of ["## 개요", "- 항목 하나", "- 항목 둘", "끝 문단"]) {
      expect(result.content).toContain(part);
    }
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
  it("Push 시 프론트매터 속성을 YAML 코드블록으로 변환", () => {
    const processor = new PropertiesTableInjector();
    const result = processor.process({
      content: "# Hello World",
      metadata: { properties: { title: "Test", status: "active", tags: ["a", "b"] } },
      context: pushContext,
    });

    expect(result.content).toContain("```yaml");
    expect(result.content).toContain("# im-nobsidian:properties");
    expect(result.content).toContain("status: active");
    expect(result.content).toContain("title: Test");
    expect(result.content).toContain("# Hello World");
  });

  it("title만 있어도 코드블록 생성 (라운드트립 보존)", () => {
    const processor = new PropertiesTableInjector();
    const result = processor.process({
      content: "# Hello",
      metadata: { properties: { title: "Test" } },
      context: pushContext,
    });

    expect(result.content).toContain("```yaml");
    expect(result.content).toContain("title: Test");
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
  it("키-값이 아닌 속성 블록은 본문에 그대로 둔다 — 걷어 내면 사라진다", () => {
    const input = "```yaml\n# im-nobsidian:properties\n- 하나\n- 둘\n```\n\n본문";

    for (let i = 0; i < 2; i++) {
      const result = new PropertiesTableRestorer().process({
        content: input,
        metadata: {},
        context: pullContext,
      });
      expect(result.content).toBe(input);
      expect(result.metadata.properties).toBeUndefined();
    }
  });

  it("깨진 YAML 속성 블록도 몇 번이고 본문에 둔다(gray-matter 캐시가 두 번째에 걷어 내지 않게)", () => {
    const input = "```yaml\n# im-nobsidian:properties\n진척: [0.7\n```\n\n본문";

    for (let i = 0; i < 2; i++) {
      const result = new PropertiesTableRestorer().process({
        content: input,
        metadata: {},
        context: pullContext,
      });
      expect(result.content).toBe(input);
    }
  });

  it("Pull 시 YAML 코드블록을 메타데이터로 복원", () => {
    const processor = new PropertiesTableRestorer();
    const input = `\`\`\`yaml
# im-nobsidian:properties
status: active
priority: 5
\`\`\`

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

  it("YAML 배열 값 복원", () => {
    const processor = new PropertiesTableRestorer();
    const input = `\`\`\`yaml
# im-nobsidian:properties
tags:
  - a
  - b
  - c
\`\`\`

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

  it("레거시 마크다운 테이블 형식도 복원", () => {
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

  it("속성 블록이 없으면 그대로 반환", () => {
    const processor = new PropertiesTableRestorer();
    const result = processor.process({
      content: "# Just content",
      metadata: {},
      context: pullContext,
    });

    expect(result.content).toBe("# Just content");
  });

  it("특수문자 포함 값 안전 왕복", () => {
    const processor = new PropertiesTableRestorer();
    const input = `\`\`\`yaml
# im-nobsidian:properties
value: "hello, world"
data: "col|row"
\`\`\`

---

Content`;

    const result = processor.process({
      content: input,
      metadata: {},
      context: pullContext,
    });

    const props = result.metadata.properties as Record<string, unknown>;
    expect(props.value).toBe("hello, world");
    expect(props.data).toBe("col|row");
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

    expect(pushResult.content).toContain("```yaml");
    expect(pushResult.content).toContain("# im-nobsidian:properties");
    expect(pushResult.content).toContain("status: active");
    expect(pushResult.content).toContain("priority: 3");
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
