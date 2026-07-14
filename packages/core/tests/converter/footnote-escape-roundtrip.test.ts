import { describe, it, expect } from "vitest";
import { FootnoteGuard } from "../../src/converter/pre-processors/footnote-guard.js";
import { EscapeNormalizer } from "../../src/converter/post-processors/escape-normalizer.js";
import type { ProcessorInput } from "../../src/types/convert.js";

const pushContext = {
  direction: "push" as const,
  path: "markdown-api" as const,
  filePath: "test.md",
};
const pullContext = { ...pushContext, direction: "pull" as const };

function push(content: string) {
  const input: ProcessorInput = { content, metadata: {}, context: pushContext };
  return new FootnoteGuard().process(input).content;
}

function pull(content: string) {
  const input: ProcessorInput = { content, metadata: {}, context: pullContext };
  return new EscapeNormalizer().process(input).content;
}

describe("FootnoteGuard (F25 push)", () => {
  it("각주 참조·정의를 이스케이프해 remark 참조링크 오인을 차단", () => {
    const result = push("본문[^1] 계속.\n\n[^1]: 각주 내용");
    expect(result).toBe("본문\\[^1] 계속.\n\n\\[^1]: 각주 내용");
  });

  it("이미 이스케이프된 각주는 이중 이스케이프하지 않음", () => {
    const content = "본문\\[^1]";
    expect(push(content)).toBe(content);
  });

  it("코드 펜스 안의 각주 문법은 보존", () => {
    const content = "```\n[^1]: 코드\n```";
    expect(push(content)).toBe(content);
  });

  it("pull 방향에서는 무동작", () => {
    const guard = new FootnoteGuard();
    const input: ProcessorInput = { content: "[^1]", metadata: {}, context: pullContext };
    expect(guard.process(input).content).toBe("[^1]");
  });
});

describe("EscapeNormalizer (F25·F27·F30 pull)", () => {
  it("notion-to-md 의 \\[^1\\] 를 [^1] 로 복원", () => {
    expect(pull("본문\\[^1\\] 계속")).toBe("본문[^1] 계속");
  });

  it("FootnoteGuard 산출형 \\[^1] 도 [^1] 로 복원", () => {
    expect(pull("본문\\[^1] 계속.\n\n\\[^1]: 각주 내용")).toBe("본문[^1] 계속.\n\n[^1]: 각주 내용");
  });

  it("\\: 콜론 이스케이프를 원형으로 (마커·표 셀 복구)", () => {
    expect(pull("%% im-nobsidian\\:local-image\\:probe.png %%")).toBe(
      "%% im-nobsidian:local-image:probe.png %%",
    );
  });

  it("코드 펜스 안 이스케이프는 보존", () => {
    const content = "```\na\\:b\n```";
    expect(pull(content)).toBe(content);
  });

  it("push 방향에서는 무동작", () => {
    const input: ProcessorInput = { content: "a\\:b", metadata: {}, context: pushContext };
    expect(new EscapeNormalizer().process(input).content).toBe("a\\:b");
  });

  it("왕복: guard → (notion 무변형 가정) → normalizer 가 원문 복원", () => {
    const original = "각주 참조[^ref] 문장.\n\n[^ref]: 정의 내용";
    expect(pull(push(original))).toBe(original);
  });
});
