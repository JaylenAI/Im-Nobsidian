/**
 * 페이지 노트의 frontmatter 는 본문 첫머리의 속성 블록으로 간다 — 아이콘 · 커버는 페이지의 아이콘 · 커버로
 * 따로 보내므로 블록에 넣지 않는다. 그렇게 읽을 수 없는 값만 예전처럼 블록에 둔다.
 */
import { describe, expect, it } from "vitest";
import { PropertiesTableInjector } from "../../src/converter/pre-processors/properties-table.js";

function inject(properties: Record<string, unknown>): string {
  return new PropertiesTableInjector().process({
    content: "본문",
    context: { direction: "push", path: "markdown-api", filePath: "a.md", parentMode: "page" },
    metadata: { properties },
  } as never).content;
}

describe("속성 블록과 아이콘 · 커버", () => {
  it("아이콘 · 커버로 보낼 값은 블록에 넣지 않는다", () => {
    const out = inject({ 분류: "글", icon: "🥑", cover: "[[c.png]]" });
    expect(out).toContain("분류: 글");
    expect(out).not.toContain("icon");
    expect(out).not.toContain("cover");
  });

  it("아이콘 · 커버만 있으면 블록이 없다", () => {
    expect(inject({ icon: "star:yellow" })).toBe("본문");
  });

  it("아이콘 · 커버로 읽을 수 없는 값은 블록에 남는다 — 버리면 사라진다", () => {
    expect(inject({ cover: "표지 문구" })).toContain("cover: 표지 문구");
  });
});
