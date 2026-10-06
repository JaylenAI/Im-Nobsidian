import { describe, expect, it } from "vitest";
import { patchRichText, type RichTextItem } from "../../src/notion/rich-text.js";
import { PropertyMapper } from "../../src/notion/property-mapper.js";

// Notion 이 돌려주는 조각 모양(SDK 5.23.1 `RichTextItemResponse`) — 고칠 때 쓰는 만큼만.
const PLAIN = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default",
};
const BOLD = { ...PLAIN, bold: true };
const RED = { ...PLAIN, color: "red" };

function text(content: string, annotations = PLAIN, url?: string): RichTextItem {
  return {
    type: "text",
    plain_text: content,
    href: url ?? null,
    annotations,
    text: { content, link: url ? { url } : null },
  };
}

function userMention(name: string, id: string): RichTextItem {
  return {
    type: "mention",
    plain_text: `@${name}`,
    href: null,
    annotations: PLAIN,
    mention: { type: "user", user: { object: "user", id } },
  };
}

function equation(expression: string): RichTextItem {
  return {
    type: "equation",
    plain_text: expression,
    href: null,
    annotations: PLAIN,
    equation: { expression },
  };
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** 보낸 조각을 이으면 새 글이다 — 멘션 · 수식은 원래 글로 센다. */
function plainOf(requests: ReturnType<typeof patchRichText>, items: RichTextItem[]): string {
  return (requests ?? [])
    .map((r) => {
      if ("text" in r) return r.text.content;
      if ("equation" in r) return r.equation.expression;
      const id = (Object.values(r.mention)[0] as { id?: string }).id;
      return items.find((i) => (i.mention?.user as { id?: string } | undefined)?.id === id)!
        .plain_text;
    })
    .join("");
}

describe("patchRichText — 원격 서식 위에 바뀐 글자만 고친다 (F-08)", () => {
  it("한 조각 안을 고치면 그 조각의 서식으로 다시 한 조각이다", () => {
    const items = [text("가나다", BOLD), text(" 끝")];
    expect(patchRichText(items, "가X다 끝")).toEqual([
      { text: { content: "가X다" }, annotations: BOLD },
      { text: { content: " 끝" } },
    ]);
  });

  it("링크 조각 안을 고치면 링크도 남는다", () => {
    const items = [text("앞 "), text("문서 링크", PLAIN, "https://example.com/doc")];
    expect(patchRichText(items, "앞 문서 새 링크")).toEqual([
      { text: { content: "앞 " } },
      { text: { content: "문서 새 링크", link: { url: "https://example.com/doc" } } },
    ]);
  });

  it("끝에 붙인 글은 앞 조각의 서식을 따르고, 맨 앞에 붙인 글은 뒤 조각의 서식을 따른다", () => {
    const items = [text("굵게", BOLD), text(" 보통 "), text("빨강", RED)];
    expect(patchRichText(items, "굵게 보통 빨강!")).toEqual([
      { text: { content: "굵게" }, annotations: BOLD },
      { text: { content: " 보통 " } },
      { text: { content: "빨강!" }, annotations: RED },
    ]);
    expect(patchRichText(items, "아주 굵게 보통 빨강")![0]).toEqual({
      text: { content: "아주 굵게" },
      annotations: BOLD,
    });
  });

  it("조각 사이에 끼운 글은 앞 조각의 서식 — 링크는 따르지 않는다", () => {
    const items = [text("링크", BOLD, "https://example.com"), text("보통")];
    expect(patchRichText(items, "링크!보통")).toEqual([
      { text: { content: "링크", link: { url: "https://example.com" } }, annotations: BOLD },
      { text: { content: "!" }, annotations: BOLD },
      { text: { content: "보통" } },
    ]);
  });

  it("여러 조각에 걸친 편집은 그 첫 조각의 서식 — 남는 앞뒤는 제 서식 그대로", () => {
    const items = [text("굵게", BOLD), text("보통")];
    expect(patchRichText(items, "굵X통")).toEqual([
      { text: { content: "굵X" }, annotations: BOLD },
      { text: { content: "통" } },
    ]);
  });

  it("손대지 않은 멘션 · 수식은 그대로 다시 보낸다", () => {
    const items = [text("담당 "), userMention("Kim", "user-1"), text(" · "), equation("E=mc^2")];
    const out = patchRichText(items, "담당 @Kim · E=mc^2 확인");
    expect(out).toEqual([
      { text: { content: "담당 " } },
      { mention: { user: { id: "user-1" } } },
      { text: { content: " · " } },
      { equation: { expression: "E=mc^2" } },
      { text: { content: " 확인" } },
    ]);
  });

  it("멘션에 걸친 편집은 멘션을 글로 바꾼다 — 가운데 글자 하나만 고쳐도", () => {
    const items = [text("담당 "), userMention("Kim", "user-1"), text(" 확인")];
    expect(patchRichText(items, "담당 @Kin 확인")).toEqual([
      { text: { content: "담당 @Kin 확인" } },
    ]);
    expect(patchRichText(items, "담당 김 확인")).toEqual([{ text: { content: "담당 김 확인" } }]);
  });

  it("다시 보낼 수 없는 멘션(링크 미리보기)은 그 주소로 건 글로 보낸다", () => {
    const url = "https://github.com/example/repo";
    const items: RichTextItem[] = [
      {
        type: "mention",
        plain_text: url,
        href: url,
        annotations: PLAIN,
        mention: { type: "link_preview", link_preview: { url } },
      },
      text(" 참고"),
    ];
    expect(patchRichText(items, `${url} 참고함`)).toEqual([
      { text: { content: url, link: { url } } },
      { text: { content: " 참고함" } },
    ]);
  });

  it("날짜 멘션은 날짜 값 그대로 다시 보낸다", () => {
    const date = { start: "2026-10-01", end: null, time_zone: null };
    const items: RichTextItem[] = [
      text("마감 "),
      {
        type: "mention",
        plain_text: "2026-10-01",
        href: null,
        annotations: PLAIN,
        mention: { type: "date", date },
      },
    ];
    expect(patchRichText(items, "새 마감 2026-10-01")).toEqual([
      { text: { content: "새 마감 " } },
      { mention: { date } },
    ]);
  });

  it("서로게이트 쌍(이모지)을 가르지 않는다", () => {
    const items = [text("ab😀", BOLD), text("😀z")];
    for (const next of ["ab😁😀z", "ab😀😁z", "😁b😀😀z", "ab😀😀"]) {
      const out = patchRichText(items, next)!;
      expect(plainOf(out, items)).toBe(next);
      for (const r of out) if ("text" in r) expect(r.text.content).not.toMatch(LONE_SURROGATE);
    }
  });

  it("모두 지우면 빈 배열 · 이어 붙여도 새 글과 같다", () => {
    const items = [text("굵게", BOLD), text(" 보통")];
    expect(patchRichText(items, "")).toEqual([]);
    for (const next of ["굵", "보통", "굵게 보통 더", "완전히 다른 글"]) {
      expect(plainOf(patchRichText(items, next), items)).toBe(next);
    }
  });

  it("조각이 100개를 넘으면 null — 호출측이 평문으로 보낸다", () => {
    const items = Array.from({ length: 100 }, (_, i) => text("a", i % 2 ? BOLD : PLAIN));
    const old = "a".repeat(100);
    expect(patchRichText(items, old + "x".repeat(4500))).toBeNull();
    expect(patchRichText(items, old + "x")).toHaveLength(100);
  });
});

describe("PropertyMapper.toNotionPropertyChanges — 원격 서식을 지킨다 (F-08)", () => {
  function mapper(): PropertyMapper {
    const m = new PropertyMapper({ timeZone: "Asia/Seoul" });
    m.loadSchema({ 이름: { id: "title", type: "title" }, 설명: { id: "d", type: "rich_text" } });
    return m;
  }
  const remote = {
    이름: { type: "title", title: [text("과제 "), text("A", BOLD)] },
    설명: {
      type: "rich_text",
      rich_text: [text("굵은 글", BOLD), text("과 링크", PLAIN, "https://x.y")],
    },
  };

  it("글 속성 · 제목은 원격 조각 위에 고친다", () => {
    const { properties } = mapper().toNotionPropertyChanges(
      { changed: { 설명: "굵은 새 글과 링크" }, cleared: [] },
      "과제 AB",
      { remote },
    );
    expect(properties).toEqual({
      title: {
        title: [{ text: { content: "과제 " } }, { text: { content: "AB" }, annotations: BOLD }],
      },
      설명: {
        rich_text: [
          { text: { content: "굵은 새 글" }, annotations: BOLD },
          { text: { content: "과 링크", link: { url: "https://x.y" } } },
        ],
      },
    });
  });

  it("원격을 모르면 평문으로 보낸다 — 예전과 같다", () => {
    const { properties } = mapper().toNotionPropertyChanges(
      { changed: { 설명: "굵은 새 글과 링크" }, cleared: [] },
      "과제 AB",
    );
    expect(properties).toEqual({
      title: { title: [{ text: { content: "과제 AB" } }] },
      설명: { rich_text: [{ text: { content: "굵은 새 글과 링크" } }] },
    });
  });
});
