/**
 * 제목 줄의 보존 마커를 제목 아래 줄로 — Obsidian 은 제목 줄의 `%%…%%` 를 제목 글자로 읽는다.
 *
 * 2026-10-28 격리 Obsidian 1.12.4 실측: `## 빨간 제목 %%im-nobsidian:block-color:red%%` 의 `metadataCache` 제목이
 * `빨간 제목 %%im-nobsidian:block-color:red%%` 였다(개요 · `[[노트#제목]]` 제안에 그대로). 마커만 있는 줄을 제목
 * 바로 아래에 두면 제목은 `빨간 제목` 이다.
 */
import { describe, it, expect } from "vitest";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";
import { isCompactExport } from "../../src/converter/post-processors/block-spacer.js";
import {
  liftHeadingMarkers,
  placeHeadingMarkersBelow,
  sectionLinesWithHeadingMarkers,
} from "../../src/converter/heading-markers.js";
import { TOGGLE_HEADING_END, TOGGLE_HEADING_START } from "../../src/constants/markers.js";

const PUSH = { direction: "push", path: "markdown-api", filePath: "a.md" } as const;
const PULL = { ...PUSH, direction: "pull" } as const;
const RED = "%%im-nobsidian:block-color:red%%";

function send(note: string): string {
  return obsidianToNotionEnhanced(createDefaultPipeline().convertToNotion(note, PUSH).content);
}

function receive(exported: string): string {
  return createDefaultPipeline()
    .convertToMarkdown(notionEnhancedToObsidian(exported), PULL, {
      notionExportCompact: isCompactExport(exported),
    })
    .trimEnd();
}

describe("placeHeadingMarkersBelow · liftHeadingMarkers", () => {
  it("제목 줄 끝의 색 마커를 아래 줄로 내리고, 되올리면 제자리다", () => {
    const old = `## 빨간 제목 ${RED}\n\n본문`;
    const placed = placeHeadingMarkersBelow(old);

    expect(placed).toBe(`## 빨간 제목\n${RED}\n\n본문`);
    expect(liftHeadingMarkers(placed)).toBe(old);
  });

  it("토글 헤딩의 색 · 시작 마커를 함께 내린다 — 끝 마커는 제목 것이 아니다", () => {
    const old = `### 토글 ${RED} ${TOGGLE_HEADING_START}\n#### 안쪽\n${TOGGLE_HEADING_END}`;
    const placed = placeHeadingMarkersBelow(old);

    expect(placed).toBe(
      `### 토글\n${RED} ${TOGGLE_HEADING_START}\n#### 안쪽\n${TOGGLE_HEADING_END}`,
    );
    // 안쪽 제목 바로 아래의 끝 마커를 그 제목에 올리지 않는다.
    expect(liftHeadingMarkers(placed)).toBe(old);
  });

  it("문단 · 목록의 마커와 코드 안은 두고, 두 번 해도 같다", () => {
    const text = `문단 ${RED}\n- 항목 ${RED}\n\n\`\`\`md\n## 코드 ${RED}\n\`\`\``;
    expect(placeHeadingMarkersBelow(text)).toBe(text);
    const placed = placeHeadingMarkersBelow(`# 제목 ${RED}`);
    expect(placeHeadingMarkersBelow(placed)).toBe(placed);
  });

  it("읽기 화면은 제목 섹션 다음 줄의 마커를 제목에 붙여 본다", () => {
    const all = ["# 맨 위", "", "## 빨간 제목", RED, "", "본문"];
    expect(sectionLinesWithHeadingMarkers(all, 2, 2)).toEqual([`## 빨간 제목 ${RED}`]);
    expect(sectionLinesWithHeadingMarkers(all, 5, 5)).toEqual(["본문"]);
  });
});

describe("pull · push 를 지나는 제목 색", () => {
  it("받으면 제목 줄에 마커가 없고, 올리면 Notion 의 제목 색 그대로다", () => {
    const nfm = '## 빨간 제목 {color="red"}\n\n본문';
    const pulled = receive(nfm);

    expect(pulled.split("\n")[0]).toBe("## 빨간 제목");
    expect(pulled).toContain(`## 빨간 제목\n${RED}`);
    expect(send(pulled).trimEnd()).toBe(nfm);
  });

  it("예전 꼴(제목 줄 끝 마커)로 받은 노트도 같은 것을 올린다", () => {
    expect(send(`## 빨간 제목 ${RED}\n\n본문`)).toBe(send(`## 빨간 제목\n${RED}\n\n본문`));
  });

  it("토글 헤딩 제목도 깨끗하고, 올리면 토글 · 색이 그대로다", () => {
    const nfm = '### 색 토글 {toggle="true" color="red_bg"}\n\t안쪽';
    const pulled = receive(nfm);

    expect(pulled.split("\n")[0]).toBe("### 색 토글");
    expect(send(pulled).trimEnd()).toBe(nfm);
  });
});
