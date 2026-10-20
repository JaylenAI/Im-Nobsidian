/**
 * C14 — 블록 방식 push 가 NFM 을 Notion 이 Markdown API 로 만드는 블록과 같은 블록으로 만드는지.
 *
 * 픽스처(`tests/fixtures/nfm/notion-import/`)는 탐침 페이지에 NFM 을 Markdown API 로 보내 Notion 이 만든
 * 블록 트리다(2026-10-12). `notion` 이 Notion 의 결과, `ours` · `why` 는 일부러 다르게 만드는 곳과 그
 * 까닭이다 — Notion 이 내용을 잃는 곳만 다르다. id 는 가짜로 바꿨다.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vaultBookmarks } from "../../src/converter/bookmark.js";
import { obsidianToNotionEnhanced } from "../../src/converter/enhanced-md-converter.js";
import { nfmToBlocks, type NfmBlock } from "../../src/converter/nfm-to-blocks.js";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";
import { RICH_TEXT_CONTENT_MAX } from "../../src/constants/notion-limits.js";
import { blockOutline } from "../helpers/block-outline.js";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "nfm",
  "notion-import",
);

interface ImportFixture {
  readonly markdown: string;
  readonly notion: string[];
  readonly ours?: string[];
  readonly why?: string;
}

const outline = (nfm: string) => blockOutline(nfmToBlocks(nfm) as never);
const body = (block: NfmBlock) => block[block.type] as Record<string, unknown>;

describe("nfmToBlocks — Notion 의 Markdown 가져오기와 같은 블록", () => {
  const names = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));

  it("픽스처가 있다", () => {
    expect(names.length).toBeGreaterThanOrEqual(20);
  });

  for (const name of names) {
    const fixture = JSON.parse(
      readFileSync(join(FIXTURE_DIR, `${name}.json`), "utf8"),
    ) as ImportFixture;
    it(`${name}${fixture.why ? ` — ${fixture.why}` : ""}`, () => {
      expect(outline(fixture.markdown)).toEqual(fixture.ours ?? fixture.notion);
    });
  }
});

describe("nfmToBlocks — 블록 API 로 만들 수 없는 것", () => {
  it("자식 페이지 · DB 태그와 바로가기는 버린다 — 다른 페이지를 옮기지 않는다", () => {
    const nfm = [
      '<page url="https://app.notion.com/p/00000001000040008000000000000000">자식</page>',
      '<database url="https://app.notion.com/p/00000002000040008000000000000000" inline="true">DB</database>',
      '<unknown url="https://app.notion.com/p/00000003000040008000000000000000" alt="alias"/>',
      "끝",
    ].join("\n");
    expect(outline(nfm)).toEqual(['paragraph {} T"끝"']);
  });

  it("주소를 모르는 북마크는 버리고, 볼트 링크 쌍이 주소를 주면 북마크로 만든다", () => {
    const placeholder =
      "https://app.notion.com/p/00000001000040008000000000000000#0000000200004000800000000000000a";
    const nfm = `<unknown url="${placeholder}" alt="bookmark"/>`;
    expect(nfmToBlocks(nfm)).toEqual([]);
    const blocks = nfmToBlocks(nfm, {
      bookmarks: new Map([[placeholder, { url: "https://example.com/a", caption: "캡션" }]]),
    });
    expect(blockOutline(blocks as never)).toEqual([
      'bookmark {"url":"https://example.com/a"}  cap:T"캡션"',
    ]);
  });

  it("볼트 주소가 아닌 미디어(로컬 파일)는 블록 API 가 거부하므로 글로 둔다", () => {
    expect(outline("![그림](attachments/a.png)")).toEqual([
      'paragraph {} T"!" + T"그림"→attachments/a.png',
    ]);
  });

  it("동기화 참조는 원본 블록을, 원본은 새 원본을 만든다", () => {
    const blocks = nfmToBlocks(
      [
        '<synced_block_reference url="https://app.notion.com/p/00000001000040008000000000000000#00000002-0000-4000-8000-00000000000a">',
        "\t참조 내용",
        "</synced_block_reference>",
        '<synced_block url="https://app.notion.com/p/00000001000040008000000000000000#0000000300004000800000000000000b">',
        "\t원본 내용",
        "</synced_block>",
      ].join("\n"),
    );
    expect(blocks.map((b) => body(b).synced_from)).toEqual([
      { type: "block_id", block_id: "00000002-0000-4000-8000-00000000000a" },
      null,
    ]);
    expect(body(blocks[0]!).children).toBeUndefined();
    expect(blockOutline(blocks.slice(1) as never)).toEqual([
      "synced_block {} ",
      '  paragraph {} T"원본 내용"',
    ]);
  });
});

describe("nfmToBlocks — 블록 모양", () => {
  it("콜아웃 아이콘 — 이모지 · Notion 아이콘(이름 · 색) · 외부 그림", () => {
    const icon = (attr: string) =>
      body(nfmToBlocks(`<callout icon="${attr}">\n\t글\n</callout>`)[0]!).icon;
    expect(icon("💡")).toEqual({ type: "emoji", emoji: "💡" });
    expect(icon("/icons/drafts_lightgray.svg")).toEqual({
      type: "icon",
      icon: { name: "drafts", color: "lightgray" },
    });
    expect(icon("/icons/bug.svg")).toEqual({ type: "icon", icon: { name: "bug" } });
    expect(icon("https://example.com/i.png")).toEqual({
      type: "external",
      external: { url: "https://example.com/i.png" },
    });
  });

  it("색 없는 목차는 기본색을 보낸다 — 빼고 보내면 블록 API 가 회색으로 만든다", () => {
    expect(
      nfmToBlocks('<table_of_contents/>\n<table_of_contents color="gray"/>').map(body),
    ).toEqual([{ color: "default" }, { color: "gray" }]);
  });

  it("자식이 없으면 children 을 보내지 않는다 — 자식을 받지 못하는 블록이 거부되지 않게", () => {
    const blocks = nfmToBlocks("- 하나\n---\n<details>\n<summary>빈 토글</summary>\n</details>");
    expect(blocks.map((b) => "children" in body(b))).toEqual([false, false, false]);
  });

  it("빈 칼럼은 빈 문단을 품는다 — 칼럼은 블록 하나는 있어야 만들어진다", () => {
    const blocks = nfmToBlocks(
      "<columns>\n\t<column>\n\t</column>\n\t<column>\n\t\t글\n\t</column>\n</columns>",
    );
    expect(blockOutline(blocks as never)).toEqual([
      "column_list {} ",
      "  column {} ",
      "    paragraph {} ",
      "  column {} ",
      '    paragraph {} T"글"',
    ]);
  });

  it("긴 코드는 rich text 한도로 나눠 담는다", () => {
    const code = "x".repeat(RICH_TEXT_CONTENT_MAX + 5);
    const [block] = nfmToBlocks(`\`\`\`\n${code}\n\`\`\``);
    const texts = body(block!).rich_text as Array<{ text: { content: string } }>;
    expect(texts.map((t) => t.text.content.length)).toEqual([RICH_TEXT_CONTENT_MAX, 5]);
  });

  it("GFM 표 — 칸 속 \\| 는 칸을 가르지 않는다", () => {
    expect(outline("| a | b |\n| --- | --- |\n| c \\| d | e |")).toEqual([
      'table {"has_column_header":true,"table_width":2} ',
      '  row T"a" | T"b"',
      '  row T"c | d" | T"e"',
    ]);
  });

  it("다시 만들 수 없는 인라인 멘션은 웹 주소면 링크로 남긴다", () => {
    expect(
      outline(
        '가 <unknown_mention url="https://example.com/p" alt="미리보기"/> 나 <unknown_mention url="notion://x"/>끝',
      ),
    ).toEqual(['paragraph {} T"가 " + T"미리보기"→https://example.com/p + T" 나 끝"']);
  });
});

describe("볼트 노트 → 블록 방식 push 의 블록", () => {
  const PUSH = { direction: "push", path: "markdown-api", filePath: "a.md" } as const;
  const blocksOf = (note: string) => {
    const content = createDefaultPipeline().convertToNotion(note, PUSH).content;
    return nfmToBlocks(obsidianToNotionEnhanced(content), { bookmarks: vaultBookmarks(content) });
  };

  it("콜아웃 · 할 일 · 수식이 글이나 인용으로 바뀌지 않는다", () => {
    const note = ["> [!tip] 제목", "> 본문", "", "- [ ] 할 일", "", "$$", "E = mc^2", "$$"].join(
      "\n",
    );
    expect(blockOutline(blocksOf(note) as never).map((l) => l.trim().split(" ")[0])).toEqual([
      "callout",
      "paragraph",
      "to_do",
      "equation",
    ]);
  });

  it("북마크는 볼트 링크 쌍의 주소 · 캡션으로 만든다", () => {
    const placeholder =
      "https://app.notion.com/p/00000001000040008000000000000000#0000000200004000800000000000000a";
    const note = `[🔖 캡션](https://example.com/a)%%im-nobsidian:unknown:id=${encodeURIComponent(placeholder)}&type=bookmark%%`;
    expect(blockOutline(blocksOf(note) as never)).toEqual([
      'bookmark {"url":"https://example.com/a"}  cap:T"캡션"',
    ]);
  });

  it("로컬 그림 자리 표시는 인용 블록의 글 그대로 남는다 — push 뒤 업로드가 그 블록을 찾는다", () => {
    const quote = "> 📎 a.png %% im-nobsidian:local-image:a.png %%";
    const [block] = nfmToBlocks(quote);
    expect(block!.type).toBe("quote");
    const texts = body(block!).rich_text as Array<{ text: { content: string } }>;
    expect(texts.map((t) => t.text.content).join("")).toBe(
      "📎 a.png %% im-nobsidian:local-image:a.png %%",
    );
  });
});
