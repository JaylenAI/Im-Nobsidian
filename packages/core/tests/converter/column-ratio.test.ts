/**
 * 칼럼 너비 비율(`<column ratio="62.5">`) 왕복 보존 (P10).
 *
 * 비율을 버리면 열 **개수**만 살아남아, push 마다 사용자가 잡아 둔 레이아웃이 균등 분할로
 * 리셋된다. pull 이 구분 마커에 비율을 실어 두고 push 가 정준형 속성으로 되돌리는지 본다.
 */
import { describe, it, expect } from "vitest";

import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";
import { COLUMN_SEP, columnMarker } from "../../src/constants/markers.js";

/** NFM 정준형 — 탭 들여쓴 컨테이너 태그. */
function nfmColumns(cols: Array<{ ratio?: string; body: string }>): string {
  const inner = cols
    .map((c) => `\t<column${c.ratio ? ` ratio="${c.ratio}"` : ""}>\n\t\t${c.body}\n\t</column>`)
    .join("\n");
  return `<columns>\n${inner}\n</columns>\n`;
}

function ratiosOf(pushed: string): Array<string | null> {
  return [...pushed.matchAll(/<column(?: ratio="([^"]*)")?>/g)].map((m) => m[1] ?? null);
}

describe("칼럼 비율 보존", () => {
  it("pull — 비율이 구분 마커에 실린다", () => {
    const pulled = notionEnhancedToObsidian(
      nfmColumns([
        { ratio: "62.5", body: "왼쪽" },
        { ratio: "37.5", body: "오른쪽" },
      ]),
    );
    expect(pulled).toContain(columnMarker("62.5"));
    expect(pulled).toContain(columnMarker("37.5"));
    expect(pulled).toContain("왼쪽");
    expect(pulled).toContain("오른쪽");
  });

  it("왕복 — 비율이 값·순서 그대로 되돌아온다", () => {
    const raw = nfmColumns([
      { ratio: "62.5", body: "왼쪽" },
      { ratio: "18.75", body: "가운데" },
      { ratio: "18.75", body: "오른쪽" },
    ]);
    const pushed = obsidianToNotionEnhanced(notionEnhancedToObsidian(raw));
    expect(ratiosOf(pushed)).toEqual(["62.5", "18.75", "18.75"]);
  });

  it("비율 없는 칼럼은 마커도 속성도 늘리지 않는다(구버전 볼트 호환)", () => {
    const raw = nfmColumns([{ body: "왼쪽" }, { body: "오른쪽" }]);
    const pulled = notionEnhancedToObsidian(raw);
    expect(pulled).toContain(COLUMN_SEP);
    expect(pulled).not.toContain("ratio=");
    expect(ratiosOf(obsidianToNotionEnhanced(pulled))).toEqual([null, null]);
  });

  it("비율 있는 칼럼과 없는 칼럼이 섞여도 자리를 지킨다", () => {
    const raw = nfmColumns([{ ratio: "70", body: "본문" }, { body: "여백" }]);
    expect(ratiosOf(obsidianToNotionEnhanced(notionEnhancedToObsidian(raw)))).toEqual(["70", null]);
  });

  it("빈 칼럼도 비율을 지킨다 — 여백 칸이 레이아웃의 일부다(D-EMPTY-COLUMN)", () => {
    const raw = nfmColumns([
      { ratio: "25", body: "" },
      { ratio: "75", body: "본문" },
    ]);
    expect(ratiosOf(obsidianToNotionEnhanced(notionEnhancedToObsidian(raw)))).toEqual(["25", "75"]);
  });

  it("형식을 벗어난 비율은 값만 버리고 칼럼은 살린다", () => {
    // 마커 페이로드에 `%%` 나 개행이 들어가면 마커가 두 동강 나 칼럼 경계가 무너진다.
    const raw =
      '<columns>\n\t<column ratio="50%%위험">\n\t\t왼쪽\n\t</column>\n\t<column>\n\t\t오른쪽\n\t</column>\n</columns>\n';
    const pulled = notionEnhancedToObsidian(raw);
    expect(pulled).not.toContain("위험");
    expect(ratiosOf(obsidianToNotionEnhanced(pulled))).toEqual([null, null]);
  });

  it("중첩 칼럼도 각 층의 비율을 잃지 않는다", () => {
    const innerCols = nfmColumns([
      { ratio: "40", body: "안쪽 왼쪽" },
      { ratio: "60", body: "안쪽 오른쪽" },
    ]).trimEnd();
    const raw = `<columns>\n\t<column ratio="80">\n${innerCols
      .split("\n")
      .map((l) => `\t\t${l}`)
      .join("\n")}\n\t</column>\n\t<column ratio="20">\n\t\t바깥 오른쪽\n\t</column>\n</columns>\n`;
    const pushed = obsidianToNotionEnhanced(notionEnhancedToObsidian(raw));
    expect(ratiosOf(pushed).sort()).toEqual(["20", "40", "60", "80"]);
  });
});
