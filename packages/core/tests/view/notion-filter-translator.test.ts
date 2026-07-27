import { describe, it, expect } from "vitest";
import { translateNotionFilter } from "../../src/view/notion-filter-translator.js";
import { resolvePropertyName } from "../../src/view/property-resolver.js";
import type { BasePropertySchema } from "../../src/types/view.js";

/**
 * R5 D-VIEWFILTER 회귀 잠금.
 *
 * 뷰 필터를 못 옮기면 '시작전, 진행중' 이라는 이름의 뷰가 Obsidian 에서는 **완료된 행까지
 * 전부** 보여 준다 — 오류도 경고도 없이 이름과 내용이 어긋난다. 옮길 수 있는 조건은 옮기고,
 * 못 옮기는 조건은 **어느 방향으로 틀릴지**를 규칙대로 통제한다는 것을 여기서 못 박는다.
 */

const STATUS_PROP: BasePropertySchema = {
  id: "BoM%3F",
  type: "status",
  options: [
    { id: "opt-1", name: "시작 전", color: "default" },
    { id: "opt-2", name: "진행 중", color: "blue" },
    { id: "opt-3", name: "보류", color: "yellow" },
    { id: "opt-4", name: "완료", color: "green" },
  ],
  groups: [
    { name: "To-do", color: "gray", optionIds: ["opt-1"] },
    { name: "In progress", color: "blue", optionIds: ["opt-2", "opt-3"] },
    { name: "Complete", color: "green", optionIds: ["opt-4"] },
  ],
};

const SCHEMA: Record<string, BasePropertySchema> = {
  이름: { id: "title", type: "title" },
  상태: STATUS_PROP,
  완료: { id: "sr~h", type: "checkbox" },
  담당: { id: "%3Aabc", type: "multi_select", options: [{ name: "한승헌" }, { name: "김철수" }] },
  분류: { id: "sel1", type: "select", options: [{ name: "업무" }, { name: "개인" }] },
  마감: { id: "dt1", type: "date" },
  점수: { id: "num1", type: "number" },
  메모: { id: "txt1", type: "rich_text" },
};

function translate(filter: unknown, schema: Record<string, BasePropertySchema> = SCHEMA) {
  return translateNotionFilter(filter, schema, (id) => resolvePropertyName(id, schema));
}

describe("translateNotionFilter — 실제 볼트 필터", () => {
  /**
   * 테스트 볼트 1192개 파일 전체에서 발견된 **유일한** 필터식(원문 그대로).
   * 속성이 id 로 오고(`BoM?`/`sr~h`), status 값이 옵션명이 아니라 **그룹명**으로 온다.
   */
  const REAL_FILTER = {
    and: [
      { property: "BoM?", status: { equals: ["To-do", "In progress"] } },
      { checkbox: { equals: false }, property: "sr~h" },
    ],
  };

  it("id 참조와 status 그룹을 모두 풀어 옮긴다", () => {
    const { node, untranslated } = translate(REAL_FILTER);

    expect(untranslated).toEqual([]);
    expect(node).toEqual({
      and: [
        // To-do → 시작 전, In progress → 진행 중 + 보류 (그룹 전개)
        {
          or: ['note["상태"] == "시작 전"', 'note["상태"] == "진행 중"', 'note["상태"] == "보류"'],
        },
        'note["완료"] == false',
      ],
    });
  });

  it("옵션 id 가 없으면 그룹을 전개하지 못해 조건을 생략한다 (조용한 오역 금지)", () => {
    // 예전 클라이언트가 옵션 id 를 떨궜을 때의 상태 — 그룹→옵션 복원이 불가능하다.
    const noIds: Record<string, BasePropertySchema> = {
      ...SCHEMA,
      상태: { ...STATUS_PROP, options: STATUS_PROP.options?.map(({ id: _id, ...o }) => o) },
    };
    const { node, untranslated } = translate(REAL_FILTER, noIds);

    // and 안이므로 남은 조건만 살아남는다(상위집합 — 행이 사라지지는 않는다).
    expect(node).toBe('note["완료"] == false');
    expect(untranslated).toEqual(["속성 '상태': 상태 'To-do' 을 옵션으로 전개하지 못함"]);
  });
});

describe("translateNotionFilter — 부분 번역의 방향", () => {
  const UNKNOWN = { property: "점수", rollup: { any: { number: { equals: 1 } } } };

  it("and 안에서는 못 옮긴 조건만 버린다 — 결과는 상위집합", () => {
    const { node, untranslated } = translate({
      and: [{ property: "완료", checkbox: { equals: true } }, UNKNOWN],
    });

    expect(node).toBe('note["완료"] == true');
    expect(untranslated).toHaveLength(1);
  });

  it("or 안에 못 옮길 게 하나라도 있으면 그룹 전체를 버린다 — 부분집합 금지", () => {
    const { node, untranslated } = translate({
      or: [{ property: "완료", checkbox: { equals: true } }, UNKNOWN],
    });

    // 남겼다면 Notion 에 보이던 행이 Obsidian 에서 조용히 사라진다.
    expect(node).toBeNull();
    expect(untranslated).toContain("or 그룹 안에 옮길 수 없는 조건이 있어 그룹 전체를 생략함");
  });

  it("not 안에 못 옮길 게 있으면 그룹 전체를 버린다 — 부정은 뒤집히면 끝이다", () => {
    const { node } = translate({ not: [UNKNOWN] });
    expect(node).toBeNull();
  });

  it("중첩 or 가 통째로 빠져도 바깥 and 는 살아남는다", () => {
    const { node } = translate({
      and: [
        { property: "완료", checkbox: { equals: false } },
        { or: [{ property: "분류", select: { equals: "업무" } }, UNKNOWN] },
      ],
    });

    expect(node).toBe('note["완료"] == false');
  });

  it("자식이 하나뿐인 그룹은 감싸지 않는다 (불필요한 중첩 제거)", () => {
    const { node } = translate({ and: [{ property: "완료", checkbox: { equals: true } }] });
    expect(node).toBe('note["완료"] == true');
  });

  it("옮길 수 있는 게 하나도 없으면 null — 필터 없는 뷰가 된다", () => {
    expect(translate({ and: [UNKNOWN] }).node).toBeNull();
    expect(translate(null).node).toBeNull();
    expect(translate(undefined).node).toBeNull();
    expect(translate("이상한 값").node).toBeNull();
  });

  it("스키마에 없는 속성은 생략하고 사유를 남긴다", () => {
    const { node, untranslated } = translate({
      and: [
        { property: "없는속성id", checkbox: { equals: true } },
        { property: "완료", checkbox: { equals: false } },
      ],
    });

    expect(node).toBe('note["완료"] == false');
    expect(untranslated).toEqual(["속성 '없는속성id' 을 스키마에서 찾지 못해 조건을 생략함"]);
  });
});

describe("translateNotionFilter — 연산자 문법", () => {
  it("텍스트", () => {
    expect(translate({ property: "메모", rich_text: { equals: "가" } }).node).toBe(
      'note["메모"] == "가"',
    );
    expect(translate({ property: "메모", rich_text: { does_not_equal: "가" } }).node).toBe(
      'note["메모"] != "가"',
    );
    expect(translate({ property: "메모", rich_text: { contains: "가" } }).node).toBe(
      'note["메모"].contains("가")',
    );
    expect(translate({ property: "메모", rich_text: { does_not_contain: "가" } }).node).toBe(
      '!note["메모"].contains("가")',
    );
    expect(translate({ property: "메모", rich_text: { starts_with: "가" } }).node).toBe(
      'note["메모"].startsWith("가")',
    );
    expect(translate({ property: "메모", rich_text: { ends_with: "가" } }).node).toBe(
      'note["메모"].endsWith("가")',
    );
  });

  it("숫자", () => {
    expect(translate({ property: "점수", number: { greater_than: 3 } }).node).toBe(
      'note["점수"] > 3',
    );
    expect(translate({ property: "점수", number: { less_than_or_equal_to: 3 } }).node).toBe(
      'note["점수"] <= 3',
    );
    expect(translate({ property: "점수", number: { equals: 0 } }).node).toBe('note["점수"] == 0');
  });

  it("비어있음 판정은 모든 타입 공통", () => {
    expect(translate({ property: "메모", rich_text: { is_empty: true } }).node).toBe(
      'note["메모"].isEmpty()',
    );
    expect(translate({ property: "마감", date: { is_not_empty: true } }).node).toBe(
      '!note["마감"].isEmpty()',
    );
  });

  it("다중선택은 containsAny", () => {
    expect(translate({ property: "담당", multi_select: { contains: "한승헌" } }).node).toBe(
      'note["담당"].containsAny("한승헌")',
    );
    expect(translate({ property: "담당", multi_select: { does_not_contain: "김철수" } }).node).toBe(
      '!note["담당"].containsAny("김철수")',
    );
  });

  it("select 의 does_not_equal 은 or 가 아니라 and 로 묶는다", () => {
    // "둘 중 아무것도 아님" 을 or 로 묶으면 항상 참이 돼 필터가 무력화된다.
    const { node } = translate({ property: "분류", select: { does_not_equal: ["업무", "개인"] } });
    expect(node).toEqual({ and: ['note["분류"] != "업무"', 'note["분류"] != "개인"'] });
  });

  it("절대 날짜만 옮기고 상대 날짜는 생략한다", () => {
    expect(translate({ property: "마감", date: { before: "2026-07-27" } }).node).toBe(
      'note["마감"] < "2026-07-27"',
    );
    expect(translate({ property: "마감", date: { on_or_after: "2026-07-27" } }).node).toBe(
      'note["마감"] >= "2026-07-27"',
    );

    const relative = translate({ property: "마감", date: { past_week: {} } });
    expect(relative.node).toBeNull();
    expect(relative.untranslated).toEqual([
      "속성 '마감': 상대 날짜 조건 'past_week' 은 옮기지 않음",
    ]);
  });

  it("timestamp 필터는 파일 시각으로 옮긴다", () => {
    expect(
      translate({ timestamp: "created_time", created_time: { after: "2026-01-01" } }).node,
    ).toBe('file.ctime > "2026-01-01"');
    expect(
      translate({ timestamp: "last_edited_time", last_edited_time: { before: "2026-01-01" } }).node,
    ).toBe('file.mtime < "2026-01-01"');
  });

  it("formula/rollup 은 프론트매터에 없는 계산값이라 옮기지 않는다", () => {
    const { node, untranslated } = translate({
      property: "점수",
      formula: { number: { equals: 1 } },
    });
    expect(node).toBeNull();
    expect(untranslated).toEqual(["속성 '점수': formula 필터는 Bases 로 옮길 수 없음"]);
  });

  it("따옴표·역슬래시가 든 값은 이스케이프한다", () => {
    const schema: Record<string, BasePropertySchema> = {
      '이름"특이': { id: "q1", type: "rich_text" },
    };
    const { node } = translateNotionFilter(
      { property: "q1", rich_text: { equals: 'a"b\\c' } },
      schema,
      (id) => resolvePropertyName(id, schema),
    );
    expect(node).toBe('note["이름\\"특이"] == "a\\"b\\\\c"');
  });
});
