import { describe, it, expect } from "vitest";
import { InlineAnnotationPreserver } from "../../src/converter/pre-processors/html-annotation.js";
import { HighlightRestorer } from "../../src/converter/post-processors/highlight-restorer.js";
import type { ProcessorInput } from "../../src/types/convert.js";

const pushContext = {
  direction: "push" as const,
  path: "markdown-api" as const,
  filePath: "test.md",
};
const pullContext = { ...pushContext, direction: "pull" as const };

function push(content: string) {
  const input: ProcessorInput = { content, metadata: {}, context: pushContext };
  return new InlineAnnotationPreserver().process(input).content;
}

function pull(content: string) {
  const input: ProcessorInput = { content, metadata: {}, context: pullContext };
  return new HighlightRestorer().process(input).content;
}

describe("== 하이라이트 push 승격 (F24)", () => {
  it("==텍스트== 를 yellow_bg 색상 마커로 변환", () => {
    expect(push("이건 ==중요한== 부분")).toBe(
      "이건 %%im-nobsidian:color:yellow_bg%%중요한%%/color%% 부분",
    );
  });

  it("=== 3연속 등호는 하이라이트가 아님", () => {
    const content = "제목\n===\n본문";
    expect(push(content)).toBe(content);
  });

  it("코드 펜스 안의 == 는 보존", () => {
    const content = "```\na == b\n==하이라이트 아님==\n```";
    expect(push(content)).toBe(content);
  });

  it("여러 줄에 걸친 == 는 변환하지 않음", () => {
    const content = "==줄1\n줄2==";
    expect(push(content)).toBe(content);
  });
});

describe("HighlightRestorer (F24 pull)", () => {
  it("compact yellow_bg 마커를 ==텍스트== 로 복원", () => {
    expect(pull("이건 %%im-nobsidian:color:yellow_bg%%중요한%%/color%% 부분")).toBe(
      "이건 ==중요한== 부분",
    );
  });

  it("yellow_background 표기도 수용", () => {
    expect(pull("%%im-nobsidian:color:yellow_background%%텍스트%%/color%%")).toBe("==텍스트==");
  });

  it("공백형(spaced) 마커도 복원", () => {
    expect(pull("%% im-nobsidian:color:yellow_bg %%텍스트%% im-nobsidian:end %%")).toBe(
      "==텍스트==",
    );
  });

  it("노랑 외 색상 마커는 보존 (ColorAnnotator 소관)", () => {
    const content = "%%im-nobsidian:color:red%%빨강%%/color%%";
    expect(pull(content)).toBe(content);
  });

  it("push 방향에서는 무동작", () => {
    const content = "%%im-nobsidian:color:yellow_bg%%x%%/color%%";
    const input: ProcessorInput = { content, metadata: {}, context: pushContext };
    expect(new HighlightRestorer().process(input).content).toBe(content);
  });

  it("왕복: ==x== → 마커 → ==x==", () => {
    const original = "앞 ==하이라이트== 뒤";
    expect(pull(push(original))).toBe(original);
  });
});
