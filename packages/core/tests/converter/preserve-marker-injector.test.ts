import { describe, it, expect } from "vitest";
import { PreserveMarkerInjector } from "../../src/converter/post-processors/preserve-marker-injector.js";
import type { ProcessorInput } from "../../src/types/convert.js";

describe("PreserveMarkerInjector", () => {
  const injector = new PreserveMarkerInjector();
  const pullContext = {
    direction: "pull" as const,
    path: "markdown-api" as const,
    filePath: "test.md",
  };
  const pushContext = {
    direction: "push" as const,
    path: "markdown-api" as const,
    filePath: "test.md",
  };

  it("name이 PreserveMarkerInjector", () => {
    expect(injector.name).toBe("PreserveMarkerInjector");
  });

  it("order가 100", () => {
    expect(injector.order).toBe(100);
  });

  it("마커 없으면 콘텐츠 그대로 통과", () => {
    const input: ProcessorInput = {
      content: "# Hello\n\nWorld",
      metadata: {},
      context: pullContext,
    };
    const result = injector.process(input);
    expect(result.content).toBe("# Hello\n\nWorld");
  });

  it("push 방향에서는 아무 처리 안 함", () => {
    const input: ProcessorInput = {
      content: "# Test",
      metadata: {
        preserveMarkers: [{ type: "toggle-heading", params: { id: "abc" }, startIndex: 0 }],
      },
      context: pushContext,
    };
    const result = injector.process(input);
    expect(result.content).toBe("# Test");
  });

  it("pull 시 누락된 마커를 콘텐츠 끝에 추가", () => {
    const input: ProcessorInput = {
      content: "# Hello\n\nContent here",
      metadata: {
        preserveMarkers: [{ type: "toggle-heading", params: { id: "abc" }, startIndex: 0 }],
      },
      context: pullContext,
    };
    const result = injector.process(input);
    expect(result.content).toContain("%% im-nobsidian:toggle-heading:id=abc %%");
  });

  it("이미 존재하는 마커는 중복 추가 안 함", () => {
    const marker = "%% im-nobsidian:toggle-heading:id=abc %%";
    const input: ProcessorInput = {
      content: `# Hello\n\n${marker}\n\nContent`,
      metadata: {
        preserveMarkers: [{ type: "toggle-heading", params: { id: "abc" }, startIndex: 0 }],
      },
      context: pullContext,
    };
    const result = injector.process(input);
    const count = (result.content.match(/im-nobsidian:toggle-heading/g) || []).length;
    expect(count).toBe(1);
  });

  it("여러 마커 동시 복원", () => {
    const input: ProcessorInput = {
      content: "# Test",
      metadata: {
        preserveMarkers: [
          { type: "toggle-heading", params: { id: "a" }, startIndex: 0 },
          { type: "inline-db", params: { db: "tasks" }, startIndex: 10 },
        ],
      },
      context: pullContext,
    };
    const result = injector.process(input);
    expect(result.content).toContain("%% im-nobsidian:toggle-heading:id=a %%");
    expect(result.content).toContain("%% im-nobsidian:inline-db:db=tasks %%");
  });

  it("빈 문자열 처리", () => {
    const input: ProcessorInput = { content: "", metadata: {}, context: pullContext };
    const result = injector.process(input);
    expect(result.content).toBe("");
  });

  it("메타데이터 보존", () => {
    const input: ProcessorInput = {
      content: "test",
      metadata: { properties: { title: "hi" } },
      context: pullContext,
    };
    const result = injector.process(input);
    expect(result.metadata.properties).toEqual({ title: "hi" });
  });
});
