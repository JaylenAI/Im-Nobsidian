/**
 * 제목 · 블록으로 가는 위키링크 ↔ Notion 블록 링크 (P6). Notion 은 블록 링크를 `https://app.notion.com/p/<페이지>#<블록>`
 * 으로, 글자의 `>` · `^` 를 `\>` · `\^` 로 돌려준다(2026-10-30 실측).
 */
import { describe, it, expect } from "vitest";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";
import { obsidianToNotionEnhanced } from "../../src/converter/enhanced-md-converter.js";
import {
  anchorBlockId,
  anchorBlockOf,
  anchorDisplay,
  anchorOfBlock,
  anchoredWikilinkTargets,
  anchorTargetOfDisplay,
  splitAnchor,
  type AnchorBlock,
  type AnchorLookup,
} from "../../src/converter/anchor-links.js";
import {
  notionBlockLinkIds,
  resolveNotionBlockLinks,
} from "../../src/converter/notion-id-links.js";
import type { WikilinkEntry } from "../../src/types/convert.js";

const PAGE = "26d279f5d6728014b877dffb738dc221";
const SELF = "36d279f5d6728014b877dffb738dc221";
const H1 = "a".repeat(32);
const H2 = "b".repeat(32);
const PARA = "c".repeat(32);
const NESTED = "d".repeat(32);
const SELF_H = "9".repeat(32);
const BLOCKS: AnchorBlock[] = [
  { id: H1, heading: true, text: "첫 제목" },
  { id: PARA, heading: false, text: "본문 문단 ^abc-1" },
  { id: H2, heading: true, text: "둘째: 제목" },
  { id: NESTED, heading: true, text: "첫 제목" },
];
const NOTE: WikilinkEntry = {
  obsidianPath: "폴더/앵커.md",
  notionPageId: PAGE,
  title: "앵커",
  aliases: [],
};

describe("앵커 — 순수 함수", () => {
  it("대상을 노트와 앵커로 가른다", () => {
    expect(splitAnchor("앵커#둘째 제목")).toEqual({ note: "앵커", anchor: "둘째 제목" });
    expect(splitAnchor("#^abc")).toEqual({ note: "", anchor: "^abc" });
    expect(splitAnchor("앵커")).toBeNull();
    expect(splitAnchor("앵커#")).toBeNull();
  });

  it("Obsidian 이 보이는 글자", () => {
    expect(anchorDisplay("앵커", "가#나")).toBe("앵커 > 가 > 나");
    expect(anchorDisplay("", "가")).toBe("가");
  });

  it("제목은 Obsidian 이 빼는 글자를 빼고 견주고, 위 제목부터 차례로 찾는다", () => {
    expect(anchorBlockId(BLOCKS, "둘째 제목")).toBe(H2);
    expect(anchorBlockId(BLOCKS, "첫 제목")).toBe(H1);
    expect(anchorBlockId(BLOCKS, "둘째 제목#첫 제목")).toBe(NESTED);
    expect(anchorBlockId(BLOCKS, "없는 제목")).toBeNull();
  });

  it("블록 id 는 글 끝에 그 id 를 적은 블록", () => {
    expect(anchorBlockId(BLOCKS, "^abc-1")).toBe(PARA);
    expect(anchorBlockId(BLOCKS, "^abc")).toBeNull();
  });

  it("블록 → 앵커 — 제목 글자 · 글 끝 블록 id, 둘 다 아니면 null", () => {
    expect(anchorOfBlock(BLOCKS[2]!)).toBe("둘째 제목");
    expect(anchorOfBlock(BLOCKS[1]!)).toBe("^abc-1");
    expect(anchorOfBlock({ id: "x", heading: false, text: "그냥 문단" })).toBeNull();
  });

  it("Notion 블록 → 앵커 블록 — 토글 제목도 제목", () => {
    const block = {
      id: H1,
      type: "heading_3",
      heading_3: { rich_text: [{ plain_text: "가 " }, { plain_text: "나" }], is_toggleable: true },
    };
    expect(anchorBlockOf(block)).toEqual({ id: H1, heading: true, text: "가 나" });
    expect(anchorBlockOf({ id: H2, type: "divider", divider: {} }).heading).toBe(false);
  });

  it("노트의 앵커 링크 대상 — 임베드는 빼고 표 칸의 별칭 구분자를 받는다", () => {
    expect(
      anchoredWikilinkTargets("[[앵커#가]] [[앵커#가|별]] ![[앵커#나]] [[앵커]] | [[#다\\|별]] |"),
    ).toEqual(["앵커#가", "#다"]);
  });

  it("링크 글자에서 노트를 적은 꼴과 위 제목을 되살린다", () => {
    const forms = ["폴더/앵커", "앵커"];
    expect(anchorTargetOfDisplay("폴더/앵커 > 둘째 제목", forms, "둘째 제목")).toBe(
      "폴더/앵커#둘째 제목",
    );
    expect(anchorTargetOfDisplay("앵커 > 가 > 둘째 제목", forms, "둘째 제목")).toBe(
      "앵커#가#둘째 제목",
    );
    expect(anchorTargetOfDisplay("여기로", forms, "둘째 제목")).toBeNull();
    expect(anchorTargetOfDisplay("앵커 > 다른 제목", forms, "둘째 제목")).toBeNull();
  });
});

/** 미리 읽은 블록 — {@link PAGE} 와 자기 페이지({@link SELF}). */
const ANCHORS: AnchorLookup = {
  selfPageId: SELF,
  blockOf: (pageId, anchor) =>
    anchorBlockId(
      pageId === PAGE
        ? BLOCKS
        : pageId === SELF
          ? [{ id: SELF_H, heading: true, text: "아래" }]
          : [],
      anchor,
    ),
};

function send(note: string, anchors: AnchorLookup | null = ANCHORS): string {
  const pipeline = createDefaultPipeline({
    wikilinkResolver: (text) => (text === "앵커" || text === "폴더/앵커" ? NOTE : null),
  });
  return obsidianToNotionEnhanced(
    pipeline.convertToNotion(note, {
      direction: "push",
      path: "markdown-api",
      filePath: "링크.md",
      ...(anchors ? { anchors } : {}),
    }).content,
  );
}

describe("push — 제목 · 블록 링크를 Notion 블록 링크로", () => {
  it("별칭이 없으면 Obsidian 이 보이는 글자로, 별칭이 있으면 별칭으로", () => {
    expect(send("[[앵커#둘째 제목]]")).toBe(
      `[앵커 > 둘째 제목](https://www.notion.so/${PAGE}#${H2})`,
    );
    expect(send("[[앵커#^abc-1|문단]]")).toBe(`[문단](https://www.notion.so/${PAGE}#${PARA})`);
  });

  it("자기 노트의 제목 · 경로로 적은 노트", () => {
    expect(send("[[#아래]]")).toBe(`[아래](https://www.notion.so/${SELF}#${SELF_H})`);
    expect(send("[[폴더/앵커#첫 제목]]")).toBe(
      `[폴더/앵커 > 첫 제목](https://www.notion.so/${PAGE}#${H1})`,
    );
  });

  it("못 찾은 제목 · 블록을 읽지 않은 노트는 예전처럼 글로", () => {
    expect(send("[[앵커#없는 제목]]")).toBe("[[앵커#없는 제목]]");
    expect(send("[[앵커#둘째 제목]]", null)).toBe("[[앵커#둘째 제목]]");
  });
});

/** Notion 이 돌려주는 꼴 — 앱 주소 · `>` 와 `^` 를 escape. */
function asNotionReturns(nfm: string): string {
  return nfm
    .replace(/https:\/\/www\.notion\.so\//g, "https://app.notion.com/p/")
    .replace(/\[([^\]]*)\]\(/g, (_m, label: string) => `[${label.replace(/([>^])/g, "\\$1")}](`);
}

const pathOf = (id: string) => (id === PAGE ? "폴더/앵커.md" : id === SELF ? "링크.md" : null);
const anchorOf = (id: string) =>
  anchorOfBlock([...BLOCKS, { id: SELF_H, heading: true, text: "아래" }].find((b) => b.id === id)!);

function receive(nfm: string): string {
  return resolveNotionBlockLinks(asNotionReturns(nfm), pathOf, anchorOf, SELF).markdown;
}

describe("pull — Notion 블록 링크를 제목 · 블록 링크로", () => {
  it.each([
    "[[앵커#둘째 제목]]",
    "[[앵커#^abc-1|문단]]",
    "[[#아래]]",
    "[[폴더/앵커#첫 제목]]",
    "[[앵커#둘째 제목#첫 제목]]",
    "[[앵커#^abc-1]]",
  ])("보낸 블록 링크가 그대로 돌아온다 — %s", (note) => {
    const sent = send(note);
    expect(sent).toMatch(/^\[[^\]]+\]\(https:\/\/www\.notion\.so\/[0-9a-f]{32}#[0-9a-f]{32}\)$/);
    expect(receive(sent)).toBe(note);
  });

  it("Notion 에서 만든 링크는 그 글자를 별칭으로", () => {
    expect(receive(`[여기로](https://www.notion.so/${PAGE}#${H2})`)).toBe(
      "[[앵커#둘째 제목|여기로]]",
    );
  });

  it("표 칸에서는 별칭 구분자가 `\\|`", () => {
    expect(receive(`| [여기로](https://www.notion.so/${PAGE}#${H2}) | z |`)).toBe(
      "| [[앵커#둘째 제목\\|여기로]] | z |",
    );
  });

  it("앵커가 없는 블록 · 볼트에 없는 페이지는 Notion 링크로 둔다", () => {
    const plain = "e".repeat(32);
    const other = "f".repeat(32);
    const md = `[가](https://app.notion.com/p/${PAGE}#${plain}) [나](https://app.notion.com/p/${other}#${H1})`;
    expect(resolveNotionBlockLinks(md, pathOf, () => null, SELF).markdown).toBe(md);
  });

  it("읽을 블록은 볼트에 있는 페이지로 가는 것만", () => {
    const md = `[가](https://app.notion.com/p/${PAGE}#${H1}) [나](https://app.notion.com/p/${"f".repeat(32)}#${H2})`;
    expect(notionBlockLinkIds(md, pathOf)).toEqual([H1]);
  });
});
