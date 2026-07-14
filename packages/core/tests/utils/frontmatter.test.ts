import { describe, it, expect } from "vitest";
import { stringifyFrontmatter } from "../../src/utils/frontmatter.js";

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
