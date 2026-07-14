import { describe, it, expect } from "vitest";
import {
  TableAlignmentGuard,
  parseDelimiterRow,
  cellAlignment,
  alignmentsToDelimiter,
} from "../../src/converter/pre-processors/table-alignment.js";
import { TableAlignmentRestorer } from "../../src/converter/post-processors/table-alignment-restorer.js";
import type { ProcessorInput, PreserveMarker } from "../../src/types/convert.js";

const pushContext = {
  direction: "push" as const,
  path: "markdown-api" as const,
  filePath: "test.md",
};
const pullContext = { ...pushContext, direction: "pull" as const };

const TABLE = ["| 이름 | 나이 | 점수 |", "| :--- | :---: | ---: |", "| 김 | 30 | 95 |"].join("\n");

describe("parseDelimiterRow / cellAlignment / alignmentsToDelimiter", () => {
  it("정렬 구분행 파싱", () => {
    expect(parseDelimiterRow("| :--- | :---: | ---: |")).toEqual([":---", ":---:", "---:"]);
  });

  it("데이터 행은 null", () => {
    expect(parseDelimiterRow("| 김 | 30 | 95 |")).toBeNull();
    expect(parseDelimiterRow("일반 문장 - 하이픈 | 포함")).toBeNull();
  });

  it("정렬 판정", () => {
    expect(cellAlignment(":---")).toBe("left");
    expect(cellAlignment(":---:")).toBe("center");
    expect(cellAlignment("---:")).toBe("right");
    expect(cellAlignment("---")).toBe("none");
  });

  it("정렬 배열 → 구분행", () => {
    expect(alignmentsToDelimiter(["left", "center", "right", "none"])).toBe(
      "| :--- | :---: | ---: | --- |",
    );
  });
});

describe("TableAlignmentGuard (F30 push)", () => {
  it("정렬 구분행을 표준형으로 바꾸고 마커를 남김", () => {
    const input: ProcessorInput = { content: TABLE, metadata: {}, context: pushContext };
    const result = new TableAlignmentGuard().process(input);
    expect(result.content.split("\n")[1]).toBe("| --- | --- | --- |");
    const markers = result.metadata.preserveMarkers ?? [];
    expect(markers).toHaveLength(1);
    expect(markers[0]!.type).toBe("table-align");
    expect(markers[0]!.params.align).toBe("left,center,right");
    expect(markers[0]!.params.__anchor).toBe("| 이름 | 나이 | 점수 |");
  });

  it("콜론 없는 표준 구분행은 무변경·마커 없음", () => {
    const plain = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    const input: ProcessorInput = { content: plain, metadata: {}, context: pushContext };
    const result = new TableAlignmentGuard().process(input);
    expect(result.content).toBe(plain);
    expect(result.metadata.preserveMarkers ?? []).toHaveLength(0);
  });

  it("pull 방향에서는 무동작", () => {
    const input: ProcessorInput = { content: TABLE, metadata: {}, context: pullContext };
    expect(new TableAlignmentRestorer().name).toBeTruthy();
    expect(new TableAlignmentGuard().process(input).content).toBe(TABLE);
  });
});

describe("TableAlignmentRestorer (F30 pull)", () => {
  it("마커 앵커로 표준 구분행을 정렬 구분행으로 복원하고 마커를 소비", () => {
    const pulled = ["| 이름 | 나이 | 점수 |", "| --- | --- | --- |", "| 김 | 30 | 95 |"].join("\n");
    const marker: PreserveMarker = {
      type: "table-align",
      params: { align: "left,center,right", __anchor: "| 이름 | 나이 | 점수 |" },
      startIndex: 0,
    };
    const result = new TableAlignmentRestorer().process({
      content: pulled,
      metadata: { preserveMarkers: [marker] },
      context: pullContext,
    });
    expect(result.content.split("\n")[1]).toBe("| :--- | :---: | ---: |");
    expect(result.metadata.preserveMarkers ?? []).toHaveLength(0);
  });

  it("팬텀 정렬행(레거시 push 산출물)을 구분행에 병합·제거", () => {
    // Notion 임포터가 정렬행을 데이터 행으로 강등시킨 형태
    const legacy = [
      "| 이름 | 나이 | 점수 |",
      "| --- | --- | --- |",
      "| :--- | :---: | ---: |",
      "| 김 | 30 | 95 |",
    ].join("\n");
    const result = new TableAlignmentRestorer().process({
      content: legacy,
      metadata: {},
      context: pullContext,
    });
    const lines = result.content.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("| :--- | :---: | ---: |");
    expect(lines[2]).toBe("| 김 | 30 | 95 |");
  });

  it("앵커 유실 마커는 폐기(재삽입 노이즈 방지)·본문 무변경", () => {
    const content = "표 없는 본문";
    const marker: PreserveMarker = {
      type: "table-align",
      params: { align: "left", __anchor: "| 사라진 헤더 |" },
      startIndex: 0,
    };
    const result = new TableAlignmentRestorer().process({
      content,
      metadata: { preserveMarkers: [marker] },
      context: pullContext,
    });
    expect(result.content).toBe(content);
    expect(result.metadata.preserveMarkers ?? []).toHaveLength(0);
  });

  it("table-align 외 마커는 통과", () => {
    const marker: PreserveMarker = { type: "wikilink", params: { text: "x" }, startIndex: 0 };
    const result = new TableAlignmentRestorer().process({
      content: "본문",
      metadata: { preserveMarkers: [marker] },
      context: pullContext,
    });
    expect(result.metadata.preserveMarkers).toEqual([marker]);
  });

  it("왕복: Guard → (Notion 표준 구분행 유지 가정) → Restorer 가 원형 복원", () => {
    const guardOut = new TableAlignmentGuard().process({
      content: TABLE,
      metadata: {},
      context: pushContext,
    });
    const restored = new TableAlignmentRestorer().process({
      content: guardOut.content,
      metadata: { preserveMarkers: guardOut.metadata.preserveMarkers },
      context: pullContext,
    });
    expect(restored.content).toBe(TABLE);
  });
});
