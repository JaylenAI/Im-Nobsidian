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

  const push = (content: string): string =>
    processor.process({ content, metadata: {}, context: pushContext }).content;

  it("한 줄로 쓴 블록 수식도 제 줄에 세운다 — Notion 은 한 줄 $$ x $$ 를 빈 수식 둘로 읽는다", () => {
    expect(push("앞\n\n$$ x^2 $$\n\n뒤")).toBe("앞\n\n$$\nx^2\n$$\n\n뒤");
  });

  it("블록 수식이 여럿이면 저마다 세운다", () => {
    expect(push("$$a$$\n\n문단\n\n$$b$$")).toBe("$$\na\n$$\n\n문단\n\n$$\nb\n$$");
  });

  // S-21 — 코드 안의 $ 는 코드다. 셸 예제가 수식으로 바뀌어 Notion 의 코드가 달라졌다.
  it("코드 펜스 안의 $ 는 그대로다 — 셸의 $HOME · $$(PID) · 산술 확장", () => {
    const code = "```bash\n$ echo $HOME\necho $$\nx=$(( $a + $b ))\n```";
    expect(push(code)).toBe(code);
  });

  it("인라인 코드 안의 $ 는 그대로다", () => {
    const text = "실행: `$ echo $HOME` 과 `echo $$`";
    expect(push(text)).toBe(text);
  });

  it("인라인 코드 둘의 $$ 가 짝지어지지 않는다", () => {
    const text = "PID 는 `echo $$` 로, 끝내기는 `kill $$`";
    expect(push(text)).toBe(text);
  });

  // 줄 가운데의 $$ 는 줄머리 규칙이 이미 두므로, 코드 가드만 막는 것은 제 줄로 선 $$ … $$ 다.
  it("빈 줄이 든 코드 펜스 속 제 줄의 $$ … $$ 도 코드다 — 인라인 코드로는 막지 못하는 모양", () => {
    const code = "```latex\n$$ E = mc^2 $$\n\n$$ a^2 + b^2 = c^2 $$\n```";
    expect(push(code)).toBe(code);
  });

  it("여러 줄 인라인 코드 속 제 줄의 $$ … $$ 도 코드다", () => {
    const text = "`예시:\n$$ x^2 $$\n끝`";
    expect(push(text)).toBe(text);
  });

  it("코드 속 $$ 가 코드 밖 블록 수식의 $$ 와 짝지어지지 않는다", () => {
    const md = "```sh\necho $$\n```\n\n$$ x $$";
    expect(push(md)).toBe("```sh\necho $$\n```\n\n$$\nx\n$$");
  });

  it("식이 $$ 줄에 붙은 여러 줄 블록 수식을 편다 — Notion 은 빈 수식과 글로 읽는다", () => {
    expect(push("$$ a^2\nb^2 $$")).toBe("$$\na^2\nb^2\n$$");
  });

  // 콜아웃 · 목록 안의 수식은 새 줄에도 줄머리를 단다. 닫는 $$ 가 콜아웃 밖으로 나가면 Notion 이
  // 뒤 문단을 수식으로 삼켰다(실측, 실볼트 4파일).
  it.each([
    ["콜아웃 제목 줄에서 여는 수식(실볼트 모양)", "> [!note] $$\n> \\textbf{A}\n> $$\n\n뒤 문단"],
    ["콜아웃 본문의 수식", "> [!note] 제목\n> $$\n> x^2\n> $$\n\n뒤 문단"],
    ["빈 인용 줄이 든 수식", "> $$\n> a\n>\n> b\n> $$"],
    ["목록 자식 수식", "- 항목\n    $$\n    x^2\n    $$"],
  ])("제 줄에 선 수식은 줄머리째 그대로다 — %s", (_name, md) => {
    expect(push(md)).toBe(md);
  });

  it("콜아웃 안 한 줄 블록 수식은 줄머리를 달고 세운다", () => {
    expect(push("> [!note] 제목\n> $$ x^2 $$")).toBe("> [!note] 제목\n> $$\n> x^2\n> $$");
  });

  it("빈 인용 줄이 든 수식도 줄머리를 달고 편다", () => {
    expect(push("> $$ a\n>\n> b $$")).toBe("> $$\n> a\n>\n> b\n> $$");
  });

  it("목록 자식 한 줄 블록 수식은 들여쓰기를 달고 세운다", () => {
    expect(push("- 항목\n    $$ x^2 $$")).toBe("- 항목\n    $$\n    x^2\n    $$");
  });

  it("짝이 인용 밖으로 넘어가면 그대로 둔다", () => {
    const md = "> $$\n> x\n\n$$\ny\n$$";
    expect(push(md)).toBe(md);
  });

  it("식이 빈 $$ $$ 는 그대로 둔다", () => {
    expect(push("$$ $$")).toBe("$$ $$");
  });

  // 글과 한 줄에 있는 $$…$$ 는 Notion 이 인라인 수식으로 읽는다 — 줄을 가르면 빈 수식과 글이 된다(실측).
  it.each([
    ["글 사이", "앞 $$x^2$$ 뒤"],
    ["줄 끝", "앞 $$x^2$$"],
    ["줄 머리", "$$x^2$$ 뒤"],
    ["목록 줄", "- $$x^2$$"],
  ])("글과 한 줄에 있는 $$…$$ 는 그대로다 — %s", (_name, text) => {
    expect(push(text)).toBe(text);
  });

  // 인라인 수식은 노트 그대로 보낸다 — Obsidian 과 Notion 이 같은 규칙으로 수식을 가린다.
  it.each([
    ["여는 쪽 · 닫는 쪽 공백", "공백 $ x $ 달러"],
    ["여는 쪽 공백", "여는 쪽 $ x$ 끝"],
    ["닫는 쪽 공백", "닫는 쪽 $x $ 끝"],
    ["통화 둘", "가격 $5 and $10 이다"],
    ["통화 범위", "금액 $1,000 ~ $2,000"],
    ["닫는 $ 뒤 숫자", "뒤에 숫자 $x$1 끝"],
  ])("수식이 아닌 달러는 글자 그대로다 — %s", (_name, text) => {
    expect(push(text)).toBe(text);
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

  it("![[note.md]] → 원문 그대로 (의사 프로토콜은 Notion 이 버린다)", () => {
    const result = processor.process({
      content: "Embed: ![[other-note.md]]",
      metadata: {},
      context: pushContext,
    });
    // 예전엔 `[대상](im-nobsidian://embed/…)` 로 바꿔 올렸다 — Notion 이 미지원 스킴을
    // 링크째 버리고 라벨만 남겨 `![[대상]]` 이 평문으로 영구 붕괴했다(라이브 실측, I13).
    expect(result.content).toBe("Embed: ![[other-note.md]]");
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

  it("코드 안의 <u> · 색 span · ==…== 는 글자 그대로 둔다", () => {
    const fenced = '```html\n<u>u</u> <span class="notion-red">r</span> ==h==\n```';
    expect(transform(fenced)).toBe(fenced);
    const inline = "`<u>u</u>` 와 `a==b==c`";
    expect(transform(inline)).toBe(inline);
    expect(transform("`x` 뒤 <u>u</u> ==h==")).toBe(
      "`x` 뒤 %%im-nobsidian:underline%%u%%/underline%% %%im-nobsidian:color:yellow_bg%%h%%/color%%",
    );
  });

  it("서식 안에 인라인 코드가 들어도 승격한다 — 코드를 사이에 둔 짝", () => {
    expect(transform("==a `b` c== <u>d `e`</u>")).toBe(
      "%%im-nobsidian:color:yellow_bg%%a `b` c%%/color%% %%im-nobsidian:underline%%d `e`%%/underline%%",
    );
  });

  it("콜아웃 안 코드블록의 <u> 도 글자 그대로 둔다", () => {
    const md = "> [!note]\n> ```html\n> <u>u</u> ==h==\n> ```";
    expect(transform(md)).toBe(md);
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
