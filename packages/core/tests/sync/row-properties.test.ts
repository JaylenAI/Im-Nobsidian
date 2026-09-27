import { describe, it, expect } from "vitest";
import { diffRowProperties, rowTitle } from "../../src/sync/row-properties.js";

describe("diffRowProperties — 지난 동기화 뒤 바뀐 속성만 (S-01)", () => {
  const base = {
    title: "과제 A",
    진척: 0.42,
    상태: "Not started",
    태그: ["a", "b"],
    설명: "메모",
    담당: null,
  };

  it("아무것도 안 바뀌면 빈 결과", () => {
    expect(diffRowProperties(base, { ...base })).toEqual({ changed: {}, cleared: [] });
  });

  it("바뀐 키만 changed 로 고른다", () => {
    expect(diffRowProperties(base, { ...base, 진척: 0.5 })).toEqual({
      changed: { 진척: 0.5 },
      cleared: [],
    });
  });

  it("지운 키 · null · 빈 글 · 빈 배열은 cleared 로 간다", () => {
    const { 설명: _removed, ...rest } = base;
    expect(diffRowProperties(base, { ...rest, 진척: null, 상태: "", 태그: [] })).toEqual({
      changed: {},
      cleared: ["진척", "상태", "태그", "설명"],
    });
  });

  it("비어 있음의 모양이 달라도(없음 · null · 빈 글 · 빈 배열) 바뀐 것이 아니다", () => {
    expect(diffRowProperties({ a: null, b: [], c: "" }, { a: "", c: [], d: null })).toEqual({
      changed: {},
      cleared: [],
    });
  });

  it("따옴표 없는 날짜(Date)와 따옴표 친 날짜 글은 같은 값", () => {
    expect(
      diffRowProperties({ 마감: new Date("2026-10-01T00:00:00.000Z") }, { 마감: "2026-10-01" }),
    ).toEqual({ changed: {}, cleared: [] });
  });

  it("바뀐 날짜는 평문 날짜로 보낸다", () => {
    expect(
      diffRowProperties(
        { 마감: new Date("2026-10-01T00:00:00.000Z") },
        { 마감: new Date("2026-10-05T00:00:00.000Z") },
      ),
    ).toEqual({ changed: { 마감: "2026-10-05" }, cleared: [] });
  });

  it("배열은 순서까지 비교하고, 객체는 키 단위로 비교한다", () => {
    expect(diffRowProperties({ 태그: ["a", "b"] }, { 태그: ["b", "a"] }).changed).toEqual({
      태그: ["b", "a"],
    });
    expect(
      diffRowProperties(
        { 기간: { start: "2026-10-01", end: null } },
        { 기간: { start: "2026-10-01" } },
      ),
    ).toEqual({ changed: {}, cleared: [] });
  });

  it("title 은 속성 비교에서 뺀다 — 행 제목은 rowTitle 이 정한다", () => {
    expect(diffRowProperties(base, { ...base, title: "새 제목" })).toEqual({
      changed: {},
      cleared: [],
    });
  });

  it("기준이 없으면(null) 비어 있지 않은 속성만 changed 로, 지우는 것은 없다", () => {
    expect(diffRowProperties(null, { title: "T", 진척: 0.5, 설명: "", 태그: [] })).toEqual({
      changed: { 진척: 0.5 },
      cleared: [],
    });
  });
});

describe("rowTitle — frontmatter 제목, 없으면 파일 이름", () => {
  it("frontmatter title 을 쓴다 — 파일명에 못 쓰는 글자가 있어도 원래 제목 그대로", () => {
    expect(rowTitle({ title: "A/B 통합" }, "과제/A-B 통합.md")).toBe("A/B 통합");
  });

  it("title 이 없거나 비었으면 파일 이름", () => {
    expect(rowTitle({}, "과제/과제 A.md")).toBe("과제 A");
    expect(rowTitle({ title: "  " }, "과제/과제 A.md")).toBe("과제 A");
    expect(rowTitle({ title: null }, "과제/과제 A.md")).toBe("과제 A");
  });

  it("YAML 이 숫자 · 날짜로 읽은 제목도 글로 되돌린다", () => {
    expect(rowTitle({ title: 2026 }, "x.md")).toBe("2026");
    expect(rowTitle({ title: new Date("2026-10-01T00:00:00.000Z") }, "x.md")).toBe("2026-10-01");
  });
});
