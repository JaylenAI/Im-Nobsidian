import { describe, it, expect } from "vitest";
import { diffRowProperties } from "../../src/sync/row-properties.js";

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

  it("title 은 속성 비교에서 뺀다 — 행 제목은 noteTitle 이 정한다", () => {
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
