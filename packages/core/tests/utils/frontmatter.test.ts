import { describe, it, expect } from "vitest";
import matter from "gray-matter";
import {
  parseFrontmatter,
  plainFrontmatterValue,
  stringifyFrontmatter,
} from "../../src/utils/frontmatter.js";

describe("stringifyFrontmatter", () => {
  it("본문이 --- 로 시작해도 프론트매터를 생성한다(객체형 호출 봉인)", () => {
    const out = stringifyFrontmatter("---\n\n구획 본문", { title: "T" });
    expect(out.startsWith("---\ntitle: T\n---\n")).toBe(true);
    expect(out).toContain("구획 본문");
  });

  it("ISO 날짜 값의 작은따옴표를 제거한다(D3)", () => {
    const out = stringifyFrontmatter("본문", {
      created: "2026-07-14",
      updated: "2026-07-01",
    });
    expect(out).toContain("created: 2026-07-14\n");
    expect(out).toContain("updated: 2026-07-01\n");
    expect(out).not.toContain("'2026-07-14'");
  });

  it("본문 속 따옴표 날짜는 건드리지 않는다", () => {
    const body = "본문 키: '2026-07-14'";
    const out = stringifyFrontmatter(body, { created: "2026-07-14" });
    expect(out).toContain("본문 키: '2026-07-14'");
    expect(out).toContain("created: 2026-07-14\n");
  });

  it("date-only 가 아닌 값(datetime 등)의 따옴표는 유지한다", () => {
    const out = stringifyFrontmatter("본문", { at: "2026-07-14T09:00:00" });
    expect(out).toContain("'2026-07-14T09:00:00'");
  });
});

describe("plainFrontmatterValue — YAML 이 만든 Date 를 pull 이 적는 평문으로", () => {
  it("자정 Date 는 날짜만, 시각이 있으면 ISO 전체", () => {
    expect(plainFrontmatterValue(new Date("2026-10-01T00:00:00.000Z"))).toBe("2026-10-01");
    expect(plainFrontmatterValue(new Date("2026-10-01T09:30:00.000Z"))).toBe(
      "2026-10-01T09:30:00.000Z",
    );
  });

  it("배열 · 객체 안의 Date 도 바꾸고, 나머지 값은 그대로 둔다", () => {
    expect(
      plainFrontmatterValue({
        기간: { start: new Date("2026-10-01T00:00:00.000Z"), end: null },
        목록: [new Date("2026-10-02T00:00:00.000Z"), 3, "글"],
      }),
    ).toEqual({ 기간: { start: "2026-10-01", end: null }, 목록: ["2026-10-02", 3, "글"] });
  });

  it("잘못된 Date 는 던지지 않고 글로", () => {
    expect(plainFrontmatterValue(new Date("nope"))).toBe("Invalid Date");
  });
});

describe("parseFrontmatter", () => {
  it("frontmatter 와 앞뒤 공백을 걷은 본문을 가른다", () => {
    expect(parseFrontmatter("---\n진척: 0.5\n---\n\n본문\n")).toEqual({
      data: { 진척: 0.5 },
      body: "본문",
    });
  });

  it("깨진 YAML 은 몇 번을 불러도 던진다 — gray-matter 캐시가 «속성 없음» 으로 바꾸지 않게", () => {
    const broken = "---\ntitle: T\n진척: [0.5\n---\n본문\n";
    // 파이프라인(FrontmatterExtractor)처럼 캐시를 쓰는 호출이 먼저 실패해도
    expect(() => matter(broken)).toThrow();
    expect(() => parseFrontmatter(broken)).toThrow();
    expect(() => parseFrontmatter(broken)).toThrow();
  });

  it("돌려준 값을 고쳐도 다음 호출에 새지 않는다", () => {
    const text = "---\n태그: [a]\n---\n본문\n";
    (parseFrontmatter(text).data.태그 as string[]).push("b");
    expect(parseFrontmatter(text).data.태그).toEqual(["a"]);
  });
});
