import { describe, it, expect } from "vitest";
import { MathNormalizer } from "../../src/converter/pre-processors/math.js";
import { EmbedResolver } from "../../src/converter/pre-processors/embed.js";
import { InlineDBParser } from "../../src/converter/pre-processors/inline-db.js";
import { PreserveMarkerCollector } from "../../src/converter/pre-processors/preserve-marker.js";
import { InlineAnnotationPreserver } from "../../src/converter/pre-processors/html-annotation.js";
import { obsidianToNotionEnhanced } from "../../src/converter/enhanced-md-converter.js";
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

  it("타임존 오프셋 자정 시각 정규화 (KST)", () => {
    const result = processor.process({
      content: "# Test",
      metadata: { properties: { created: "2026-05-15T00:00:00.000+09:00" } },
      context: pullContext,
    });
    // D3: 날짜는 Obsidian 저작 관행대로 따옴표 없이 직렬화된다
    expect(result.content).toContain("created: 2026-05-15\n");
    expect(result.content).not.toContain("T00:00:00");
  });

  it("자정 시각 UTC 정규화", () => {
    const result = processor.process({
      content: "# Test",
      metadata: { properties: { due: "2026-06-30T00:00:00.000Z" } },
      context: pullContext,
    });
    expect(result.content).toContain("due: 2026-06-30\n");
  });

  it("빈 배열 속성 프론트매터에서 제외", () => {
    const result = processor.process({
      content: "# Test",
      metadata: { properties: { tags: [], status: "active" } },
      context: pullContext,
    });
    expect(result.content).not.toContain("tags:");
    expect(result.content).toContain("status: active");
  });

  it("본문이 `---`(divider)로 시작해도 frontmatter 생성·속성 보존 (gray-matter 재파싱 footgun)", () => {
    // Notion divider 등으로 본문이 `---`로 시작하면 gray-matter 의 string-arg stringify 가
    // 그 `---…---` 블록을 frontmatter 로 오인 파싱하다 throw → 속성 전체가 유실되던 회귀.
    const body = "---\n**돌아보기** *(Notion DB)*\n**지식** *(Notion DB)*\n---\n\n본문";
    const result = processor.process({
      content: body,
      metadata: { properties: { status: "active", category: "study" } },
      context: pullContext,
    });

    // 1) frontmatter 가 실제로 생성됐다(스킵되지 않음).
    expect(result.content.startsWith("---\n")).toBe(true);
    expect(result.content).toContain("status: active");
    expect(result.content).toContain("category: study");
    // 2) 본문이 한 글자도 손실 없이 보존됐다.
    expect(result.content).toContain(body);
  });
});

describe("InlineAnnotationPreserver (I3 무손실 underline/color push)", () => {
  const processor = new InlineAnnotationPreserver();
  const transform = (content: string): string =>
    processor.process({ content, metadata: {}, context: pushContext }).content;

  it("Push 시 <u> → compact underline 마커로 승격(제거 아님)", () => {
    expect(transform("This is <u>underlined</u> text")).toBe(
      "This is %%im-nobsidian:underline%%underlined%%/underline%% text",
    );
  });

  it("Push 시 color span → compact color 마커", () => {
    expect(transform('This is <span class="notion-red">red</span> text')).toBe(
      "This is %%im-nobsidian:color:red%%red%%/color%% text",
    );
  });

  it("Push 시 background color span(-bg) → _background 색상 마커", () => {
    expect(transform('This is <span class="notion-yellow-bg">highlighted</span> text')).toBe(
      "This is %%im-nobsidian:color:yellow_background%%highlighted%%/color%% text",
    );
  });

  it("Push 시 공백형 im-nobsidian color 마커 → compact color 마커", () => {
    expect(
      transform("This is %% im-nobsidian:color:red %%colored%% im-nobsidian:end %% text"),
    ).toBe("This is %%im-nobsidian:color:red%%colored%%/color%% text");
  });

  it("Pull 방향에서는 동작하지 않음(원본 보존)", () => {
    const result = processor.process({
      content: "This is <u>underlined</u> text",
      metadata: {},
      context: pullContext,
    });
    expect(result.content).toBe("This is <u>underlined</u> text");
  });

  it("여러 표기 동시 승격", () => {
    expect(
      transform(
        '<u>bold</u> and <span class="notion-blue">blue</span> and %% im-nobsidian:color:green %%green%% im-nobsidian:end %%',
      ),
    ).toBe(
      "%%im-nobsidian:underline%%bold%%/underline%% and %%im-nobsidian:color:blue%%blue%%/color%% and %%im-nobsidian:color:green%%green%%/color%%",
    );
  });

  it("승격된 마커는 obsidianToNotionEnhanced 가 Notion span 으로 무손실 복원", () => {
    // <u>·color span → compact 마커 → push 직전 단일 SSOT → Notion Enhanced-MD span
    const promoted = transform(
      'A <u>u</u> and <span class="notion-red">r</span> and <span class="notion-blue-bg">b</span>',
    );
    expect(obsidianToNotionEnhanced(promoted)).toBe(
      'A <span underline="true">u</span> and <span color="red">r</span> and <span color="blue_background">b</span>',
    );
  });
});
