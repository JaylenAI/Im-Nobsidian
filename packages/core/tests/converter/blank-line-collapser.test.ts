import { describe, it, expect } from "vitest";
import { BlankLineCollapser } from "../../src/converter/pre-processors/blank-line-collapser.js";
import { EmbedResolver } from "../../src/converter/pre-processors/embed.js";
import { PreserveMarkerCollector } from "../../src/converter/pre-processors/preserve-marker.js";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";
import { scanCodeFences } from "../../src/utils/md-regions.js";
import type { ConversionContext } from "../../src/types/convert.js";

const pushContext: ConversionContext = {
  direction: "push",
  path: "markdown-api",
  filePath: "a.md",
};

function push(note: string) {
  return createDefaultPipeline().convertToNotion(note, pushContext);
}

describe("BlankLineCollapser", () => {
  it("내용을 지우거나 끼우는 전처리 뒤, 보존 마커 수집 앞에 돈다", () => {
    const order = new BlankLineCollapser().order;
    expect(order).toBeGreaterThan(new EmbedResolver().order);
    expect(order).toBeLessThan(new PreserveMarkerCollector().order);
  });

  it("pull 에서는 하지 않는다", () => {
    const content = "a\n\n\nb";
    const out = new BlankLineCollapser().process({
      content,
      metadata: {},
      context: { ...pushContext, direction: "pull" },
    });
    expect(out.content).toBe(content);
  });

  // S-27 — 지원하지 않는 블록 제거(order 5)가 문서 전체에서 줄여 코드 속 빈 줄까지 줄였다.
  it("코드 속 이어진 빈 줄을 Notion 에 그대로 보낸다", () => {
    const note =
      "# 제목\n\n```python\nimport os\n\n\ndef a():\n    pass\n```\n\n> [!note] 콜아웃\n> ```py\n> x = 1\n>\n>\n> y = 2\n> ```";
    const codes = (md: string) => scanCodeFences(md).map((fence) => fence.code);
    expect(codes(push(note).content)).toEqual(codes(note));
  });

  // 주석 제거(order 11)가 빈 줄 줄이기 뒤에 돌아, 주석 한 줄 자리가 Notion 빈 블록 셋이 됐다(실측).
  it("지운 주석 자리에 빈 줄을 하나만 남긴다", () => {
    const result = push("앞 문단.\n\n<!-- 메모 -->\n\n%%또 메모%%\n\n뒤 문단.");
    expect(result.content).toBe("앞 문단.\n\n뒤 문단.");
    expect(result.preserveMarkers.map((m) => m.params.text).sort()).toEqual([" 메모 ", "또 메모"]);
  });

  it("지원하지 않는 블록을 지운 자리도", () => {
    const result = push("앞\n\n> [!im-nobsidian-unsupported] 동기화 블록\n> 내용\n\n\n뒤");
    expect(result.content).toBe("앞\n\n뒤");
  });
});
