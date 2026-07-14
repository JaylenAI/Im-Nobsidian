import { describe, it, expect } from "vitest";
import { CommentStripper } from "../../src/converter/pre-processors/comment-stripper.js";
import type { ProcessorInput } from "../../src/types/convert.js";

const pushContext = {
  direction: "push" as const,
  path: "markdown-api" as const,
  filePath: "test.md",
};
const pullContext = { ...pushContext, direction: "pull" as const };

function run(content: string, direction: "push" | "pull" = "push") {
  const stripper = new CommentStripper();
  const input: ProcessorInput = {
    content,
    metadata: {},
    context: direction === "push" ? pushContext : pullContext,
  };
  return stripper.process(input);
}

describe("CommentStripper (F26)", () => {
  it("order 11 — FrontmatterExtractor(10) 뒤", () => {
    expect(new CommentStripper().order).toBe(11);
  });

  it("일반 %%주석%% 을 본문에서 제거하고 comment 마커로 보존", () => {
    const result = run("앞 문단.\n\n%%사적 메모%%\n\n뒤 문단.");
    expect(result.content).not.toContain("사적 메모");
    const markers = result.metadata.preserveMarkers ?? [];
    expect(markers).toHaveLength(1);
    expect(markers[0]!.type).toBe("comment");
    expect(markers[0]!.params.text).toBe("사적 메모");
    expect(markers[0]!.params.__anchor).toBe("앞 문단.");
  });

  it("im-nobsidian 브랜드 마커는 보존 (compact·spaced 모두)", () => {
    const content =
      "%%im-nobsidian:color:yellow_bg%%하이라이트%%/color%%\n\n%% im-nobsidian:local-image:a.png %%";
    const result = run(content);
    expect(result.content).toBe(content);
    expect(result.metadata.preserveMarkers ?? []).toHaveLength(0);
  });

  it("코드 펜스 안의 %% 는 건드리지 않음", () => {
    const content = "```\n%%코드 속 주석%%\n```";
    const result = run(content);
    expect(result.content).toBe(content);
  });

  it("pull 방향에서는 무동작", () => {
    const content = "%%주석%%";
    const result = run(content, "pull");
    expect(result.content).toBe(content);
  });

  it("여러 주석을 각각 마커로 수집", () => {
    const result = run("A %%하나%% B\n\nC %%둘%% D");
    const markers = result.metadata.preserveMarkers ?? [];
    expect(markers.map((m) => m.params.text)).toEqual(["하나", "둘"]);
    expect(result.content).not.toContain("하나");
    expect(result.content).not.toContain("둘");
  });

  it("여러 줄 주석도 제거·보존", () => {
    const result = run("앞\n\n%%줄1\n줄2%%\n\n뒤");
    expect(result.content).not.toContain("줄1");
    expect((result.metadata.preserveMarkers ?? [])[0]!.params.text).toBe("줄1\n줄2");
  });
});
