import { describe, it, expect } from "vitest";
import {
  sortEntries,
  groupEntries,
  extractCalendarEntries,
  filterByMonth,
  getVisibleProperties,
} from "../../src/view/filter-engine.js";
import type { DBEntry } from "../../src/view/types.js";
import type { ViewConfig } from "../../src/types/view.js";

function entry(title: string, props: Record<string, any> = {}): DBEntry {
  return { path: `db/${title}.md`, title, properties: props };
}

describe("sortEntries", () => {
  const entries = [
    entry("B", { priority: 2, name: "Beta" }),
    entry("A", { priority: 1, name: "Alpha" }),
    entry("C", { priority: 3, name: "Charlie" }),
  ];

  it("문자열 오름차순 정렬", () => {
    const sorted = sortEntries(entries, [{ property: "name", direction: "ascending" }]);
    expect(sorted.map((e) => e.title)).toEqual(["A", "B", "C"]);
  });

  it("숫자 내림차순 정렬", () => {
    const sorted = sortEntries(entries, [{ property: "priority", direction: "descending" }]);
    expect(sorted.map((e) => e.title)).toEqual(["C", "B", "A"]);
  });

  it("빈 정렬 조건이면 원본 순서 유지", () => {
    const sorted = sortEntries(entries, []);
    expect(sorted.map((e) => e.title)).toEqual(["B", "A", "C"]);
  });

  it("null 값은 뒤로", () => {
    const items = [
      entry("X", { score: null }),
      entry("Y", { score: 10 }),
      entry("Z", { score: 5 }),
    ];
    const sorted = sortEntries(items, [{ property: "score", direction: "ascending" }]);
    expect(sorted.map((e) => e.title)).toEqual(["Z", "Y", "X"]);
  });

  it("다중 정렬 조건", () => {
    const items = [
      entry("A", { group: "A", priority: 2 }),
      entry("B", { group: "A", priority: 1 }),
      entry("C", { group: "B", priority: 1 }),
    ];
    const sorted = sortEntries(items, [
      { property: "group", direction: "ascending" },
      { property: "priority", direction: "ascending" },
    ]);
    expect(sorted.map((e) => e.title)).toEqual(["B", "A", "C"]);
  });

  it("boolean 정렬", () => {
    const items = [
      entry("A", { done: true }),
      entry("B", { done: false }),
      entry("C", { done: true }),
    ];
    const sorted = sortEntries(items, [{ property: "done", direction: "ascending" }]);
    expect(sorted[0]!.properties.done).toBe(false);
  });

  it("date 객체 정렬", () => {
    const items = [
      entry("A", { due: { start: "2026-03-01" } }),
      entry("B", { due: { start: "2026-01-15" } }),
      entry("C", { due: { start: "2026-06-20" } }),
    ];
    const sorted = sortEntries(items, [{ property: "due", direction: "ascending" }]);
    expect(sorted.map((e) => e.title)).toEqual(["B", "A", "C"]);
  });
});

describe("groupEntries", () => {
  const entries = [
    entry("A", { status: "진행중" }),
    entry("B", { status: "완료" }),
    entry("C", { status: "진행중" }),
    entry("D", { status: "대기" }),
    entry("E", {}),
  ];

  it("속성 값 기준 그룹핑", () => {
    const groups = groupEntries(entries, "status");
    const names = groups.map((g) => g.groupName);
    expect(names).toContain("진행중");
    expect(names).toContain("완료");
    expect(names).toContain("대기");
  });

  it("진행중 그룹에 2개 엔트리", () => {
    const groups = groupEntries(entries, "status");
    const inProgress = groups.find((g) => g.groupName === "진행중");
    expect(inProgress?.entries).toHaveLength(2);
  });

  it("값 없는 항목은 '그룹 없음'", () => {
    const groups = groupEntries(entries, "status");
    const noGroup = groups.find((g) => g.groupName === "그룹 없음");
    expect(noGroup?.entries).toHaveLength(1);
    expect(noGroup?.entries[0]?.title).toBe("E");
  });

  it("오름차순 정렬", () => {
    const groups = groupEntries(entries, "status", { sort: "ascending" });
    const mainGroups = groups.filter((g) => g.groupName !== "그룹 없음");
    expect(mainGroups[0]!.groupName).toBe("대기");
  });

  it("hideEmptyGroups 옵션", () => {
    const groups = groupEntries(entries, "status", { hideEmptyGroups: true });
    expect(groups.every((g) => g.entries.length > 0)).toBe(true);
  });

  it("배열 속성 그룹핑", () => {
    const items = [entry("A", { tags: ["dev", "urgent"] }), entry("B", { tags: ["design"] })];
    const groups = groupEntries(items, "tags");
    expect(groups).toHaveLength(2);
  });

  it("boolean 속성 그룹핑", () => {
    const items = [
      entry("A", { done: true }),
      entry("B", { done: false }),
      entry("C", { done: true }),
    ];
    const groups = groupEntries(items, "done");
    expect(groups.find((g) => g.groupName === "true")?.entries).toHaveLength(2);
  });
});

describe("extractCalendarEntries", () => {
  it("문자열 날짜 추출", () => {
    const entries = [entry("A", { due: "2026-05-15" }), entry("B", { due: "2026-06-01" })];
    const calendar = extractCalendarEntries(entries, "due");
    expect(calendar).toHaveLength(2);
    expect(calendar[0]!.date).toBe("2026-05-15");
  });

  it("date range 객체 추출", () => {
    const entries = [entry("A", { period: { start: "2026-05-01", end: "2026-05-10" } })];
    const calendar = extractCalendarEntries(entries, "period");
    expect(calendar[0]!.date).toBe("2026-05-01");
    expect(calendar[0]!.endDate).toBe("2026-05-10");
  });

  it("날짜 없는 엔트리 제외", () => {
    const entries = [entry("A", { due: "2026-05-15" }), entry("B", {}), entry("C", { due: null })];
    const calendar = extractCalendarEntries(entries, "due");
    expect(calendar).toHaveLength(1);
  });

  it("ISO datetime에서 날짜만 추출", () => {
    const entries = [entry("A", { created: "2026-05-15T09:30:00.000Z" })];
    const calendar = extractCalendarEntries(entries, "created");
    expect(calendar[0]!.date).toBe("2026-05-15");
  });
});

describe("filterByMonth", () => {
  const calendarEntries = [
    { entry: entry("A"), date: "2026-05-01" },
    { entry: entry("B"), date: "2026-05-15" },
    { entry: entry("C"), date: "2026-06-01" },
    { entry: entry("D"), date: "2026-04-30" },
  ];

  it("5월 필터", () => {
    const filtered = filterByMonth(calendarEntries, 2026, 5);
    expect(filtered).toHaveLength(2);
  });

  it("6월 필터", () => {
    const filtered = filterByMonth(calendarEntries, 2026, 6);
    expect(filtered).toHaveLength(1);
  });

  it("해당 월 없으면 빈 배열", () => {
    const filtered = filterByMonth(calendarEntries, 2025, 1);
    expect(filtered).toHaveLength(0);
  });
});

describe("getVisibleProperties", () => {
  it("visible=true인 속성만 반환", () => {
    const config: ViewConfig = {
      id: "v1",
      name: "Test",
      type: "table",
      properties: [
        { propertyId: "name", propertyName: "이름", visible: true, width: 200 },
        { propertyId: "status", propertyName: "상태", visible: true },
        { propertyId: "hidden", propertyName: "숨김", visible: false },
      ],
    };
    const visible = getVisibleProperties(config);
    expect(visible).toHaveLength(2);
    expect(visible[0]!.name).toBe("이름");
    expect(visible[0]!.width).toBe(200);
  });

  it("visible 미지정이면 포함", () => {
    const config: ViewConfig = {
      id: "v1",
      name: "Test",
      type: "table",
      properties: [{ propertyId: "name", propertyName: "이름" }],
    };
    const visible = getVisibleProperties(config);
    expect(visible).toHaveLength(1);
  });

  it("properties 없으면 빈 배열", () => {
    const config: ViewConfig = { id: "v1", name: "Test", type: "gallery" };
    const visible = getVisibleProperties(config);
    expect(visible).toHaveLength(0);
  });

  it("propertyName 없으면 propertyId 사용", () => {
    const config: ViewConfig = {
      id: "v1",
      name: "Test",
      type: "table",
      properties: [{ propertyId: "abc123", visible: true }],
    };
    const visible = getVisibleProperties(config);
    expect(visible[0]!.name).toBe("abc123");
  });
});
