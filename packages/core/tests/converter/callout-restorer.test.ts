import { describe, it, expect } from "vitest";
import { CalloutRestorer } from "../../src/converter/post-processors/callout-restorer.js";

describe("CalloutRestorer", () => {
  const restorer = new CalloutRestorer();
  const meta = { direction: "pull" as const, path: "markdown-api" as const, filePath: "test.md" };

  it("preserve marker에서 callout 복원 (open)", () => {
    const input = "%% im-nobsidian:callout:type=warning&foldable=open %%\nContent here";

    const result = restorer.process({ content: input, metadata: meta });

    expect(result.content).toContain("[!warning]+");
  });

  it("preserve marker에서 callout 복원 (closed)", () => {
    const input = "%% im-nobsidian:callout:type=tip&foldable=closed %%";

    const result = restorer.process({ content: input, metadata: meta });

    expect(result.content).toContain("[!tip]-");
  });

  it("이모지 기반 callout 복원 (note)", () => {
    const input = "> \u{1F4DD} **note**\n> Some note content";

    const result = restorer.process({ content: input, metadata: meta });

    expect(result.content).toContain("[!note]");
  });

  it("이모지 기반 callout 커스텀 타이틀", () => {
    const input = "> \u{26A0}\u{FE0F} **Custom Warning Title**";

    const result = restorer.process({ content: input, metadata: meta });

    expect(result.content).toContain("[!warning] Custom Warning Title");
  });

  it("callout 없는 콘텐츠는 그대로", () => {
    const input = "# Normal content\n\nNo callouts here";

    const result = restorer.process({ content: input, metadata: meta });

    expect(result.content).toBe(input);
  });

  it("여러 종류 이모지 복원", () => {
    const emojis = [
      ["\u{2705}", "success"],
      ["\u{274C}", "failure"],
      ["\u{1F525}", "danger"],
      ["\u{1F41B}", "bug"],
    ] as const;

    for (const [emoji, type] of emojis) {
      const input = `> ${emoji} **${type}**`;
      const result = restorer.process({ content: input, metadata: meta });
      expect(result.content).toContain(`[!${type}]`);
    }
  });
});
