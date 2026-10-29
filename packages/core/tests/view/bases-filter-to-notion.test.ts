import { describe, it, expect } from "vitest";
import { basesFilterToNotion } from "../../src/view/bases-filter-to-notion.js";
import { translateNotionFilter } from "../../src/view/notion-filter-translator.js";
import { resolvePropertyName } from "../../src/view/property-resolver.js";
import type { BasePropertySchema } from "../../src/types/view.js";

/**
 * P4 — 볼트에서 고친 `.base` 필터를 Notion 보기 필터로(ADR-046).
 *
 * 옮긴 필터가 Notion 에서 다른 행을 고르면 보기 하나가 조용히 틀린다. 그래서 (1) pull 이 쓴 꼴은 되돌려도 같은
 * 식이 되고, (2) Obsidian 필터 화면이 쓰는 꼴(따옴표 없는 이름 · `!` 함수)을 읽고, (3) 모르는 꼴은 필터 전체를
 * 거절한다는 것을 못 박는다.
 */

const SCHEMA: Record<string, BasePropertySchema> = {
  이름: { id: "title", type: "title" },
  메모: { id: "BNv%5C", type: "rich_text" },
  점수: { id: "rvGG", type: "number" },
  상태: { id: "vc%3AX", type: "select", options: [{ name: "가" }, { name: "나" }] },
  단계: { id: "st1", type: "status", options: [{ name: "시작 전" }, { name: "완료" }] },
  태그: { id: "QFXr", type: "multi_select", options: [{ name: "x" }, { name: "y" }] },
  완료: { id: "WF%3C%3E", type: "checkbox" },
  마감: { id: "%7BqgF", type: "date" },
  "마감 일": { id: "d2", type: "date" },
  합계: { id: "f1", type: "formula" },
};

const toNotion = (node: unknown) => basesFilterToNotion(node, SCHEMA);
const ok = (node: unknown) => {
  const result = toNotion(node);
  if (!result.ok) throw new Error(result.error);
  return result.filter;
};
const forward = (filter: unknown) =>
  translateNotionFilter(filter, SCHEMA, (id) => resolvePropertyName(id, SCHEMA)).node;

describe("basesFilterToNotion — pull 이 쓴 꼴은 되돌려도 같은 식", () => {
  const filters: Array<[string, unknown]> = [
    ["텍스트 같음", { property: "BNv\\", rich_text: { equals: "첫" } }],
    ["텍스트 포함 안 함", { property: "BNv\\", rich_text: { does_not_contain: 'a"b' } }],
    [
      "시작 · 끝",
      {
        and: [
          { property: "title", title: { starts_with: "하" } },
          { property: "title", title: { ends_with: "나" } },
        ],
      },
    ],
    [
      "숫자 비교",
      {
        and: [
          { property: "rvGG", number: { greater_than_or_equal_to: 3 } },
          { property: "rvGG", number: { less_than: 9.5 } },
        ],
      },
    ],
    ["체크박스", { property: "WF<>", checkbox: { equals: true } }],
    ["선택 같지 않음", { property: "vc:X", select: { does_not_equal: "다" } }],
    ["선택 둘 중 하나", { property: "vc:X", select: { equals: ["가", "나"] } }],
    ["상태", { property: "st1", status: { equals: "완료" } }],
    ["다중 선택 포함", { property: "QFXr", multi_select: { contains: "x" } }],
    ["다중 선택 포함 안 함", { property: "QFXr", multi_select: { does_not_contain: "y" } }],
    ["비어 있음", { property: "{qgF", date: { is_empty: true } }],
    ["비어 있지 않음", { property: "BNv\\", rich_text: { is_not_empty: true } }],
    ["절대 날짜", { property: "{qgF", date: { on_or_after: "2026-10-01" } }],
    ["상대 날짜 값", { property: "{qgF", date: { before: "one_month_from_now" } }],
    ["지난 1주", { property: "{qgF", date: { past_week: {} } }],
    ["다음 1년", { property: "{qgF", date: { next_year: {} } }],
    ["수정 시각", { timestamp: "last_edited_time", last_edited_time: { after: "2026-01-01" } }],
    [
      "or 안의 and",
      {
        or: [
          {
            and: [
              { property: "vc:X", select: { equals: "가" } },
              { property: "rvGG", number: { greater_than: 0 } },
            ],
          },
          { property: "{qgF", date: { next_week: {} } },
        ],
      },
    ],
  ];

  for (const [label, filter] of filters) {
    it(label, () => {
      const bases = forward(filter);
      expect(bases).not.toBeNull();
      const back = ok(bases);
      expect(forward(back)).toEqual(bases);
    });
  }

  it("상대 기간 두 끝은 Notion 의 기간 하나로 돌아간다", () => {
    expect(ok(forward({ property: "{qgF", date: { past_month: {} } }))).toEqual({
      property: "{qgF",
      date: { past_month: {} },
    });
  });

  it("속성은 URL 인코딩을 푼 id 로 보낸다", () => {
    expect(ok('note["상태"] == "가"')).toEqual({ property: "vc:X", select: { equals: "가" } });
  });
});

describe("basesFilterToNotion — Obsidian 필터 화면이 쓰는 꼴", () => {
  it("따옴표 없는 이름 · note. · note[…] 는 같은 속성이다", () => {
    const expected = { property: "rvGG", number: { greater_than: 3 } };
    expect(ok("점수 > 3")).toEqual(expected);
    expect(ok("note.점수 > 3")).toEqual(expected);
    expect(ok('note["점수"] > 3')).toEqual(expected);
  });

  it('공백이 든 이름은 note["…"] 로', () => {
    expect(ok('note["마감 일"] >= "2026-10-01"')).toEqual({
      property: "d2",
      date: { on_or_after: "2026-10-01" },
    });
  });

  it("함수와 그 부정", () => {
    expect(ok('메모.contains("첫")')).toEqual({ property: "BNv\\", rich_text: { contains: "첫" } });
    expect(ok('!메모.contains("첫")')).toEqual({
      property: "BNv\\",
      rich_text: { does_not_contain: "첫" },
    });
    expect(ok("!마감.isEmpty()")).toEqual({ property: "{qgF", date: { is_not_empty: true } });
    expect(ok('!태그.containsAny("x", "y")')).toEqual({
      and: [
        { property: "QFXr", multi_select: { does_not_contain: "x" } },
        { property: "QFXr", multi_select: { does_not_contain: "y" } },
      ],
    });
  });

  it("YAML 묶음 — and · or · not(하나도 맞지 않음)", () => {
    expect(ok({ and: ['상태 == "가"', { or: ["점수 > 3", "완료 == true"] }] })).toEqual({
      and: [
        { property: "vc:X", select: { equals: "가" } },
        {
          or: [
            { property: "rvGG", number: { greater_than: 3 } },
            { property: "WF<>", checkbox: { equals: true } },
          ],
        },
      ],
    });
    expect(ok({ not: ['상태 == "가"', '태그.contains("x")'] })).toEqual({
      and: [
        { property: "vc:X", select: { does_not_equal: "가" } },
        { property: "QFXr", multi_select: { does_not_contain: "x" } },
      ],
    });
  });

  it("식 안의 && · || · 괄호", () => {
    expect(ok('상태 == "가" && (점수 > 3 || 완료 == false)')).toEqual({
      and: [
        { property: "vc:X", select: { equals: "가" } },
        {
          or: [
            { property: "rvGG", number: { greater_than: 3 } },
            { property: "WF<>", checkbox: { equals: false } },
          ],
        },
      ],
    });
  });

  it("상대 날짜 — today() · date() · .date()", () => {
    expect(ok("마감 == today()")).toEqual({ property: "{qgF", date: { equals: "today" } });
    expect(ok('마감.date() < today() + "1d"')).toEqual({
      property: "{qgF",
      date: { before: "tomorrow" },
    });
    expect(ok('마감 > date("2026-10-01")')).toEqual({
      property: "{qgF",
      date: { after: "2026-10-01" },
    });
    expect(ok({ or: ["마감 == today()", "마감.isEmpty()"] })).toEqual({
      or: [
        { property: "{qgF", date: { equals: "today" } },
        { property: "{qgF", date: { is_empty: true } },
      ],
    });
  });

  it("file.name 은 제목 속성이다", () => {
    expect(ok('file.name.contains("하")')).toEqual({
      property: "title",
      title: { contains: "하" },
    });
  });
});

describe("basesFilterToNotion — 모르는 꼴은 필터 전체를 거절한다", () => {
  const refused: Array<[string, unknown, string]> = [
    ["수식 열", "formula.x > 1", "formula"],
    ["DB 에 없는 속성", '없는것 == "a"', "속성이 아닙니다"],
    ["파일 폴더", 'file.folder == "a"', "file.folder"],
    ["숫자에 문자열", '점수 == "3"', "숫자와만"],
    ["모르는 함수", '메모.matches("a")', "matches"],
    ["Notion 에 없는 상대 날짜", '마감 >= today() - "2w"', "상대 기간"],
    ["짝 없는 상대 기간", '마감.date() >= today() - "1y"', "상대 기간"],
    ["숫자 비교의 부정", "!(점수 > 3)", "부정"],
    ["시작 문자 부정", '!메모.startsWith("a")', "starts_with"],
    ["수식 속성", "합계 > 3", "formula"],
    ["체크박스 빈 값", "완료.isEmpty()", "빈 값"],
    ["함수 결과 비교", '메모.contains("a") == true', "함수 결과"],
    ["닫히지 않은 따옴표", '상태 == "가', "따옴표"],
    [
      "세 겹 묶음",
      { and: [{ or: [{ and: ["점수 > 1", "점수 < 5"] }, "완료 == true"] }, "점수 > 0"] },
      "두 겹",
    ],
    ["모르는 묶음", { any: ["점수 > 1"] }, "and · or · not"],
  ];

  for (const [label, node, reason] of refused) {
    it(label, () => {
      const result = toNotion(node);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(reason);
    });
  }

  it("and 안의 하나만 못 옮겨도 전체를 거절한다 — 일부만 보내면 Notion 이 다른 행을 고른다", () => {
    expect(toNotion({ and: ['상태 == "가"', "formula.x > 1"] }).ok).toBe(false);
  });
});
