/**
 * S-29 — 주석 왕복을 변환 파이프라인 끝까지 돌린다. push 는 주석을 Obsidian 이 그리는 모양대로 지우고
 * (`CommentStripper`), pull 은 받기 직전의 로컬 노트에서 되살린다(`CommentRestorer`).
 *
 * 배치는 실볼트에서 주석이 놓이는 모양이다. 예전에는 문장 속 주석이 줄 밖으로 빠지고, 콜아웃 속 주석이
 * `>` 없이 들어가 콜아웃을 끊었고, 콜아웃 속 주석 줄을 지운 자리의 `>` 가 Notion 에서 문단을 갈랐다.
 */
import { describe, it, expect } from "vitest";
import { CommentRestorer } from "../../src/converter/post-processors/comment-restorer.js";
import { BlockSpacer } from "../../src/converter/post-processors/block-spacer.js";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";
import { sentForm } from "../../src/converter/sent-form.js";
import { mapOutsideCodeFences } from "../../src/utils/md-regions.js";
import type { ProcessorInput } from "../../src/types/convert.js";
import { roundtrip } from "./roundtrip-fidelity.js";

const PUSH = { direction: "push", path: "markdown-api", filePath: "note.md" } as const;
const PULL = { ...PUSH, direction: "pull" } as const;

/** [배치, 노트, Obsidian 이 그리는 글 — 주석이 없던 것처럼] */
const LAYOUTS: Array<[string, string, string]> = [
  [
    "제 문단",
    "첫 문단입니다.\n\n%%메모%%\n\n둘째 문단입니다.",
    "첫 문단입니다.\n\n둘째 문단입니다.",
  ],
  [
    "앞 문단에 붙은 줄",
    "첫 문단입니다.\n%%메모%%\n\n둘째 문단입니다.",
    "첫 문단입니다.\n\n둘째 문단입니다.",
  ],
  [
    "문장 속",
    "첫 문단 %%메모%% 이어서.\n\n둘째 문단입니다.",
    "첫 문단 이어서.\n\n둘째 문단입니다.",
  ],
  ["글 머리", "%%맨 앞 메모%%\n\n첫 문단입니다.", "첫 문단입니다."],
  [
    "문장 속과 제 문단",
    "첫 문단 %%하나%% 이어서.\n\n%%둘%%\n\n둘째 문단입니다.",
    "첫 문단 이어서.\n\n둘째 문단입니다.",
  ],
  [
    "여러 줄 HTML 주석",
    "첫 문단입니다.\n\n<!--\n여러 줄\n주석\n-->\n\n둘째 문단입니다.",
    "첫 문단입니다.\n\n둘째 문단입니다.",
  ],
  [
    "콜아웃 속 줄",
    "> [!note] 제목\n> 본문 줄입니다.\n> %%콜아웃 메모%%\n> 끝 줄입니다.",
    "> [!note] 제목\n> 본문 줄입니다.\n> 끝 줄입니다.",
  ],
  [
    "콜아웃 속 문단",
    "> [!note] 제목\n> 본문 줄입니다.\n>\n> %%콜아웃 메모%%\n>\n> 끝 줄입니다.",
    "> [!note] 제목\n> 본문 줄입니다.\n>\n> 끝 줄입니다.",
  ],
  [
    "목록 항목 속",
    "- 항목 하나입니다\n- 항목 %%메모%% 둘\n- 셋째 항목입니다",
    "- 항목 하나입니다\n- 항목 둘\n- 셋째 항목입니다",
  ],
  ["글 끝", "첫 문단입니다.\n\n%%끝 메모%%", "첫 문단입니다."],
];

/** push 가 Notion 에 보내는 글(Markdown API 의 enhanced markdown). */
function sent(note: string): string {
  return obsidianToNotionEnhanced(createDefaultPipeline().convertToNotion(note, PUSH).content);
}

/** Notion 이 보낸 글을 pull 처럼 받는다 — 받기 직전의 로컬 노트와 함께. */
function pull(enhanced: string, local: string | undefined, compact = false): string {
  return createDefaultPipeline().convertToMarkdown(notionEnhancedToObsidian(enhanced), PULL, {
    ...(local === undefined ? {} : { localContent: local }),
    notionExportCompact: compact,
  });
}

/** Notion 의 압축형 export — 코드 밖 빈 줄이 없다(BlockSpacer 실측 주석). */
const compact = (enhanced: string) =>
  mapOutsideCodeFences(enhanced, (segment) => segment.replace(/\n{2,}/g, "\n"));

describe("CommentRestorer — 처리기 계약", () => {
  const restorer = new CommentRestorer();
  const run = (input: Partial<ProcessorInput> & Pick<ProcessorInput, "content">) =>
    restorer.process({ metadata: {}, context: PULL, ...input }).content;

  it("간격 정규화(BlockSpacer) 뒤에 돈다 — 그래야 받은 글의 줄이 로컬 노트의 줄과 맞는다", () => {
    expect(restorer.order).toBeGreaterThan(new BlockSpacer().order);
  });

  it("pull 에서 로컬 노트의 주석을 되살린다", () => {
    expect(run({ content: "앞 뒤", metadata: { localContent: "앞 %%메모%% 뒤" } })).toBe(
      "앞 %%메모%% 뒤",
    );
  });

  it("로컬 노트가 없으면(새 페이지 · 지운 노트) 받은 글 그대로", () => {
    expect(run({ content: "앞 뒤" })).toBe("앞 뒤");
  });

  it("push 에서는 무동작", () => {
    expect(
      run({ content: "앞 뒤", metadata: { localContent: "앞 %%메모%% 뒤" }, context: PUSH }),
    ).toBe("앞 뒤");
  });
});

describe("주석 왕복 — 배치마다 (S-29)", () => {
  it.each(LAYOUTS)("%s — Notion 에는 주석이 없던 것처럼 간다", (_name, note, shown) => {
    expect(sent(note)).toBe(sent(shown));
  });

  it.each(LAYOUTS)("%s — 받으면 노트 그대로", (_name, note) => {
    const result = roundtrip(note);
    expect(result.outputBody).toBe(result.inputBody);
    expect(pull(sent(note), note)).toBe(note);
  });

  it.each(LAYOUTS)("%s — 압축형 export 로 받아도 노트 그대로", (_name, note) => {
    expect(pull(compact(sent(note)), note, true)).toBe(note);
  });

  it("압축형 export 는 콜아웃 속 문단의 경계를 내보내지 않는다 — 로컬 노트가 있으면 그 경계대로 둔다(F-06 · S-30)", () => {
    const [, note, shown] = LAYOUTS.find(([name]) => name === "콜아웃 속 문단")!;
    // 받기 직전의 로컬 노트가 없으면(새 페이지) 경계를 모른다.
    expect(pull(compact(sent(shown)), undefined, true)).toBe(
      "> [!note] 제목\n> 본문 줄입니다.\n> 끝 줄입니다.",
    );
    // Notion 은 콜아웃 속 빈 줄을 읽지 않는다 — 경계가 있으나 없으나 같은 블록이라 로컬 노트의 경계를 둔다.
    expect(pull(compact(sent(shown)), shown, true)).toBe(shown);
    expect(pull(compact(sent(note)), note, true)).toBe(note);
  });

  // 실측(2026-10-04, 프로브 `…9bb7`) — 아래 노트를 push 하고 Notion 에서 C · E 의 줄을 고치고, G 의 둘째 항목을
  // 지우고, 마지막 문단을 고친 뒤 Markdown API 가 내보낸 글. 빈 줄 없이(압축형) 내보낸다.
  it("실측 — Notion 에서 고친 뒤 받아도 주석은 제자리다", () => {
    const local = [
      "S-29 왕복 시험 — 주석 배치",
      "",
      "C 문장 속 %%문장 속 메모%% 주석입니다.",
      "",
      "E 콜아웃 속 줄:",
      "",
      "> [!note] 콜아웃 제목",
      "> 콜아웃 본문 줄입니다.",
      "> %%콜아웃 메모%%",
      "> 콜아웃 끝 줄입니다.",
      "",
      "F 콜아웃 속 문단:",
      "",
      "> [!tip] 문단 콜아웃",
      "> 첫 문단 줄입니다.",
      ">",
      "> %%콜아웃 문단 메모%%",
      ">",
      "> 끝 문단 줄입니다.",
      "",
      "G 목록 항목 속:",
      "",
      "- 항목 하나입니다",
      "- 항목 %%목록 메모%% 둘",
      "- 셋째 항목입니다",
      "",
      "마지막 문단 — Notion 에서 고칠 자리.",
      "",
      "%%글 끝 메모%%",
    ].join("\n");
    const exported = [
      "S-29 왕복 시험 — 주석 배치",
      "C 문장 속 고친 주석입니다.",
      "E 콜아웃 속 줄:",
      '<callout icon="📝">',
      "\t콜아웃 제목",
      "\t콜아웃 본문 줄 고침.",
      "\t콜아웃 끝 줄입니다.",
      "</callout>",
      "F 콜아웃 속 문단:",
      '<callout icon="💡">',
      "\t문단 콜아웃",
      "\t첫 문단 줄입니다.",
      "\t끝 문단 줄입니다.",
      "</callout>",
      "G 목록 항목 속:",
      "- 항목 하나입니다",
      "- 셋째 항목입니다",
      "마지막 문단 — Notion 에서 고침.",
    ].join("\n");

    const pulled = pull(exported, local, true);

    expect(pulled).toBe(
      local
        .replace(
          "C 문장 속 %%문장 속 메모%% 주석입니다.",
          "C 문장 속 %%문장 속 메모%% 고친 주석입니다.",
        )
        .replace("> 콜아웃 본문 줄입니다.", "> 콜아웃 본문 줄 고침.")
        .replace("- 항목 %%목록 메모%% 둘", "%%목록 메모%%")
        .replace("마지막 문단 — Notion 에서 고칠 자리.", "마지막 문단 — Notion 에서 고침."),
    );
    // 되살린 노트를 다시 올려도 Notion 의 블록은 받은 것 그대로다 — 콜아웃 속 문단 경계(빈 줄)는 Notion 이
    // 읽지 않는다(`sentForm`).
    const pipeline = createDefaultPipeline();
    expect(sentForm(pipeline, pulled, PULL)).toBe(
      sentForm(pipeline, pull(exported, undefined, true), PULL),
    );
  });

  it("로컬 노트가 없으면 push 때 남긴 마커로 앵커 줄 다음에 끼운다", () => {
    const note = "첫 문단입니다.\n\n%%메모%%\n\n둘째 문단입니다.";
    const pipeline = createDefaultPipeline();
    const push = pipeline.convertToNotion(note, PUSH);

    const pulled = pipeline.convertToMarkdown(push.content, PULL, {
      preserveMarkers: push.preserveMarkers,
    });

    expect(pulled).toContain("첫 문단입니다.\n%%메모%%");
  });
});
