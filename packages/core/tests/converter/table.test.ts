/**
 * F-04 — Notion 표 속성(머리 행 · 머리 열 · 페이지 너비 · 열 너비 · 행/셀/열 색)의 볼트 왕복.
 *
 * NFM 모양은 2026-10-04 실측 export 를 그대로 쓴다(「표 속성」 · 「표 쓰기 형태」 프로브 페이지).
 * 예전 pull 은 속성을 버려 다음 push 가 Notion 의 표 속성을 지웠고, 머리 행이 없는 표는 머리 행
 * 표가 됐다.
 */
import { describe, it, expect } from "vitest";
import {
  nfmTablesToPipeTables,
  pipeTablesToNfmTables,
  stripTableMarkers,
} from "../../src/converter/table.js";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";

const M = (part: string, payload: string) => `%%im-nobsidian:${part}:${payload}%%`;

/** 실측 — 「표 속성」 첫 표. 셀 안 줄바꿈은 `<br>`, 파이프는 `\|` 로 온다. */
const ATTR_TABLE = [
  '<table fit-page-width="true" header-row="true" header-column="true">',
  "<colgroup>",
  '<col color="blue_bg" width="200">',
  '<col width="120">',
  '<col color="red">',
  "</colgroup>",
  '<tr color="gray_bg">',
  "<td>항목</td>",
  "<td>값</td>",
  "<td>비고</td>",
  "</tr>",
  "<tr>",
  "<td>A</td>",
  '<td color="red_bg">빨강 배경 셀</td>',
  "<td>a \\| b</td>",
  "</tr>",
  '<tr color="yellow_bg">',
  "<td>B</td>",
  "<td>첫 줄<br>둘째 줄</td>",
  "<td></td>",
  "</tr>",
  "</table>",
].join("\n");

const ATTR_PIPE = [
  `| ${M("table", "fit-page-width=true&header-row=true&header-column=true")}${M("table-col", "color=blue_bg&width=200")}${M("table-row", "color=gray_bg")}항목 | ${M("table-col", "width=120")}값 | ${M("table-col", "color=red")}비고 |`,
  "| --- | --- | --- |",
  `| A | ${M("table-cell", "color=red_bg")}빨강 배경 셀 | a \\| b |`,
  `| ${M("table-row", "color=yellow_bg")}B | 첫 줄<br>둘째 줄 |  |`,
].join("\n");

/** NFM 표 줄 — 테스트에서 표를 짧게 적는다. */
function nfm(open: string, rows: string[][], cols?: string[]): string {
  return [
    open,
    ...(cols ? ["<colgroup>", ...cols, "</colgroup>"] : []),
    ...rows.flatMap((cells) => ["<tr>", ...cells.map((c) => `<td>${c}</td>`), "</tr>"]),
    "</table>",
  ].join("\n");
}

describe("pull — NFM 표 속성을 셀 머리 마커로", () => {
  it("표 · 열 · 행 · 셀 속성을 각자 자리의 셀에 싣는다", () => {
    expect(nfmTablesToPipeTables(ATTR_TABLE)).toBe(ATTR_PIPE);
  });

  it("속성 없는 <table> 은 머리 행이 없는 표다 — header-row=false 를 적는다", () => {
    expect(
      nfmTablesToPipeTables(
        nfm("<table>", [
          ["x", "y"],
          ["1", "2"],
        ]),
      ),
    ).toBe([`| ${M("table", "header-row=false")}x | y |`, "| --- | --- |", "| 1 | 2 |"].join("\n"));
  });

  it("머리 행만 켠 표는 파이프 표 그대로 — 마커가 없다", () => {
    expect(
      nfmTablesToPipeTables(
        nfm('<table header-row="true">', [
          ["a", "b"],
          ["1", "2"],
        ]),
      ),
    ).toBe(["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n"));
  });

  it("옛 export 의 닫힌 <col/> 도 같은 열 속성이다", () => {
    const open = '<table header-row="true">';
    const rows = [["a", "b"]];
    expect(nfmTablesToPipeTables(nfm(open, rows, ['<col width="120"/>', "<col/>"]))).toBe(
      nfmTablesToPipeTables(nfm(open, rows, ['<col width="120">', "<col>"])),
    );
  });

  it("속성 없는 <col> 이 열 자리를 지킨다", () => {
    const pulled = nfmTablesToPipeTables(
      nfm('<table header-row="true">', [["1", "2", "3"]], ["<col>", '<col color="red">', "<col>"]),
    );
    expect(pulled.split("\n")[0]).toBe(`| 1 | ${M("table-col", "color=red")}2 | 3 |`);
  });

  it("콜아웃 안 표의 모든 행이 인용 접두를 갖는다", () => {
    const raw = [
      '> <table header-row="true" header-column="true">',
      '<tr color="blue_bg">',
      "<td>머리</td>",
      '<td color="red_bg">빨강</td>',
      "</tr>",
      "> </table>",
    ].join("\n");
    expect(nfmTablesToPipeTables(raw)).toBe(
      [
        `> | ${M("table", "header-row=true&header-column=true")}${M("table-row", "color=blue_bg")}머리 | ${M("table-cell", "color=red_bg")}빨강 |`,
        "> | --- | --- |",
      ].join("\n"),
    );
  });

  it("속성 값의 & · = · % 는 퍼센트 인코딩해 싣는다", () => {
    const pulled = nfmTablesToPipeTables(nfm('<table header-row="true" note="a&b=c%">', [["x"]]));
    expect(pulled).toContain(M("table", "header-row=true&note=a%26b%3Dc%25"));
    expect(pipeTablesToNfmTables(pulled)).toContain('<table header-row="true" note="a&b=c%">');
  });

  it("코드블록 안의 <table> 은 예제 코드다", () => {
    const raw = ["```html", "<table>", "<tr><td>가</td></tr>", "</table>", "```"].join("\n");
    expect(nfmTablesToPipeTables(raw)).toBe(raw);
  });
});

describe("push — 마커가 든 파이프 표를 NFM 표로", () => {
  it("pull 한 표를 그대로 되돌린다", () => {
    expect(pipeTablesToNfmTables(ATTR_PIPE)).toBe(ATTR_TABLE);
  });

  it("마커가 없는 표는 파이프 표 그대로 둔다", () => {
    const plain = ["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n");
    expect(pipeTablesToNfmTables(plain)).toBe(plain);
  });

  it("머리 행 없는 표는 속성 없는 <table> 로 — 거짓 속성을 적지 않는다", () => {
    const pipe = [`| ${M("table", "header-row=false")}x | y |`, "| --- | --- |"].join("\n");
    expect(pipeTablesToNfmTables(pipe).split("\n")[0]).toBe("<table>");
    const withColumn = pipe.replace("header-row=false", "header-row=false&header-column=true");
    expect(pipeTablesToNfmTables(withColumn).split("\n")[0]).toBe('<table header-column="true">');
  });

  it("마커가 셀과 함께 움직이면 속성도 따라간다 — 열 맞바꿈 · 행 끼움", () => {
    // Obsidian 에서 첫째 · 둘째 열을 맞바꾸고 둘째 행 앞에 새 행을 끼운 모양
    const edited = [
      `| ${M("table-col", "width=120")}값 | ${M("table", "fit-page-width=true&header-row=true&header-column=true")}${M("table-col", "color=blue_bg&width=200")}${M("table-row", "color=gray_bg")}항목 | ${M("table-col", "color=red")}비고 |`,
      "| --- | --- | --- |",
      "| 새 | 행 | 끼움 |",
      `| ${M("table-cell", "color=red_bg")}빨강 배경 셀 | A | a \\| b |`,
    ].join("\n");
    const lines = pipeTablesToNfmTables(edited).split("\n");
    expect(lines.slice(0, 6)).toEqual([
      '<table fit-page-width="true" header-row="true" header-column="true">',
      "<colgroup>",
      '<col width="120">',
      '<col color="blue_bg" width="200">',
      '<col color="red">',
      "</colgroup>",
    ]);
    // 행 마커가 첫 셀이 아닌 칸으로 옮겨 가도 그 행의 속성이다
    expect(lines[6]).toBe('<tr color="gray_bg">');
    expect(lines.slice(11, 16)).toEqual([
      "<tr>",
      "<td>새</td>",
      "<td>행</td>",
      "<td>끼움</td>",
      "</tr>",
    ]);
    expect(lines[17]).toBe('<td color="red_bg">빨강 배경 셀</td>');
  });

  it("머리보다 칸이 많은 행이 있으면 머리를 빈 칸으로 늘린다", () => {
    const pipe = [
      `| ${M("table", "header-row=false")}a | b |`,
      "| --- | --- |",
      "| 1 | 2 | 3 |",
    ].join("\n");
    expect(pipeTablesToNfmTables(pipe)).toBe(
      nfm("<table>", [
        ["a", "b", ""],
        ["1", "2", "3"],
      ]),
    );
  });

  it("정렬 구분행도 구분행이다", () => {
    const pipe = [
      `| ${M("table", "header-row=false")}a | b |`,
      "| :--- | ---: |",
      "| 1 | 2 |",
    ].join("\n");
    expect(pipeTablesToNfmTables(pipe)).toBe(
      nfm("<table>", [
        ["a", "b"],
        ["1", "2"],
      ]),
    );
  });

  it("칸이 하나인 표", () => {
    const pipe = [`| ${M("table", "header-row=false")}a |`, "| --- |", "| 1 |"].join("\n");
    expect(pipeTablesToNfmTables(pipe)).toBe(nfm("<table>", [["a"], ["1"]]));
  });

  it("인용 안 표는 모든 줄에 같은 접두를 입힌다", () => {
    const pipe = [
      `> | ${M("table", "header-row=false")}a | b |`,
      "> | --- | --- |",
      "> | 1 | 2 |",
    ].join("\n");
    const lines = pipeTablesToNfmTables(pipe).split("\n");
    expect(lines.every((l) => l.startsWith("> "))).toBe(true);
    expect(lines[0]).toBe("> <table>");
  });

  it("코드블록 안의 파이프 표는 코드다", () => {
    const code = ["```md", `| ${M("table", "header-row=false")}a |`, "| --- |", "```"].join("\n");
    expect(pipeTablesToNfmTables(code)).toBe(code);
  });
});

describe("변환 전체 왕복", () => {
  it("콜아웃 안 속성 표가 NFM 의 비대칭 들여쓰기 그대로 돌아간다", () => {
    const raw = [
      '<callout icon="💡">',
      "\t콜아웃 글",
      '\t<table header-row="true" header-column="true">',
      '<tr color="blue_bg">',
      "<td>머리</td>",
      '<td color="red_bg">빨강</td>',
      "</tr>",
      "<tr>",
      "<td>a</td>",
      "<td>b</td>",
      "</tr>",
      "\t</table>",
      "</callout>",
    ].join("\n");
    const pulled = notionEnhancedToObsidian(raw);
    expect(obsidianToNotionEnhanced(pulled)).toBe(raw);
  });

  it("두 번째 왕복이 첫 번째와 같다", () => {
    const pulled = notionEnhancedToObsidian(ATTR_TABLE);
    const pushed = obsidianToNotionEnhanced(pulled);
    expect(pushed).toBe(ATTR_TABLE);
    expect(notionEnhancedToObsidian(pushed)).toBe(pulled);
  });
});

describe("stripTableMarkers — 블록 방식 push", () => {
  it("표 마커 네 종류만 걷는다", () => {
    expect(stripTableMarkers(ATTR_PIPE)).not.toContain("%%im-nobsidian:table");
    const other = `${M("table-row", "color=gray_bg")}a ${M("color", "red")}b%%/color%%`;
    expect(stripTableMarkers(other)).toBe(`a ${M("color", "red")}b%%/color%%`);
  });
});
