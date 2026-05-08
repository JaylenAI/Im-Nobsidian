import { describe, it, expect } from "vitest";
import { PreserveMarkerInjector } from "../../src/converter/post-processors/preserve-marker-injector.js";

describe("PreserveMarkerInjector", () => {
  const injector = new PreserveMarkerInjector();
  const meta = { direction: "pull" as const, path: "markdown-api" as const, filePath: "test.md" };

  it("콘텐츠를 그대로 통과", () => {
    const input = "# Hello\n\nWorld";

    const result = injector.process({ content: input, metadata: meta });

    expect(result.content).toBe(input);
    expect(result.metadata).toEqual(meta);
  });

  it("name이 PreserveMarkerInjector", () => {
    expect(injector.name).toBe("PreserveMarkerInjector");
  });

  it("order가 100", () => {
    expect(injector.order).toBe(100);
  });

  it("빈 문자열 처리", () => {
    const result = injector.process({ content: "", metadata: meta });
    expect(result.content).toBe("");
  });

  it("메타데이터 보존", () => {
    const customMeta = { ...meta, extra: "data" };
    const result = injector.process({ content: "test", metadata: customMeta as any });
    expect(result.metadata).toEqual(customMeta);
  });
});
