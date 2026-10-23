/**
 * 빈 목록 항목의 자식 — 글이 있는 항목과 똑같이 받는다.
 *
 * Notion 은 빈 글머리표를 `-` 한 글자로 내보낸다(2026-10-23 실측: `-⏎  본문` 을 올리면 빈 글머리표와 그 자식 문단이
 * 된다). 항목 판정이 표 뒤 공백을 요구해 `-` 를 문단으로 봤고, 그 결과 자식 문단 · 코드블록 · 빈 줄이 항목에서
 * 떨어졌다(실데이터 E2E 1 노트).
 */
import { describe, it, expect } from "vitest";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";
import { notionEnhancedToObsidian } from "../../src/converter/enhanced-md-converter.js";
import { isCompactExport } from "../../src/converter/post-processors/block-spacer.js";

const PULL = { direction: "pull", path: "markdown-api", filePath: "a.md" } as const;

function pull(exported: string): string {
  return createDefaultPipeline().convertToMarkdown(notionEnhancedToObsidian(exported), PULL, {
    notionExportCompact: isCompactExport(exported),
  });
}

/** 같은 자식을 빈 항목과 글이 있는 항목 밑에 두고 받아, 항목 줄만 다르고 나머지가 같은지 본다. */
function pullBoth(child: string): [string, string] {
  return [pull(`-\n${child}`), pull(`- a\n${child}`).replace(/^- a\n/, "-\n")];
}

describe("빈 목록 항목의 자식", () => {
  it.each([
    ["자식 문단 · 손자 항목", "\tx.\n\t\t- y\n"],
    ["자식 코드블록", "\t```js\nq\n\t```\n"],
    ["자식 빈 블록", "\t<empty-block/>\n\tz\n"],
  ])("%s — 글이 있는 항목과 같다", (_name, child) => {
    const [empty, filled] = pullBoth(child);
    expect(empty).toBe(filled);
  });

  it("자식 문단이 항목 안에 남는다 — 사이에 빈 줄이 없다", () => {
    expect(pull("<p>t</p>\n-\n\tx.\n- b\n")).toBe("<p>t</p>\n\n-\n    x.\n- b\n");
  });

  it("번호 목록의 빈 항목도 같다", () => {
    expect(pull("1.\n\tx.\n")).toBe("1.\n    x.\n");
  });
});
