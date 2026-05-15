import { describe, it, expect } from "vitest";
import { MathNormalizer } from "../../src/converter/pre-processors/math.js";
import { EmbedResolver } from "../../src/converter/pre-processors/embed.js";
import { InlineDBParser } from "../../src/converter/pre-processors/inline-db.js";
import { PreserveMarkerCollector } from "../../src/converter/pre-processors/preserve-marker.js";
import { HtmlAnnotationStripper } from "../../src/converter/pre-processors/html-annotation.js";
import { ColorAnnotator } from "../../src/converter/post-processors/color-annotator.js";
import { FrontmatterGenerator } from "../../src/converter/post-processors/frontmatter-generator.js";
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

describe("MathNormalizer", () => {
  const processor = new MathNormalizer();

  it("인라인 수식 보존", () => {
    const result = processor.process({
      content: "The formula $E = mc^2$ is famous",
      metadata: {},
      context: pushContext,
    });
    expect(result.content).toContain("$E = mc^2$");
  });

  it("블록 수식 정규화 (줄바꿈 추가)", () => {
    const result = processor.process({
      content: "$$\\int_0^1 x dx$$",
      metadata: {},
      context: pushContext,
    });
    expect(result.content).toContain("$$\n\\int_0^1 x dx\n$$");
  });

  it("수식 아닌 달러 기호 무시", () => {
    const result = processor.process({
      content: "Price is $100 and $$200",
      metadata: {},
      context: pushContext,
    });
    expect(result.content).toBe("Price is $100 and $$200");
  });
});

describe("EmbedResolver", () => {
  const processor = new EmbedResolver();

  it("![[image.png]] → push 시 플레이스홀더 생성", () => {
    const result = processor.process({
      content: "Image: ![[photo.png]]",
      metadata: {},
      context: pushContext,
    });
    expect(result.content).toContain("📎 photo.png");
    expect(result.content).toContain("%% im-nobsidian:local-image:photo.png %%");
    expect(result.content).not.toContain("업로드 불가");
    expect(result.metadata.images).toHaveLength(1);
    expect(result.metadata.images![0]!.isExternal).toBe(false);
  });

  it("![[note.md]] → 보존 링크 (이미지가 아닌 embed)", () => {
    const result = processor.process({
      content: "Embed: ![[other-note.md]]",
      metadata: {},
      context: pushContext,
    });
    expect(result.content).toContain("[other-note.md](im-nobsidian://embed/other-note.md)");
    expect(result.content).not.toContain("![[");
  });

  it("YouTube URL → video preserve marker", () => {
    const result = processor.process({
      content: "![video](https://youtube.com/watch?v=abc123)",
      metadata: {},
      context: pushContext,
    });
    expect(result.content).toContain("im-nobsidian:embed:type=video");
  });
});

describe("InlineDBParser", () => {
  const processor = new InlineDBParser();

  it("preserve marker로 감싼 테이블 파싱", () => {
    const input = `Before
%% im-nobsidian:inline-db:id=abc123&title=Tasks %%
| Name | Status |
|------|--------|
| Task 1 | Done |
%% im-nobsidian:end %%
After`;

    const result = processor.process({
      content: input,
      metadata: {},
      context: pushContext,
    });

    const blocks = result.metadata["inlineDbBlocks"] as Array<{ id: string; title: string }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.id).toBe("abc123");
    expect(blocks[0]!.title).toBe("Tasks");
  });
});

describe("PreserveMarkerCollector", () => {
  const processor = new PreserveMarkerCollector();

  it("여러 마커 수집", () => {
    const input = `%% im-nobsidian:callout:type=tip&foldable=open %%
> [!tip] Hint

%% im-nobsidian:color:red %%text%% im-nobsidian:end %%`;

    const result = processor.process({
      content: input,
      metadata: {},
      context: pushContext,
    });

    expect(result.metadata.preserveMarkers).toHaveLength(2);
    expect(result.metadata.preserveMarkers![0]!.type).toBe("callout");
    expect(result.metadata.preserveMarkers![1]!.type).toBe("color");
  });
});

describe("ColorAnnotator", () => {
  const processor = new ColorAnnotator();

  it("color marker → span 변환", () => {
    const result = processor.process({
      content: "%% im-nobsidian:color:red %%important%% im-nobsidian:end %%",
      metadata: {},
      context: pullContext,
    });
    expect(result.content).toBe('<span class="notion-red">important</span>');
  });

  it("background color → -bg 클래스", () => {
    const result = processor.process({
      content: "%% im-nobsidian:color:yellow_background %%highlighted%% im-nobsidian:end %%",
      metadata: {},
      context: pullContext,
    });
    expect(result.content).toBe('<span class="notion-yellow-bg">highlighted</span>');
  });
});

describe("FrontmatterGenerator", () => {
  const processor = new FrontmatterGenerator();

  it("properties → YAML frontmatter 생성", () => {
    const result = processor.process({
      content: "# Hello",
      metadata: { properties: { title: "Test", status: "active" } },
      context: pullContext,
    });

    expect(result.content).toContain("---");
    expect(result.content).toContain("title: Test");
    expect(result.content).toContain("status: active");
    expect(result.content).toContain("# Hello");
  });

  it("properties 없으면 그대로 반환", () => {
    const result = processor.process({
      content: "# Hello",
      metadata: {},
      context: pullContext,
    });
    expect(result.content).toBe("# Hello");
  });
});

describe("HtmlAnnotationStripper", () => {
  const processor = new HtmlAnnotationStripper();

  it("Push 시 <u> 태그를 제거", () => {
    const result = processor.process({
      content: "This is <u>underlined</u> text",
      metadata: {},
      context: pushContext,
    });
    expect(result.content).toBe("This is underlined text");
  });

  it("Push 시 color span을 제거", () => {
    const result = processor.process({
      content: 'This is <span class="notion-red">red</span> text',
      metadata: {},
      context: pushContext,
    });
    expect(result.content).toBe("This is red text");
  });

  it("Push 시 background color span을 제거", () => {
    const result = processor.process({
      content: 'This is <span class="notion-yellow-bg">highlighted</span> text',
      metadata: {},
      context: pushContext,
    });
    expect(result.content).toBe("This is highlighted text");
  });

  it("Push 시 im-nobsidian color 마커를 제거", () => {
    const result = processor.process({
      content: "This is %% im-nobsidian:color:red %%colored%% im-nobsidian:end %% text",
      metadata: {},
      context: pushContext,
    });
    expect(result.content).toBe("This is colored text");
  });

  it("Pull 방향에서는 동작하지 않음", () => {
    const result = processor.process({
      content: "This is <u>underlined</u> text",
      metadata: {},
      context: pullContext,
    });
    expect(result.content).toBe("This is <u>underlined</u> text");
  });

  it("여러 태그 동시 처리", () => {
    const result = processor.process({
      content:
        '<u>bold</u> and <span class="notion-blue">blue</span> and %% im-nobsidian:color:green %%green%% im-nobsidian:end %%',
      metadata: {},
      context: pushContext,
    });
    expect(result.content).toBe("bold and blue and green");
  });
});
