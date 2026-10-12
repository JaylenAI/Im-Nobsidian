/**
 * 블록 폴백(A3 · C9 · C10) — 블록 API 로 받은 노트가 Markdown API 로 받은 노트와 같은 볼트 모양이 되고,
 * 블록 방식 push 가 마커 글자를 Notion 에 남기지 않는지.
 *
 * 블록 API 모양은 2026-10-12 탐침 페이지에서 잰 그대로다(`date.start` 의 오프셋 · 사용자 `type` ·
 * Markdown API 의 북마크 자리 주소).
 */
import { describe, it, expect } from "vitest";
import type { Client } from "@notionhq/client";
import { BlockConverter } from "../../src/converter/block-converter.js";
import { obsidianToNotionEnhanced } from "../../src/converter/enhanced-md-converter.js";
import { formatMention, markMentions } from "../../src/converter/rich-text-converter.js";
import { blockDateAttrs, markersToMentions } from "../../src/converter/mention.js";
import { escapeLiteralDollars } from "../../src/converter/literal-dollar.js";

const PERSON = "3e713b18-d382-81aa-bbbb-0123456789ab";
const PAGE = "3f713b18-d382-81b8-82db-fc01ee1a7061";
const BLOCK = "3f713b18-d382-81d1-8f3f-d3725bb3dbcf";
const PAGE32 = PAGE.replace(/-/g, "");
const BLOCK32 = BLOCK.replace(/-/g, "");

const THROWING_CLIENT = new Proxy(
  {},
  {
    get() {
      throw new Error("오프라인 위반: Notion 클라이언트가 호출됨");
    },
  },
) as unknown as Client;

const PLAIN = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default",
};

function text(content: string) {
  return {
    type: "text",
    text: { content, link: null },
    plain_text: content,
    href: null,
    annotations: PLAIN,
  };
}

function mention(value: Record<string, unknown>, plain: string, href: string | null = null) {
  return { type: "mention", mention: value, plain_text: plain, href, annotations: PLAIN };
}

function block(type: string, payload: Record<string, unknown>, id = `blk-${type}`) {
  return { object: "block", id, type, has_children: false, [type]: payload };
}

function converter(): BlockConverter {
  const c = new BlockConverter();
  c.initNotionToMd(THROWING_CLIENT);
  return c;
}

/** 블록 방식 push 결과의 글 조각 — 수식은 `[EQ:식]`. */
function pushedText(markdown: string): string {
  const blocks = new BlockConverter().markdownToNotionBlocks(markdown) as Array<
    Record<
      string,
      {
        rich_text?: Array<{
          type: string;
          text?: { content: string };
          equation?: { expression: string };
        }>;
      }
    >
  >;
  return blocks
    .map((b) =>
      (b[b.type as unknown as string]?.rich_text ?? [])
        .map((r) => (r.type === "equation" ? `[EQ:${r.equation!.expression}]` : r.text!.content))
        .join(""),
    )
    .join("\n");
}

describe("블록 폴백 pull — 날짜 멘션 (A3)", () => {
  // 왼쪽은 블록 API 의 date, 오른쪽은 같은 멘션을 Markdown API 가 내보낸 속성(실측).
  it.each([
    [{ start: "2026-09-26" }, [["start", "2026-09-26"]]],
    [
      { start: "2026-09-26", end: "2026-09-27" },
      [
        ["start", "2026-09-26"],
        ["end", "2026-09-27"],
      ],
    ],
    [
      { start: "2026-09-26T09:00:00.000+09:00" },
      [
        ["start", "2026-09-26"],
        ["startTime", "09:00"],
        ["timeZone", "Etc/GMT-9"],
      ],
    ],
    [
      { start: "2026-09-26T09:00:00.000+09:00", end: "2026-09-27T18:00:00.000+09:00" },
      [
        ["start", "2026-09-26"],
        ["startTime", "09:00"],
        ["end", "2026-09-27"],
        ["endTime", "18:00"],
        ["timeZone", "Etc/GMT-9"],
      ],
    ],
    [
      { start: "2026-09-26T09:00:00.000+00:00" },
      [
        ["start", "2026-09-26"],
        ["startTime", "09:00"],
        ["timeZone", "UTC"],
      ],
    ],
    [
      { start: "2026-09-26T09:00:00.000-05:00" },
      [
        ["start", "2026-09-26"],
        ["startTime", "09:00"],
        ["timeZone", "Etc/GMT+5"],
      ],
    ],
  ])("%j → Markdown API 와 같은 속성", (date, attrs) => {
    expect(blockDateAttrs(date)).toEqual(attrs);
  });

  it("시 단위가 아닌 오프셋은 같은 순간을 UTC 로 적는다 — 날이 바뀌어도", () => {
    expect(blockDateAttrs({ start: "2026-09-26T03:00:00.000+05:30" })).toEqual([
      ["start", "2026-09-25"],
      ["startTime", "21:30"],
      ["timeZone", "UTC"],
    ]);
  });

  it("끝의 오프셋이 다르면 시작의 오프셋으로 옮겨 적는다", () => {
    expect(
      blockDateAttrs({ start: "2026-09-26T09:00:00+09:00", end: "2026-09-26T10:00:00+00:00" }),
    ).toEqual([
      ["start", "2026-09-26"],
      ["startTime", "09:00"],
      ["end", "2026-09-26"],
      ["endTime", "19:00"],
      ["timeZone", "Etc/GMT-9"],
    ]);
  });

  it("오프셋 없는 시각은 시간대 이름과 함께일 때만 읽는다", () => {
    expect(blockDateAttrs({ start: "2026-09-26T09:00:00", time_zone: "Asia/Seoul" })).toEqual([
      ["start", "2026-09-26"],
      ["startTime", "09:00"],
      ["timeZone", "Asia/Seoul"],
    ]);
    expect(blockDateAttrs({ start: "2026-09-26T09:00:00" })).toBeNull();
  });

  it("한쪽에만 시각이 있거나 읽지 못하는 모양이면 null", () => {
    expect(blockDateAttrs({ start: "2026-09-26", end: "2026-09-27T09:00:00+09:00" })).toBeNull();
    expect(blockDateAttrs({ start: "2026-09-26", end: "모레" })).toBeNull();
  });

  it("시각 있는 멘션의 볼트 글은 Markdown API 경로와 같다 — push 가 같은 태그로 되돌린다", () => {
    const vault = formatMention(
      { type: "date", date: { start: "2026-09-26T09:00:00.000+09:00" } },
      "2026-09-26T09:00:00.000+09:00",
    );
    expect(vault).toContain("2026-09-26 09:00 (UTC+9)");
    expect(markersToMentions(vault)).toBe(
      '<mention-date start="2026-09-26" startTime="09:00" timeZone="Etc/GMT-9"/>',
    );
  });
});

describe("블록 폴백 pull — 사용자 · 페이지 멘션 (A3)", () => {
  it("사람은 짝 마커 — push 가 멘션으로 되돌린다", () => {
    const vault = formatMention(
      { type: "user", user: { id: PERSON, name: "사람", type: "person" } },
      "@사람",
    );
    expect(vault).toBe(`%%im-nobsidian:mention-user:url=user%3A%2F%2F${PERSON}%%@사람%%/mention%%`);
    expect(markersToMentions(vault)).toBe(
      `<mention-user url="user://${PERSON}">사람</mention-user>`,
    );
  });

  it("봇은 글로 둔다 — Markdown API 는 봇 멘션을 내보내지 않는다", () => {
    expect(
      formatMention({ type: "user", user: { id: PERSON, name: "연동", type: "bot" } }, "@연동"),
    ).toBe("@연동");
  });

  it("notion-to-md 의 기본 렌더(문단 · 제목 · 목록 · 표 칸)도 멘션을 볼트 글로 받는다", async () => {
    const md = await converter().notionBlockArrayToMarkdown([
      block("paragraph", {
        rich_text: [
          text("U "),
          mention({ type: "user", user: { id: PERSON, name: "사람", type: "person" } }, "@사람"),
          text(" P "),
          mention({ type: "page", page: { id: PAGE } }, "제목", `https://www.notion.so/${PAGE32}`),
          text(" D "),
          mention({ type: "date", date: { start: "2026-09-26", end: null } }, "2026-09-26"),
        ],
        color: "default",
      }),
      block("heading_2", {
        rich_text: [mention({ type: "date", date: { start: "2026-09-27" } }, "2026-09-27")],
        is_toggleable: false,
        color: "default",
      }),
      block("bulleted_list_item", {
        rich_text: [mention({ type: "page", page: { id: PAGE } }, "제목")],
        color: "default",
      }),
    ]);
    expect(md).toContain(
      `U %%im-nobsidian:mention-user:url=user%3A%2F%2F${PERSON}%%@사람%%/mention%%`,
    );
    expect(md).toContain(`P [[notion:${PAGE32}]]`);
    expect(md).toContain("D %%im-nobsidian:mention-date:start=2026-09-26%%2026-09-26%%/mention%%");
    expect(md).toContain("## %%im-nobsidian:mention-date:start=2026-09-27%%");
    expect(md).toContain(`- [[notion:${PAGE32}]]`);
    expect(md).not.toContain("notion.so");
  });

  it("멘션의 서식은 남는다 · 바꿀 멘션이 없는 조각은 그대로다", () => {
    const bold = { ...PLAIN, bold: true };
    const items = [
      {
        ...mention({ type: "date", date: { start: "2026-09-26" } }, "2026-09-26"),
        annotations: bold,
      },
      mention({ type: "link_preview", link_preview: { url: "https://x" } }, "https://x"),
    ];
    const [date, preview] = markMentions(items as never[]) as Array<Record<string, unknown>>;
    expect(date).toMatchObject({ type: "text", annotations: bold, href: null });
    expect(preview).toBe(items[1]);
  });
});

describe("블록 폴백 pull — 북마크 · 임베드 (C10)", () => {
  const bookmark = (caption: string) =>
    block(
      "bookmark",
      { url: "https://example.com/a(b)", caption: caption ? [text(caption)] : [] },
      BLOCK,
    );

  it("북마크는 Markdown API 경로와 같은 링크 · 마커 한 쌍 — push 가 원래 블록을 남긴다", async () => {
    const md = (await converter().notionBlockArrayToMarkdown([bookmark("캡션 [1]")], PAGE)).trim();
    const placeholder = `https://app.notion.com/p/${PAGE32}#${BLOCK32}`;
    expect(md).toBe(
      `[🔖 캡션 \\[1\\]](https://example.com/a%28b%29)%%im-nobsidian:unknown:id=${encodeURIComponent(placeholder)}&type=bookmark%%`,
    );
    expect(obsidianToNotionEnhanced(md)).toBe(`<unknown url="${placeholder}" alt="bookmark"/>`);
  });

  it("캡션이 없으면 이름이 주소다", async () => {
    const md = (await converter().notionBlockArrayToMarkdown([bookmark("")], PAGE)).trim();
    expect(md.startsWith("[🔖 https://example.com/a(b)](https://example.com/a%28b%29)%%")).toBe(
      true,
    );
  });

  it("페이지를 모르면 링크만 둔다", async () => {
    const md = (await converter().notionBlockArrayToMarkdown([bookmark("캡션")])).trim();
    expect(md).toBe("[🔖 캡션](https://example.com/a%28b%29)");
  });

  it("임베드는 마커와 한 쌍 — push 가 임베드 블록으로 되돌린다", async () => {
    const md = (
      await converter().notionBlockArrayToMarkdown([
        block("embed", { url: "https://example.com/watch?v=1&t=2", caption: [text("설명")] }),
      ])
    ).trim();
    expect(md).toBe(
      "[🔗 Embed](https://example.com/watch?v=1&t=2)%%im-nobsidian:embed:src=https%3A%2F%2Fexample.com%2Fwatch%3Fv%3D1%26t%3D2%%",
    );
    expect(obsidianToNotionEnhanced(md)).toBe(
      '<embed src="https://example.com/watch?v=1&t=2"></embed>',
    );
  });
});

describe("블록 방식 push — 북마크 · 임베드 · 남은 마커", () => {
  const placeholder = encodeURIComponent(`https://app.notion.com/p/${PAGE32}#${BLOCK32}`);

  it("한 줄 북마크 쌍은 북마크 블록 — 캡션 · 주소를 되읽는다", () => {
    const blocks = new BlockConverter().markdownToNotionBlocks(
      [
        `[🔖 캡션 \\[1\\]](https://example.com/a%28b%29)%%im-nobsidian:unknown:id=${placeholder}&type=bookmark%%`,
        "",
        `[🔖 https://example.com/b](https://example.com/b)%%im-nobsidian:unknown:id=${placeholder}&type=bookmark%%`,
      ].join("\n"),
    );
    expect(blocks).toEqual([
      {
        object: "block",
        type: "bookmark",
        bookmark: {
          url: "https://example.com/a(b)",
          caption: [
            expect.objectContaining({ text: expect.objectContaining({ content: "캡션 [1]" }) }),
          ],
        },
      },
      { object: "block", type: "bookmark", bookmark: { url: "https://example.com/b" } },
    ]);
  });

  it("원래 주소를 모르는 북마크 · 글 사이의 쌍은 링크로 두고 마커만 걷는다", () => {
    const unresolved = `https://app.notion.com/p/${PAGE32}#${BLOCK32}`;
    const text = pushedText(
      [
        `[🔖 Bookmark](${unresolved})%%im-nobsidian:unknown:id=${placeholder}&type=bookmark%%`,
        "",
        `앞 [🔖 캡션](https://example.com/c)%%im-nobsidian:unknown:id=${placeholder}&type=bookmark%% 뒤`,
      ].join("\n"),
    );
    expect(text).toBe("🔖 Bookmark\n앞 🔖 캡션 뒤");
  });

  it("캡션 없는 북마크는 이름이 주소 — 괄호가 든 주소도 캡션을 만들지 않는다", () => {
    expect(
      new BlockConverter().markdownToNotionBlocks(
        `[🔖 https://example.com/a(b)](https://example.com/a%28b%29)%%im-nobsidian:unknown:id=${placeholder}&type=bookmark%%`,
      ),
    ).toEqual([
      { object: "block", type: "bookmark", bookmark: { url: "https://example.com/a(b)" } },
    ]);
  });

  it("한 줄 임베드 쌍은 임베드 블록", () => {
    expect(
      new BlockConverter().markdownToNotionBlocks(
        "[🔗 Embed](https://example.com/x)%%im-nobsidian:embed:src=https%3A%2F%2Fexample.com%2Fx%%",
      ),
    ).toEqual([{ object: "block", type: "embed", embed: { url: "https://example.com/x" } }]);
  });

  it("되돌리지 못한 마커는 글자를 남기지 않는다 — 보이는 글은 남는다", () => {
    const markdown = [
      "## %%im-nobsidian:unknown-mention:url=notion%3A%2F%2Fcustom_emoji%2F1&alt=custom_emoji%%이름 붙은 섹션",
      "",
      "%%im-nobsidian:unknown:id=0000aaaa1111bbbb&type=button%%",
      "",
      "> [!note] %%im-nobsidian:callout-style:icon=%F0%9F%92%A1&color=gray_bg%%제목",
      "",
      "%%im-nobsidian:toggle-heading%%",
      "### 접는 제목",
      "%%im-nobsidian:toggle-heading:end%%",
    ].join("\n");
    const json = JSON.stringify(new BlockConverter().markdownToNotionBlocks(markdown));
    expect(json).not.toContain("im-nobsidian");
    expect(json).toContain("이름 붙은 섹션");
    expect(json).toContain("접는 제목");
  });

  it("목차 · 토글 · 칼럼 마커는 그대로 블록이 된다", () => {
    const blocks = new BlockConverter().markdownToNotionBlocks(
      ["%%im-nobsidian:toc:color=gray%%", "", "%%im-nobsidian:breadcrumb%%"].join("\n"),
    ) as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual(["table_of_contents", "breadcrumb"]);
  });

  it("토글 안의 마커 · 임베드 쌍도 같다", () => {
    const blocks = new BlockConverter().markdownToNotionBlocks(
      [
        "%%im-nobsidian:toggle:start%%",
        "- 토글",
        "  %%im-nobsidian:mention-user:url=user%3A%2F%2Fx%%@사람%%/mention%% 안",
        "",
        "  [🔗 Embed](https://example.com/x)%%im-nobsidian:embed:src=https%3A%2F%2Fexample.com%2Fx%%",
        "%%im-nobsidian:toggle:end%%",
      ].join("\n"),
    ) as Array<{ type: string; toggle: { children: Array<{ type: string }> } }>;
    expect(JSON.stringify(blocks)).not.toContain("im-nobsidian");
    expect(blocks[0]!.toggle.children.map((b) => b.type)).toEqual(["paragraph", "embed"]);
  });

  it("코드 안의 마커는 사용자가 적은 글자다 — 건드리지 않는다", () => {
    const blocks = new BlockConverter().markdownToNotionBlocks(
      "```\n%%im-nobsidian:unknown:id=1&type=button%% $5 and $10\n```",
    );
    expect(JSON.stringify(blocks)).toContain(
      "%%im-nobsidian:unknown:id=1&type=button%% $5 and $10",
    );
  });
});

describe("블록 방식 push — `$` (C9)", () => {
  // 오른쪽은 같은 줄을 Markdown API 로 보냈을 때 Notion 이 만든 것(2026-10-12 실측, 탐침 두 장).
  it.each([
    ["$a $b$", "$a [EQ:b]"],
    ["$a$b$", "$a$b$"],
    ["$a$ $b $c$", "[EQ:a] $b [EQ:c]"],
    ["x $a\\$b$ y", "x $a$b$ y"],
    ["$5 and $10$", "$5 and [EQ:10]"],
    ["$a$, $b$.", "[EQ:a], [EQ:b]."],
    ["($a$)", "([EQ:a])"],
    ["$a$x", "$a$x"],
    ["$ab", "$ab"],
    ["a$b$c", "a$b$c"],
    ["\\$a$", "$a$"],
    ["$a$$b$", "$a$$b$"],
    ["$x$1 $y$", "$x$1 [EQ:y]"],
    ["가격 $5 와 $10 · $ x $", "가격 $5 와 $10 · $ x $"],
    ["글 $$x$$ 글", "글 [EQ:x] 글"],
    ["$ a$ y", "$ a$ y"],
    ["$a\\$ $c$", "[EQ:a\\] [EQ:c]"],
    ["\\$a$ $b$", "$a$ [EQ:b]"],
    ["$a\\$ b", "[EQ:a\\] b"],
    ["$a $", "$a $"],
  ])("%s → Notion 과 같은 곳만 수식", (markdown, expected) => {
    expect(pushedText(markdown)).toBe(expected);
  });

  it("블록 수식의 식 줄은 건드리지 않는다", () => {
    expect(escapeLiteralDollars("$$\n\\text{$x$ 와 $ y}\n$$")).toBe("$$\n\\text{$x$ 와 $ y}\n$$");
    expect(escapeLiteralDollars("> $$\n> a $ b\n> $$\n$5")).toBe("> $$\n> a $ b\n> $$\n\\$5");
  });

  it("인라인 코드 안의 `$` 는 코드다", () => {
    expect(pushedText("`$a$` 와 $5")).toBe("$a$ 와 $5");
  });
});
