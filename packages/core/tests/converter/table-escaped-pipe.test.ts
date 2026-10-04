/**
 * F-06 — 표 칸 안 파이프(`\|`)가 Notion 에서 칸을 쪼개던 결함.
 *
 * Notion 은 파이프 표의 `\|` 를 이스케이프로 읽지 않아 `| x\|y | z |` 가 `x\` · `y` · `z` 세 칸이
 * 됐다(2026-10-04 실측). 그런 표는 NFM 표로 보낸다 — NFM 칸에서는 `\|` 가 파이프 글자다.
 *
 * 코드는 양쪽 다 글자 그대로다. Obsidian 은 칸의 코드를 백슬래시째 보이고 짝수 개 백슬래시 뒤의
 * 파이프에서 칸을 가르며(1.12.4 실측), NFM 칸의 코드도 백슬래시를 남긴다. 그래서 코드 속 파이프 앞
 * 백슬래시 k개를 볼트에 2k+1개로 적고, 보낼 때 k개로 되돌린다.
 *
 * 칸 모양은 Notion 이 실제로 내보낸 것이다 — 글의 파이프는 `\|`, 글자 그대로의 `\|` 는 `\\\|`. 코드는
 * 글자 그대로라 파이프는 `|`, 코드 속 `\|` 는 `\|` 다.
 */
import { describe, it, expect } from "vitest";
import { pipeTablesToNfmTables } from "../../src/converter/table.js";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";

const PULL = { direction: "pull", path: "markdown-api", filePath: "a.md" } as const;
const PUSH = { direction: "push", path: "markdown-api", filePath: "a.md" } as const;

/** 받아 볼트에 쓰는 글 — 변환기 뒤 후처리기까지. */
const pull = (nfm: string): string =>
  createDefaultPipeline().convertToMarkdown(notionEnhancedToObsidian(nfm), PULL);
/** push 가 Notion 에 보내는 글. */
const push = (note: string): string =>
  obsidianToNotionEnhanced(createDefaultPipeline().convertToNotion(note, PUSH).content);

/** 머리 행 NFM 표 — 새 파이프 표를 받은 Notion 의 속성이다. */
function nfm(rows: string[][]): string {
  return [
    '<table header-row="true">',
    ...rows.flatMap((cells) => ["<tr>", ...cells.map((c) => `<td>${c}</td>`), "</tr>"]),
    "</table>",
  ].join("\n");
}

describe("push — 칸에 `\\|` 가 있는 표는 NFM 표로", () => {
  it("마커가 없어도 NFM 표로 보내 칸이 갈리지 않는다", () => {
    const pipe = ["| a | b |", "| --- | --- |", "| x\\|y | z |"].join("\n");
    expect(pipeTablesToNfmTables(pipe)).toBe(
      nfm([
        ["a", "b"],
        ["x\\|y", "z"],
      ]),
    );
  });

  it("코드 안의 `\\|` 는 모두 날 `|` 로, 코드 밖은 그대로", () => {
    const pipe = ["| a | b |", "| --- | --- |", "| `a\\|b\\|c` x\\|y | ``e\\|f`` |"].join("\n");
    expect(pipeTablesToNfmTables(pipe)).toBe(
      nfm([
        ["a", "b"],
        ["`a|b|c` x\\|y", "``e|f``"],
      ]),
    );
  });

  it("백슬래시 둘 뒤의 파이프는 칸 경계다 — Obsidian 처럼", () => {
    const pipe = ["| a | b |", "| --- | --- |", "| x\\\\| y |", "| `p\\\\\\|q` | r\\\\|"].join(
      "\n",
    );
    expect(pipeTablesToNfmTables(pipe)).toBe(
      nfm([
        ["a", "b"],
        ["x\\\\", "y"],
        ["`p\\|q`", "r\\\\"],
      ]),
    );
  });

  it("파이프가 없는 표 · 코드블록 안의 표는 그대로 둔다", () => {
    const plain = ["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n");
    const code = ["```md", "| a |", "| --- |", "| x\\|y |", "```"].join("\n");
    expect(pipeTablesToNfmTables(plain)).toBe(plain);
    expect(pipeTablesToNfmTables(code)).toBe(code);
  });

  it("콜아웃 안 표도 NFM 표로 — 콜아웃의 들여쓰기 그대로", () => {
    const note = ["> [!note] 콜", "> | h |", "> | --- |", "> | `k\\|v` |"].join("\n");
    expect(push(note)).toBe(
      [
        '<callout icon="📝">',
        "\t콜",
        '\t<table header-row="true">',
        "<tr>",
        "<td>h</td>",
        "</tr>",
        "<tr>",
        "<td>`k|v`</td>",
        "</tr>",
        "\t</table>",
        "</callout>",
      ].join("\n"),
    );
  });
});

describe("왕복 — Notion 이 내보낸 칸이 그대로 돌아간다", () => {
  const raw = nfm([
    ["a", "b"],
    ["x\\|y", "`c|d`"],
    ["**굵\\|게**", "p \\\\\\| q"],
    ["`g\\|h`", "끝"],
  ]);

  it("받으면 코드 속 파이프 앞 백슬래시 k개를 2k+1개로 — 칸이 갈리지 않는다", () => {
    expect(pull(raw)).toBe(
      [
        "| a | b |",
        "| --- | --- |",
        "| x\\|y | `c\\|d` |",
        "| **굵\\|게** | p \\\\\\| q |",
        "| `g\\\\\\|h` | 끝 |",
      ].join("\n"),
    );
  });

  it("다시 보내면 받은 표와 같다", () => {
    expect(push(pull(raw))).toBe(raw);
  });
});
