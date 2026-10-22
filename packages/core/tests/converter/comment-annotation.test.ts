/**
 * S-31 — 서식 보존(`InlineAnnotationPreserver`)이 frontmatter 분리 · 주석 제거보다 먼저 돌던 결함.
 *
 * 서식 마커는 `%%` 로 쓰인다(`%%im-nobsidian:color:yellow_bg%%…%%/color%%`). 주석 속 `==강조==` · `<u>` 를
 * 먼저 마커로 바꾸면 주석의 `%%` 가 마커를 넘어 짝짓지 않아(D-COMMENT-PAIR) 주석이 통째로 — 메모 글까지 —
 * Notion 에 올라갔다. YAML 값 속 `==` · `<u>` 도 마커 글자로 바뀌어 페이지 제목 · 속성 · 속성 표에 실렸다.
 */
import { describe, it, expect } from "vitest";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";
import { InlineAnnotationPreserver } from "../../src/converter/pre-processors/html-annotation.js";
import { FrontmatterExtractor } from "../../src/converter/pre-processors/frontmatter.js";
import { CommentStripper } from "../../src/converter/pre-processors/comment-stripper.js";
import { PropertiesTableInjector } from "../../src/converter/pre-processors/properties-table.js";

const PUSH = { direction: "push", path: "markdown-api", filePath: "note.md" } as const;
const PULL = { ...PUSH, direction: "pull" } as const;

const push = (note: string) => createDefaultPipeline().convertToNotion(note, PUSH);
/** push 가 Notion 에 보내는 글(Markdown API 의 enhanced markdown). */
const sent = (note: string): string => obsidianToNotionEnhanced(push(note).content);

describe("서식 보존의 차례", () => {
  it("frontmatter 분리 · 주석 제거 뒤, 속성 표를 끼우기 전", () => {
    const order = new InlineAnnotationPreserver().order;
    expect(order).toBeGreaterThan(new FrontmatterExtractor().order);
    expect(order).toBeGreaterThan(new CommentStripper().order);
    expect(order).toBeLessThan(new PropertiesTableInjector().order);
  });
});

describe("주석 속 서식 — 주석째 Notion 에 올라가지 않는다", () => {
  /** [배치, 노트, Obsidian 이 그리는 글 — 주석이 없던 것처럼] */
  const CASES: Array<[string, string, string]> = [
    ["문장 속 주석의 하이라이트", "앞 %%메모 ==강조== 끝%% 뒤", "앞 뒤"],
    ["하이라이트뿐인 주석 줄", "%%==강조만==%%\n\n다음 문단", "다음 문단"],
    [
      "콜아웃 속 주석의 하이라이트",
      "> [!note] 제목\n> %%콜아웃 ==강조== 메모%%\n> 끝",
      "> [!note] 제목\n> 끝",
    ],
    ["여러 줄 주석의 하이라이트 · 밑줄", "%%\n여러 줄 ==강조==\n<u>밑줄</u>\n%%\n\n다음", "다음"],
    ["HTML 주석 속 밑줄", "앞 <!-- <u>밑줄</u> 메모 --> 뒤", "앞 뒤"],
  ];

  it.each(CASES)("%s", (_name, note, shown) => {
    const out = sent(note);
    expect(out).toBe(sent(shown));
    expect(out).not.toMatch(/메모|강조|밑줄|%%/);
  });

  it.each(CASES)("%s — 받으면 로컬 노트 그대로", (_name, note) => {
    const pulled = createDefaultPipeline().convertToMarkdown(
      notionEnhancedToObsidian(sent(note)),
      PULL,
      { localContent: note },
    );
    expect(pulled).toBe(note);
  });

  it("하이라이트 속 주석은 주석만 지우고 하이라이트는 남는다", () => {
    expect(sent("앞 ==강조 %%속 메모%% 계속== 뒤")).toBe(
      '앞 <span color="yellow_bg">강조 계속</span> 뒤',
    );
  });

  it("로컬 노트가 없으면 마커의 앵커로 그 줄 다음에 끼운다 — 하이라이트 줄에서도", () => {
    // 예전에는 앵커가 마커 글자(`m-nobsidian:color:yellow_bg%%강조 `)라 받은 글에서 찾지 못해 글 끝에 끼웠다.
    const note = "앞 ==강조 %%속 메모%% 계속== 뒤\n\n다음 문단";
    const result = push(note);
    const pulled = createDefaultPipeline().convertToMarkdown(
      notionEnhancedToObsidian(obsidianToNotionEnhanced(result.content)),
      PULL,
      { preserveMarkers: result.preserveMarkers },
    );
    expect(pulled).toBe("앞 ==강조 계속== 뒤\n%%속 메모%%\n\n다음 문단");
  });

  it("주석 밖의 서식은 그대로 서식으로 간다", () => {
    expect(sent("==강조== %%메모%% <u>밑줄</u>")).toBe(
      '<span color="yellow_bg">강조</span> <span underline="true">밑줄</span>',
    );
  });
});

describe("frontmatter 값 속 `==` · `<u>` — 적은 글 그대로 속성에 실린다", () => {
  const NOTE = [
    "---",
    "title: a ==b== c",
    'summary: "<u>밑줄</u> 요약"',
    'note: "x == y == z"',
    "---",
    "본문 ==강조==",
  ].join("\n");

  it("페이지 제목 · 속성은 적은 글 그대로다", () => {
    expect(push(NOTE).properties).toEqual({
      title: "a ==b== c",
      summary: "<u>밑줄</u> 요약",
      note: "x == y == z",
    });
  });

  it("속성 표에 마커 글자가 실리지 않고, 본문의 하이라이트는 서식으로 간다", () => {
    const out = sent(NOTE);
    expect(out).not.toContain("im-nobsidian:color");
    expect(out).not.toContain("im-nobsidian:underline");
    expect(out).toContain("title: a ==b== c");
    expect(out).toContain('본문 <span color="yellow_bg">강조</span>');
  });
});
