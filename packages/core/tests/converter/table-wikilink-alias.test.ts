/**
 * 표 칸의 별칭 위키링크 `[[대상\|별칭]]` — Obsidian 은 표 칸에서 별칭 구분자를 `\|` 로 적는다.
 *
 * 예전 push 는 대상을 `대상\` 으로 읽어 볼트의 노트도 찾지 못했고, 글로 남긴 `[[대상\|별칭]]` 을 파이프 표로 보내
 * Notion 이 `\|` 에서 칸을 갈랐다 — 표에 열이 하나 늘었다(2026-10-24 실측). NFM 칸은 `[[x|y]]` 를 글자 그대로 두고
 * `\[\[x\|y\]\]` 로 돌려준다(실측).
 */
import { describe, it, expect } from "vitest";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";
import { isCompactExport } from "../../src/converter/post-processors/block-spacer.js";
import {
  degradeUnresolvedNotionIdWikilinks,
  resolveNotionIdWikilinks,
} from "../../src/converter/notion-id-links.js";
import type { WikilinkEntry } from "../../src/types/convert.js";

const PUSH = { direction: "push", path: "markdown-api", filePath: "a.md" } as const;
const PULL = { ...PUSH, direction: "pull" } as const;
const NOTE_ID = "26d279f5-d672-8014-b877-dffb738dc221";
const NOTE: WikilinkEntry = {
  obsidianPath: "노트.md",
  notionPageId: NOTE_ID,
  title: "노트",
  aliases: [],
};

function send(note: string): string {
  const pipeline = createDefaultPipeline({
    wikilinkResolver: (text) => (text === "노트" ? NOTE : null),
  });
  return obsidianToNotionEnhanced(pipeline.convertToNotion(note, PUSH).content);
}

function receive(exported: string): string {
  return createDefaultPipeline()
    .convertToMarkdown(notionEnhancedToObsidian(exported), PULL, {
      notionExportCompact: isCompactExport(exported),
    })
    .trimEnd();
}

const table = (cell: string) => `| a | b |\n| --- | --- |\n| ${cell} | z |\n`;

describe("표 칸의 별칭 위키링크", () => {
  it("볼트에 있는 노트는 링크가 된다 — 대상 끝의 `\\` 는 별칭 구분자의 escape", () => {
    expect(send(table("[[노트\\|별칭]]"))).toContain(
      `| [별칭](https://www.notion.so/${NOTE_ID.replace(/-/g, "")}) | z |`,
    );
  });

  it("볼트에 없는 노트는 NFM 표의 칸에 글로 — 칸이 갈리지 않는다", () => {
    const sent = send(table("[[없는 노트\\|별칭]]"));
    expect(sent).toContain("<td>[[없는 노트|별칭]]</td>");
    expect(sent).not.toContain("| [[");
  });

  it("받으면 표 칸의 모양으로 돌아온다", () => {
    const exported =
      '<table header-row="true">\n<tr>\n<td>a</td>\n<td>b</td>\n</tr>\n<tr>\n<td>\\[\\[없는 노트\\|별칭\\]\\]</td>\n<td>z</td>\n</tr>\n</table>';
    expect(receive(exported)).toBe(table("[[없는 노트\\|별칭]]").trimEnd());
  });

  it("표 밖의 별칭 위키링크는 그대로", () => {
    expect(send("[[없는 노트|별칭]]")).toBe("[[없는 노트|별칭]]");
  });

  describe("같은 pull 에서 뒤에 받은 노트를 가리키는 표 칸 링크", () => {
    const COMPACT = NOTE_ID.replace(/-/g, "");
    const lookup = (id: string) => (id === COMPACT ? "폴더/노트.md" : null);

    it("대상을 찾으면 표 칸의 구분자 그대로 위키링크로", () => {
      expect(resolveNotionIdWikilinks(table(`[[notion:${COMPACT}\\|별칭]]`), lookup).markdown).toBe(
        table("[[노트\\|별칭]]"),
      );
    });

    it("별칭이 제목과 같으면 접는다", () => {
      expect(resolveNotionIdWikilinks(table(`[[notion:${COMPACT}\\|노트]]`), lookup).markdown).toBe(
        table("[[노트]]"),
      );
    });

    it("끝내 못 찾으면 동작하는 링크로", () => {
      expect(
        degradeUnresolvedNotionIdWikilinks(table(`[[notion:${COMPACT}\\|별칭]]`)).markdown,
      ).toBe(table(`[별칭](https://www.notion.so/${COMPACT})`));
    });
  });
});
