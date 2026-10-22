/**
 * S-29 — 주석(`%%…%%` · `<!--…-->`)은 로컬에만 있는 글이다(F26). push 는 Obsidian 이 그리는 모양대로
 * 지우고, pull 은 받기 직전의 로컬 노트에서 그 자리에 되살린다.
 *
 * 예전에는 push 때 남긴 마커의 앵커 줄 다음 줄에 주석을 끼웠다. 문장 속 주석이 줄 밖으로 빠지고, 콜아웃 ·
 * 목록 속 주석이 `>` · 들여쓰기 없이 들어가 그 컨테이너를 끊었다. 콜아웃 속 주석 줄을 지우면 `>` 만 남아
 * Notion 에서 문단이 갈렸고, 인라인 코드 속 주석 표기(`` `<!-- 이렇게 -->` ``)까지 지웠다.
 */
import { describe, it, expect } from "vitest";
import { cutComments, findComments, restoreComments } from "../../src/converter/comments.js";
import type { CommentCut } from "../../src/converter/comments.js";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";

const pipeline = createDefaultPipeline();
const PUSH = { direction: "push", path: "markdown-api", filePath: "note.md" } as const;

/** push 가 Notion 에 보내는 글 — 본문 앞뒤의 공백은 Notion 블록에 남지 않는다. */
const sent = (note: string): string => pipeline.convertToNotion(note, PUSH).content.trim();
/** push 가 Notion 에 보내는 속성(frontmatter). */
const properties = (note: string) => pipeline.convertToNotion(note, PUSH).properties;

/** 지운 글에 지운 조각을 제자리에 다시 끼운다 — 지우기가 잃은 글이 없다는 증거. */
function rebuild(content: string, cuts: readonly CommentCut[]): string {
  let out = content;
  for (const cut of [...cuts].reverse()) out = out.slice(0, cut.at) + cut.text + out.slice(cut.at);
  return out;
}

describe("findComments — 주석 찾기", () => {
  const found = (content: string) =>
    findComments(content).map((comment) => content.slice(comment.start, comment.end));

  it("주석의 자리 · 글 · 문법", () => {
    expect(findComments("가 %%하나%% 나 <!-- 둘 -->")).toEqual([
      { start: 2, end: 8, text: "하나", style: "obsidian" },
      { start: 11, end: 21, text: " 둘 ", style: "html" },
    ]);
  });

  it("인라인 코드 속 주석 표기는 글자다 — 실볼트 Blog.md 의 표기 설명", () => {
    expect(found("앞 `<!-- x -->` 뒤 %%y%%")).toEqual(["%%y%%"]);
    expect(found("`%%a` b%%")).toEqual([]);
  });

  it("먼저 연 주석 속 백틱은 주석의 글이다", () => {
    expect(found("앞 <!-- `a --> 뒤 `코드`")).toEqual(["<!-- `a -->"]);
    expect(found("%%a `b%% c`")).toEqual(["%%a `b%%"]);
  });

  it("코드 펜스 속은 찾지 않는다 — 콜아웃 속 펜스도", () => {
    expect(found("```\n%%코드%%\n```\n\n> ```\n> <!-- 코드 -->\n> ```\n\n%%밖%%")).toEqual([
      "%%밖%%",
    ]);
  });

  it("브랜드 마커 · 닫는 토큰은 주석이 아니다", () => {
    expect(found("%%im-nobsidian:color:red%%글%%/color%%")).toEqual([]);
    expect(found("%%/color%% %%im-nobsidian:x%%")).toEqual([]);
  });

  it("홑 %% 는 마커의 %% 와 짝짓지 않는다 (D-COMMENT-PAIR)", () => {
    expect(found("100%% 와 %%im-nobsidian:color:yellow_bg%%형광펜%%/color%%")).toEqual([]);
  });

  it("HTML 주석은 마커를 품는다 — Obsidian 은 그 안을 통째로 그리지 않는다", () => {
    expect(found("<!-- %%im-nobsidian:x%% -->")).toEqual(["<!-- %%im-nobsidian:x%% -->"]);
  });

  it("닫히지 않은 주석은 주석이 아니다", () => {
    expect(found("앞 <!-- 닫히지 않음")).toEqual([]);
    expect(found("%%열린 주석")).toEqual([]);
  });
});

/** [이름, 노트, 지운 글, 지운 조각([글, 붙은 쪽 — 줄 속이면 inline])] */
const CUTS: Array<[string, string, string, Array<[string, string]>]> = [
  [
    "제 문단의 주석 — 빈 줄 하나와 함께",
    "첫.\n\n%%메모%%\n\n둘.",
    "첫.\n\n둘.",
    [["%%메모%%\n\n", "before"]],
  ],
  ["앞 줄에 붙은 주석 줄", "첫.\n%%메모%%\n\n둘.", "첫.\n\n둘.", [["\n%%메모%%", "after"]]],
  ["뒤 줄에 붙은 주석 줄", "앞.\n\n%%메모%%\n뒤.", "앞.\n\n뒤.", [["%%메모%%\n", "before"]]],
  [
    "줄 속 주석 — 옆 공백 하나와 함께",
    "첫 문단 %%메모%% 이어서.",
    "첫 문단 이어서.",
    [["%%메모%% ", "inline"]],
  ],
  ["줄 끝 주석", "문장 끝 %%메모%%\n다음 줄", "문장 끝\n다음 줄", [[" %%메모%%", "inline"]]],
  ["줄 머리 주석", "%%메모%% 문장", "문장", [["%%메모%% ", "inline"]]],
  [
    "공백으로만 떨어진 주석들은 한 번에",
    "가 %%a%% %%b%% 나",
    "가 나",
    [["%%a%% %%b%% ", "inline"]],
  ],
  ["글자에 붙은 주석", "가%%a%%나", "가나", [["%%a%%", "inline"]]],
  [
    "콜아웃 속 주석 줄 — `>` 를 남기지 않는다",
    "> [!note] 제목\n> 본문.\n> %%메모%%\n> 끝.",
    "> [!note] 제목\n> 본문.\n> 끝.",
    [["\n> %%메모%%", "after"]],
  ],
  [
    "콜아웃 속 문단 사이의 주석 — 콜아웃의 빈 줄 하나와 함께",
    "> 본문.\n>\n> %%메모%%\n>\n> 끝.",
    "> 본문.\n>\n> 끝.",
    [["> %%메모%%\n>\n", "before"]],
  ],
  [
    "콜아웃 끝의 주석 — 콜아웃의 빈 줄과 함께",
    "> [!note] 제목\n> 본문.\n>\n> %%메모%%\n\n다음 문단.",
    "> [!note] 제목\n> 본문.\n\n다음 문단.",
    [["\n>\n> %%메모%%", "after"]],
  ],
  [
    "목록 자식 주석 줄",
    "- 항목\n  %%메모%%\n- 다음",
    "- 항목\n- 다음",
    [["\n  %%메모%%", "after"]],
  ],
  [
    "빈 줄만 사이에 둔 주석 줄들은 한 번에",
    "앞.\n\n%%a%%\n\n%%b%%\n\n뒤.",
    "앞.\n\n뒤.",
    [["%%a%%\n\n%%b%%\n\n", "before"]],
  ],
  [
    "앞 줄에 붙은 주석 줄은 따로 — 함께 지우면 위아래 문단이 붙는다",
    "앞.\n%%a%%\n\n%%b%%\n뒤.",
    "앞.\n\n뒤.",
    [
      ["\n%%a%%", "after"],
      ["%%b%%\n", "before"],
    ],
  ],
  ["글 끝의 주석들", "앞.\n\n%%a%%\n\n%%b%%", "앞.", [["\n\n%%a%%\n\n%%b%%", "after"]]],
  ["글 머리의 주석들", "%%a%%\n\n%%b%%\n뒤.", "뒤.", [["%%a%%\n\n%%b%%\n", "before"]]],
  ["본문 전체가 주석", "%%전부%%", "", [["%%전부%%", "before"]]],
  [
    "여러 줄 주석 — 속의 빈 줄까지",
    "앞.\n\n<!--\na\n\nb\n-->\n\n뒤.",
    "앞.\n\n뒤.",
    [["<!--\na\n\nb\n-->\n\n", "before"]],
  ],
  [
    "글이 있는 줄에 걸친 여러 줄 주석은 줄 속 주석이다",
    "앞 <!-- 여러\n줄 --> 뒤",
    "앞 뒤",
    [["<!-- 여러\n줄 --> ", "inline"]],
  ],
  [
    "마커 줄의 주석 — 마커는 남는다",
    "%%im-nobsidian:toggle:start%% %%메모%%",
    "%%im-nobsidian:toggle:start%%",
    [[" %%메모%%", "inline"]],
  ],
  [
    "CRLF 노트",
    "앞.\r\n\r\n%%메모%%\r\n\r\n뒤.",
    "앞.\r\n\r\n뒤.",
    [["%%메모%%\r\n\r\n", "before"]],
  ],
  [
    "목록 표시 뒤의 주석은 줄 속 주석 — Obsidian 처럼 빈 항목이 남는다",
    "- %%x%%\n- 둘",
    "-\n- 둘",
    [[" %%x%%", "inline"]],
  ],
];

describe("cutComments — Obsidian 이 그리는 모양대로 지운다", () => {
  it.each(CUTS)("%s", (_name, note, content, cuts) => {
    const result = cutComments(note);

    expect(result.content).toBe(content);
    expect(result.cuts.map((cut) => [cut.text, cut.attach ?? "inline"])).toEqual(cuts);
    expect(rebuild(result.content, result.cuts)).toBe(note);
  });

  it("주석이 없으면 그대로", () => {
    expect(cutComments("앞 `%%코드%%` 뒤\n\n100%% 완료")).toEqual({
      content: "앞 `%%코드%%` 뒤\n\n100%% 완료",
      cuts: [],
    });
  });

  it("지운 조각마다 그 안의 주석과, 주석만 모은 글(block)", () => {
    const { cuts } = cutComments("앞.\n\n%%a%%\n\n<!-- b -->\n\n뒤. %%c%% %%d%% 끝");

    expect(cuts.map((cut) => [cut.block, cut.comments.map((comment) => comment.text)])).toEqual([
      ["%%a%%\n<!-- b -->", ["a", " b "]],
      ["%%c%% %%d%%", ["c", "d"]],
    ]);
  });
});

describe("restoreComments — 받기 직전의 로컬 노트에서 주석을 되살린다", () => {
  it.each(CUTS)("받은 글이 지운 글과 같으면 로컬 노트 그대로 — %s", (_name, note) => {
    expect(restoreComments(cutComments(note).content, note)).toBe(note);
  });

  it("로컬 노트에 주석이 없으면 받은 글 그대로", () => {
    expect(restoreComments("앞.\n\n뒤 고침.", "앞.\n\n뒤.")).toBe("앞.\n\n뒤 고침.");
  });

  /** [이름, 로컬 노트, 받은 글, 되살린 글] */
  const REMOTE: Array<[string, string, string, string]> = [
    [
      "원격에서 앞에 문단을 더했다",
      "첫.\n\n%%메모%%\n\n둘.",
      "새 문단.\n\n첫.\n\n둘.",
      "새 문단.\n\n첫.\n\n%%메모%%\n\n둘.",
    ],
    [
      "원격에서 주석이 있는 줄을 고쳤다 — 고친 줄의 같은 글 뒤에",
      "첫 문단 %%메모%% 이어서.\n\n둘.",
      "첫 문단 고침 이어서.\n\n둘.",
      "첫 문단 %%메모%% 고침 이어서.\n\n둘.",
    ],
    [
      "원격에서 주석이 있는 줄을 지웠다 — 주석만 그 자리에 줄로",
      "첫 %%메모%% 줄.\n\n둘.",
      "둘.",
      "%%메모%%\n둘.",
    ],
    [
      "원격에서 주석 뒤 문단을 지웠다",
      "앞.\n\n%%메모%%\n\n지운 문단.\n\n뒤.",
      "앞.\n\n뒤.",
      "앞.\n\n%%메모%%\n\n뒤.",
    ],
    [
      "주석 줄이 붙은 줄을 원격에서 고쳤다 — 붙은 채로",
      "첫 줄.\n%%메모%%\n\n둘.",
      "첫 줄 고침.\n\n둘.",
      "첫 줄 고침.\n%%메모%%\n\n둘.",
    ],
    [
      "콜아웃 속 주석 줄 — 원격에서 앞 줄을 고쳐도 `>` 와 함께",
      "> [!note] 제목\n> 본문 줄입니다.\n> %%콜아웃 메모%%\n> 끝 줄입니다.",
      "> [!note] 제목\n> 본문 줄 고침.\n> 끝 줄입니다.",
      "> [!note] 제목\n> 본문 줄 고침.\n> %%콜아웃 메모%%\n> 끝 줄입니다.",
    ],
    [
      "목록 항목 속 주석 — 원격에서 항목을 고치고 더해도",
      "- 하나\n- 항목 %%메모%% 둘\n- 셋",
      "- 하나\n- 항목 둘 고침\n- 셋\n- 넷",
      "- 하나\n- 항목 %%메모%% 둘 고침\n- 셋\n- 넷",
    ],
    [
      "글 끝의 주석 — 끝 줄바꿈은 받은 글을 따른다",
      "첫 문단입니다.\n\n%%끝 메모%%\n",
      "첫 문단입니다.",
      "첫 문단입니다.\n\n%%끝 메모%%",
    ],
    ["간격만 다르게 받았다", "첫.\n%%메모%%\n둘.", "첫.\n\n둘.", "첫.\n%%메모%%\n\n둘."],
    [
      "CRLF 노트는 LF 로 받는다",
      "앞.\r\n\r\n%%메모%%\r\n\r\n뒤.\r\n",
      "앞.\n\n뒤.\n",
      "앞.\n\n%%메모%%\n\n뒤.\n",
    ],
    [
      "frontmatter 가 바뀌어도 본문의 주석은 제자리",
      "---\ntitle: a\n---\n\n앞 %%메모%% 줄.\n",
      "---\ntitle: b\n---\n\n앞 줄.\n",
      "---\ntitle: b\n---\n\n앞 %%메모%% 줄.\n",
    ],
    [
      "frontmatter 가 깨진 노트 — push 처럼 글 전체를 본문으로 본다",
      "---\na: [\n---\n%%메모%%\n본문",
      "---\na: [\n---\n본문 고침",
      "---\na: [\n---\n%%메모%%\n본문 고침",
    ],
    [
      "받은 글에서 주석 자리가 코드 속이면 코드 뒤에 둔다 — 코드 속이면 주석이 코드 글자로 올라간다",
      "앞 문단 %%메모%%\n\n뒤.",
      "```\n앞 문단\n```\n\n뒤.",
      "```\n앞 문단\n```\n%%메모%%\n\n뒤.",
    ],
    [
      "한 자리를 이웃에 맞춰야 해도 다른 자리는 지운 글 그대로 — Notion 은 콜아웃 속 빈 `>` 줄을 내보내지 않는다",
      "> [!tip] 콜아웃\n> 첫 줄.\n>\n> %%메모 하나%%\n>\n> 끝 줄.\n\n앞 문단 %%메모 둘%% 이어서.",
      "> [!tip] 콜아웃\n> 첫 줄.\n> 끝 줄.\n\n앞 문단 고쳐서 이어서.",
      "> [!tip] 콜아웃\n> 첫 줄.\n> %%메모 하나%%\n> 끝 줄.\n\n앞 문단 %%메모 둘%% 고쳐서 이어서.",
    ],
    [
      "원격에서 본문을 모두 지웠다 — 받은 글이 끝 줄바꿈 없이 frontmatter 로 끝나도 주석은 그 뒤에",
      "---\ntitle: 노트\n---\n## 제목\n%%하나%%\n\n문단 %%둘%% 글.",
      "---\ntitle: 노트\n---",
      "---\ntitle: 노트\n---\n%%하나%%\n%%둘%%",
    ],
    [
      "본문이 주석뿐인 노트 — 받은 글이 끝 줄바꿈 없이 frontmatter 로 끝나도 주석은 그 뒤에",
      "---\ntitle: 노트\n---\n%%하나%%",
      "---\ntitle: 노트\n---",
      "---\ntitle: 노트\n---\n%%하나%%",
    ],
    [
      "닫히지 않은 코드 뒤로도 둘 수 없으면 본문 머리에 둔다 — 주석은 버리지 않는다",
      "앞.\n\n%%메모%%\n\n뒤.",
      "앞.\n\n```\n뒤.",
      "%%메모%%\n앞.\n\n```\n뒤.",
    ],
  ];

  it.each(REMOTE)("%s", (_name, local, pulled, restored) => {
    expect(restoreComments(pulled, local)).toBe(restored);
    // 되살린 글을 다시 올려도 Notion 에 가는 글 · 속성은 받은 글과 같다.
    expect(sent(restored)).toBe(sent(pulled));
    expect(properties(restored)).toEqual(properties(pulled));
  });
});

/** 같은 씨앗이면 같은 수열 — 실패한 경우를 다시 돌릴 수 있다. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/** 주석 · 콜아웃 · 목록 · 코드가 섞인 노트. */
function randomNote(random: () => number): string {
  let id = 0;
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const number = () => Math.floor(random() * 99);
  const comment = () => (random() < 0.8 ? `%%c${++id}%%` : `<!-- h${++id} -->`);
  const blocks: Array<() => string[]> = [
    () => [random() < 0.3 ? `문단 ${comment()} 글.` : `문단 글 ${number()}.`],
    () => [`## 제목 ${number()}`],
    () => [comment()],
    () => [
      `- 항목 ${number()}`,
      random() < 0.5 ? `- 항목 ${comment()} 끝` : `  - 하위 ${number()}`,
    ],
    () => [
      "> [!note] 콜아웃",
      random() < 0.4 ? `> ${comment()}` : `> 줄 ${number()}`,
      `> 줄 ${number()}`,
    ],
    () => [`> 바깥 ${number()}`, random() < 0.5 ? `> > ${comment()}` : `> > 안쪽 ${number()}`],
    () => ["```js", `// %%코드 속%% ${number()}`, "```"],
    () => [`글 \`%%코드%%\` ${random() < 0.5 ? comment() : "끝"}`],
    () => [`문단 ${number()}`, random() < 0.5 ? comment() : `이어짐 ${number()}`],
  ];
  const parts = Array.from({ length: 2 + Math.floor(random() * 6) }, () =>
    pick(blocks)().join("\n"),
  );
  // 본문이 주석뿐인 노트도 — 지운 뒤 본문이 빈다.
  const body =
    random() < 0.03
      ? comment()
      : parts.reduce((note, part) => note + (random() < 0.8 ? "\n\n" : "\n") + part);
  const head = random() < 0.2 ? "---\ntitle: 노트\n---\n" : "";
  return head + body + (random() < 0.5 ? "\n" : "");
}

/**
 * 원격 편집 하나 — 줄을 더하거나 지우거나 고친다. Notion 의 코드 블록은 한 덩어리라 펜스 줄만 고치거나
 * 지우지 않는다.
 */
function remoteEdit(random: () => number, pulled: string): string {
  const head = /^---\n[\s\S]*?\n---\n/.exec(pulled)?.[0] ?? "";
  // 본문을 모두 지운다 — 받은 글은 끝 줄바꿈 없이 frontmatter 로 끝날 수 있다.
  if (random() < 0.03) return random() < 0.5 ? head.trimEnd() : head;
  const lines = pulled.slice(head.length).split("\n");
  const at = Math.min(Math.floor(random() * lines.length), lines.length - 1);
  const kind = random();
  if (kind < 0.25) lines.splice(at, 0, "", `새 문단 ${Math.floor(random() * 99)}.`);
  else if (lines[at]!.startsWith("```")) return pulled;
  else if (kind < 0.45) lines.splice(at, 1);
  else if (kind < 0.7) lines[at] = `${lines[at]} 고침`;
  else if (kind < 0.85) lines[at] = `고친 ${lines[at]}`;
  else if (lines[at] === "") lines.splice(at, 1);
  else lines.splice(at, 0, "");
  return head + lines.join("\n");
}

describe("restoreComments — 원격 편집을 무작위로 겹쳐도", () => {
  it("되살린 글을 다시 올리면 받은 글과 같은 것을 보내고, 로컬의 주석을 하나도 잃지 않는다", () => {
    const random = seeded(29);
    const count = (text: string, part: string) => text.split(part).length - 1;
    for (let n = 0; n < 1000; n++) {
      const local = randomNote(random);
      const head = /^---\n[\s\S]*?\n---\n/.exec(local)?.[0] ?? "";
      let pulled = head + cutComments(local.slice(head.length).trim()).content;
      const edits = Math.floor(random() * 4);
      for (let e = 0; e < edits; e++) pulled = remoteEdit(random, pulled);

      const restored = restoreComments(pulled, local);
      const label = JSON.stringify({ local, pulled, restored });

      expect(sent(restored), label).toBe(sent(pulled));
      // frontmatter 안에 주석을 끼우면 속성이 깨진다.
      expect(properties(restored), label).toEqual(properties(pulled));
      for (const comment of findComments(local)) {
        const text = local.slice(comment.start, comment.end);
        expect(count(restored, text), label).toBeGreaterThanOrEqual(count(local, text));
      }
    }
  });
});
