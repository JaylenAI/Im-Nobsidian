/**
 * F-06 · S-30 — 받은 글이 로컬 노트의 표기를 정준형으로 바꾸던 결함.
 *
 * Notion 에 자리가 없는 표기 — 콜아웃 접힘(`+` · `-`) · 종류 별칭, `<details>` · `<mark>`, frontmatter 의
 * 목록 모양, 빈 줄 배치, 끝 줄바꿈 — 는 받으면 정준형으로 돌아왔다. Notion 에서 한 줄만 고쳐도 pull 이 노트
 * 전체를 다시 쓰고 접어 둔 콜아웃을 모두 펼쳤다(2026-10-04 실측, `__f06_ofm__`). 이제 받은 글에서 push 가
 * 같은 꼴로 보내는 자리는 받기 직전의 로컬 노트 표기로 되살린다.
 *
 * Notion 이 내보낸 글은 실측 모양이다 — 블록 사이에 빈 줄이 없고, 콜아웃 · 토글 본문은 탭 들여쓰기, 페이지
 * 속성 코드 블록의 날짜는 시각까지 적힌다.
 */
import { describe, it, expect, vi, afterEach, onTestFinished } from "vitest";
import { restoreLocalForm } from "../../src/converter/local-form.js";
import { LocalFormRestorer } from "../../src/converter/post-processors/local-form-restorer.js";
import { sentForm } from "../../src/converter/sent-form.js";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";
import { notionEnhancedToObsidian } from "../../src/converter/enhanced-md-converter.js";
import { isCompactExport } from "../../src/converter/post-processors/block-spacer.js";
import { getLogger, setLogger } from "../../src/utils/logger.js";

const pipeline = createDefaultPipeline();
const PULL = {
  direction: "pull",
  path: "markdown-api",
  filePath: "a.md",
  parentMode: "page",
} as const;

/** Notion 이 내보낸 글을 받는다 — `local` 은 받기 직전의 로컬 노트. 압축형 판정은 page-puller 처럼 원시 글로. */
const pull = (exported: string, local?: string): string =>
  pipeline.convertToMarkdown(notionEnhancedToObsidian(exported), PULL, {
    notionExportCompact: isCompactExport(exported),
    ...(local === undefined ? {} : { localContent: local }),
  });
/** push 가 Notion 에 보낼 꼴 — 같으면 Notion 에서 같다. */
const sent = (note: string): string => sentForm(pipeline, note, PULL);

/** 페이지 노트의 속성 코드 블록 — Notion 이 내보낸 모양. */
const propertiesBlock = (tags: readonly string[]) =>
  [
    "```yaml",
    "# im-nobsidian:properties",
    "due: 2026-10-15T00:00:00.000Z",
    "tags:",
    ...tags.map((tag) => `  - ${tag}`),
    "```",
    "---",
  ].join("\n");

describe("pull — Notion 에 같은 모양으로 올라가는 자리는 로컬 표기로", () => {
  /** [표기, Notion 이 내보낸 글, 로컬 노트, 로컬 노트 없이 받은 글] */
  const FORMS: Array<[string, string, string, string]> = [
    [
      "콜아웃 접힘 · 종류 별칭",
      '<callout icon="❓">\n\t접힌 질문\n\t접힌 본문\n</callout>',
      "> [!faq]- 접힌 질문\n> 접힌 본문",
      "> [!question] 접힌 질문\n> 접힌 본문",
    ],
    [
      "펼친 콜아웃",
      '<callout icon="⚠️">\n\t펼친 경고\n\t펼친 본문\n</callout>',
      "> [!warning]+ 펼친 경고\n> 펼친 본문",
      "> [!warning] 펼친 경고\n> 펼친 본문",
    ],
    [
      "표에 없는 종류 — 아이콘 없이 올라간다",
      "<callout>\n\t사용자\n\t본문\n</callout>",
      "> [!custom] 사용자\n> 본문",
      "> [!note] 사용자 %%im-nobsidian:callout-style:%%\n> 본문",
    ],
    [
      "<mark> · Highlightr",
      '<span color="yellow_bg">마크</span> · <span color="yellow_bg">형광</span>',
      '<mark>마크</mark> · <mark style="background: #FFB86CA6;">형광</mark>',
      "==마크== · ==형광==",
    ],
    [
      "<details>",
      "<details>\n<summary>요약</summary>\n\t세부 내용\n</details>",
      "<details>\n<summary>요약</summary>\n\n세부 내용\n\n</details>",
      "> [!toggle]- 요약\n> 세부 내용",
    ],
    [
      "frontmatter 의 목록 모양 · 뒤 빈 줄 · 끝 줄바꿈",
      `${propertiesBlock(["a", "b"])}\n# 제목\n본문`,
      "---\ndue: 2026-10-15\ntags: [a, b]\n---\n# 제목\n\n본문\n",
      "---\ndue: 2026-10-15\ntags:\n  - a\n  - b\n---\n\n# 제목\n\n본문\n",
    ],
    ["블록 사이 빈 줄", "문단 하나\n문단 둘", "문단 하나\n\n\n\n문단 둘\n", "문단 하나\n\n문단 둘"],
    [
      "콜아웃 속 문단 경계",
      '<callout icon="💡">\n\t팁\n\t첫 문단\n\t둘째 문단\n</callout>',
      "> [!hint]- 팁\n> 첫 문단\n>\n> 둘째 문단\n",
      "> [!tip] 팁\n> 첫 문단\n> 둘째 문단",
    ],
  ];

  it.each(FORMS)("%s", (_name, exported, local, canonical) => {
    expect(pull(exported)).toBe(canonical);
    expect(pull(exported, local)).toBe(local);
    // 로컬 표기로 다시 올려도 Notion 은 그대로다.
    expect(sent(local)).toBe(sent(canonical));
  });

  it("로컬 노트가 CRLF 여도 — 받은 글은 LF 로 쓴다", () => {
    // Notion 에서 본문 줄을 지웠다 — 머리줄의 접힘 · 별칭은 그대로.
    expect(pull('<callout icon="❓">\n\t질문\n</callout>', "> [!faq]- 질문\r\n> 본문\r\n")).toBe(
      "> [!faq]- 질문\n",
    );
    expect(
      pull('<callout icon="❓">\n\t질문\n\t본문\n</callout>', "> [!faq]- 질문\r\n> 본문\r\n"),
    ).toBe("> [!faq]- 질문\n> 본문\n");
  });
});

describe("pull — 되살리지 않는 노트", () => {
  const previous = getLogger();
  afterEach(() => setLogger(previous));

  it("frontmatter 를 읽지 못하는 로컬 노트 — 받은 글 그대로, 경고 없이", () => {
    const warn = vi.fn();
    setLogger({ ...previous, warn });
    expect(pull("문단", "---\na: [\n---\n문단\n")).toBe("문단");
    expect(warn).not.toHaveBeenCalled();
  });

  it("받은 글이 frontmatter 처럼 보이지만 읽지 못하면 — 받은 글 그대로", () => {
    // Notion 의 구분선 · 문단이 frontmatter 모양으로 받아진 노트. 읽지 못하는 노트끼리는 꼴을 견줄 수 없다 —
    // 견주면 로컬 문단이 Notion 에서 고친 문단을 덮는다.
    expect(pull("---\na: [\n---\n문단 둘", "문단 하나\n")).toBe("---\na: [\n---\n\n문단 둘");
  });
});

describe("pull — Notion 에서 고친 것은 되돌리지 않는다", () => {
  it("같은 콜아웃의 본문을 고쳐도 접힘 · 별칭은 그대로", () => {
    expect(
      pull(
        '<callout icon="❓">\n\t접힌 질문\n\t접힌 본문 원격\n</callout>',
        "> [!faq]- 접힌 질문\n> 접힌 본문",
      ),
    ).toBe("> [!faq]- 접힌 질문\n> 접힌 본문 원격");
  });

  it("고친 문단 옆 콜아웃 속 문단 경계도 그대로", () => {
    expect(
      pull(
        '<callout icon="💡">\n\t팁\n\t첫 문단\n\t둘째 문단 원격\n</callout>',
        "> [!hint]- 팁\n> 첫 문단\n>\n> 둘째 문단\n",
      ),
    ).toBe("> [!hint]- 팁\n> 첫 문단\n>\n> 둘째 문단 원격\n");
  });

  it("Notion 에서 바꾼 아이콘은 받은 종류로 — 로컬의 별칭으로 되돌리지 않는다", () => {
    expect(
      pull(
        '<callout icon="💡">\n\t접힌 질문\n\t접힌 본문\n</callout>',
        "> [!faq]- 접힌 질문\n> 접힌 본문",
      ),
    ).toBe("> [!tip] 접힌 질문\n> 접힌 본문");
  });

  it("Notion 에서 지운 블록은 되살리지 않는다", () => {
    expect(
      pull(
        '<callout icon="❓">\n\t질문\n\t본문\n</callout>',
        "> [!faq]- 질문\n> 본문\n\n문단 둘\n",
      ),
    ).toBe("> [!faq]- 질문\n> 본문\n");
  });

  it("속성을 고치면 frontmatter 는 받은 글로 — 본문의 표기 · frontmatter 뒤 간격은 로컬대로", () => {
    // 줄을 섞어 본 노트의 frontmatter 는 깨질 수 있다 — 맞지 않는 노트로 치고, 경고하지 않는다.
    const previous = getLogger();
    const warn = vi.fn();
    setLogger({ ...previous, warn });
    onTestFinished(() => setLogger(previous));
    expect(
      pull(
        `${propertiesBlock(["a", "b", "c"])}\n<callout icon="❓">\n\t질문\n\t본문\n</callout>`,
        "---\ndue: 2026-10-15\ntags: [a, b]\n---\n> [!faq]- 질문\n> 본문\n",
      ),
    ).toBe("---\ndue: 2026-10-15\ntags:\n  - a\n  - b\n  - c\n---\n> [!faq]- 질문\n> 본문\n");
    expect(warn).not.toHaveBeenCalled();
  });

  it("실측 노트 — Notion 에서 마지막 줄만 고치면 그 줄만 바뀐다", () => {
    const local = [
      "---",
      "due: 2026-10-15",
      "tags: [a, b]",
      "---",
      "# OFM 왕복",
      "",
      "<mark>마크 태그</mark> · ==형광==",
      "",
      "> [!warning]+ 펼친 경고",
      "> 펼친 본문",
      "",
      "> [!faq]- 접힌 질문",
      "> 접힌 본문",
      "",
      "- [/] 진행 중",
      "- [x] 완료",
      "",
      "| a | b |",
      "| --- | --- |",
      "| x\\|y | z |",
      "",
      "<details>",
      "<summary>요약</summary>",
      "",
      "세부 내용",
      "",
      "</details>",
      "",
      "끝",
    ].join("\n");
    // `__f06_ofm__` 을 push 한 뒤 Notion 에서 마지막 줄을 고치고 받은 글의 모양.
    const exported = [
      propertiesBlock(["a", "b"]),
      "# OFM 왕복",
      '<span color="yellow_bg">마크 태그</span> · <span color="yellow_bg">형광</span>',
      '<callout icon="⚠️">',
      "\t펼친 경고",
      "\t펼친 본문",
      "</callout>",
      '<callout icon="❓">',
      "\t접힌 질문",
      "\t접힌 본문",
      "</callout>",
      "- \\[/\\] 진행 중",
      "- [x] 완료",
      '<table header-row="true">',
      "<tr>",
      "<td>a</td>",
      "<td>b</td>",
      "</tr>",
      "<tr>",
      "<td>x\\|y</td>",
      "<td>z</td>",
      "</tr>",
      "</table>",
      "<details>",
      "<summary>요약</summary>",
      "\t세부 내용",
      "</details>",
      "끝 원격",
    ].join("\n");
    expect(pull(exported, local)).toBe(local.replace(/끝$/, "끝 원격"));
  });
});

describe("LocalFormRestorer", () => {
  // 어느 노트든 같은 꼴로 보는 push — pull 이면 로컬 노트 그대로다.
  const restorer = new LocalFormRestorer(() => "같은 꼴");
  const input = (direction: "push" | "pull") => ({
    content: "> [!tip] 팁",
    metadata: { localContent: "> [!tip]- 팁" },
    context: { direction, path: "markdown-api", filePath: "a.md" } as const,
  });

  it("pull 에서만 되살린다", () => {
    expect(restorer.process(input("pull")).content).toBe("> [!tip]- 팁");
    expect(restorer.process(input("push")).content).toBe("> [!tip] 팁");
  });
});

describe("sentForm — push 가 Notion 에 보낼 꼴", () => {
  it("블록 사이 빈 줄은 보내지 않는다 — Notion 은 빈 줄 개수를 읽지 않는다", () => {
    expect(sent("문단 하나\n\n\n문단 둘")).toBe(sent("문단 하나\n\n문단 둘"));
    expect(sent("> [!tip] 팁\n> 첫 문단\n>\n> 둘째 문단")).toBe(
      sent("> [!tip] 팁\n> 첫 문단\n> 둘째 문단"),
    );
  });

  it("블록 경로 노트는 빈 줄도 보낸다 — 그 글에서는 빈 줄이 문단을 가른다", () => {
    // 단 나누기(`[!col]`)가 든 노트는 블록 경로로 간다.
    const columns = "> [!col]\n> 왼쪽";
    expect(sent(`${columns}\n\n문단 하나\n\n문단 둘`)).not.toBe(
      sent(`${columns}\n\n문단 하나\n문단 둘`),
    );
    expect(sent("문단 하나\n\n문단 둘")).toBe(sent("문단 하나\n문단 둘"));
  });

  it("코드 · 수식 속 빈 줄은 글이다", () => {
    expect(sent("```\na\n\nb\n```")).not.toBe(sent("```\na\nb\n```"));
    expect(sent("$$\na\n\nb\n$$")).not.toBe(sent("$$\na\nb\n$$"));
  });

  it("DB 행 속성은 키 차례를 보지 않는다 — 페이지 노트는 속성 코드 블록에 차례째 실린다", () => {
    const row = { ...PULL, parentMode: "database" } as const;
    expect(sentForm(pipeline, "---\na: 1\nb: x\n---\n본문", row)).toBe(
      sentForm(pipeline, "---\nb: x\na: 1\n---\n본문", row),
    );
    expect(sent("---\na: 1\nb: x\n---\n본문")).not.toBe(sent("---\nb: x\na: 1\n---\n본문"));
  });
});

describe("restoreLocalForm — 보낼 꼴로만 판단한다", () => {
  /** 콜아웃 접힘 · 빈 줄 개수 · 끝 줄바꿈을 보내지 않는 push — 실제 push 와 같은 모양 차이. */
  const fake = (note: string) =>
    note
      .replace(/^(> \[!\w+\])[+-]/gm, "$1")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/\n+$/, "");
  const counted = () => {
    const calls = { n: 0 };
    const send = (note: string) => {
      calls.n++;
      return fake(note);
    };
    return { calls, send };
  };

  it("받은 글이 CRLF 면 로컬 노트의 줄바꿈도 그대로 견준다", () => {
    expect(restoreLocalForm("> [!tip] 접힘\r\n", "> [!tip]- 접힘\r\n", fake)).toBe(
      "> [!tip]- 접힘\r\n",
    );
  });

  it("받은 글이 로컬 노트와 같으면 보낼 꼴을 만들지 않는다", () => {
    const { calls, send } = counted();
    expect(restoreLocalForm("문단\n", "문단\n", send)).toBe("문단\n");
    expect(calls.n).toBe(0);
  });

  it("노트 전체가 같은 꼴이면 로컬 노트 그대로 — 두 번만 본다", () => {
    const { calls, send } = counted();
    const local = "> [!tip]- 접힘\n> 본문\n\n\n문단\n";
    expect(restoreLocalForm("> [!tip] 접힘\n> 본문\n\n문단", local, send)).toBe(local);
    expect(calls.n).toBe(2);
  });

  it("고친 줄만 받은 글 — 같은 블록의 접힘과 그 뒤 빈 줄은 로컬대로", () => {
    expect(
      restoreLocalForm(
        "> [!tip] 접힘\n> 본문 고침\n\n문단\n",
        "> [!tip]- 접힘\n> 본문\n\n\n문단\n",
        fake,
      ),
    ).toBe("> [!tip]- 접힘\n> 본문 고침\n\n\n문단\n");
  });

  it("블록 수가 같으면 블록끼리 짝지어 본다 — 고친 블록 하나에 열 번이면 된다", () => {
    const { calls, send } = counted();
    const callouts = Array.from({ length: 10 }, (_, k) => k);
    const local = callouts.map((k) => `> [!tip]- 접힘 ${k}\n> 본문 ${k}`).join("\n\n");
    const pulled = callouts
      .map((k) => `> [!tip] 접힘 ${k}\n> 본문 ${k}${k === 5 ? " 고침" : ""}`)
      .join("\n\n");
    expect(restoreLocalForm(pulled, local, send)).toBe(local.replace("본문 5", "본문 5 고침"));
    expect(calls.n).toBeLessThanOrEqual(10);
  });

  it("frontmatter · 코드 속 빈 줄에서는 블록을 가르지 않는다", () => {
    const local = "---\na: 1\n\nb: 2\n---\n```\nx\n\n\ny\n```\n";
    const pulled = "---\na: 1\nb: 2\n---\n\n```\nx\n\n\ny\n```";
    // 코드 속 빈 줄 개수까지 보내는 push — 코드는 통째로 한 블록이라 로컬 코드를 그대로 맞춘다.
    const code = (note: string) => note.replace(/^---\n[\s\S]*?\n---\n+/, "").replace(/\n+$/, "");
    expect(restoreLocalForm(pulled, local, code)).toBe(local);
  });

  it("바꿔 보는 횟수는 64 번까지 — 넘어도 받은 노트와 같은 꼴이다", () => {
    const { calls, send } = counted();
    const callouts = Array.from({ length: 80 }, (_, k) => k);
    const local = callouts.map((k) => `> [!tip]- 접힘 ${k}\n> 본문 ${k}`).join("\n\n");
    // 하나 건너 하나를 Notion 에서 고쳤다 — 고친 콜아웃은 블록 통째로는 맞지 않는다.
    const pulled = callouts
      .map((k) => `> [!tip] 접힘 ${k}\n> 본문 ${k}${k % 2 ? " 고침" : ""}`)
      .join("\n\n");
    const restored = restoreLocalForm(pulled, local, send);
    expect(calls.n).toBeLessThanOrEqual(64);
    expect(fake(restored)).toBe(fake(pulled));
    // 고치지 않은 콜아웃은 첫 번에 모두 되살린다.
    expect(restored).toContain("> [!tip]- 접힘 0\n> 본문 0");
  });

  it("긴 노트는 덜 바꿔 본다 — 보는 줄 수의 합이 10만 줄까지", () => {
    const { calls, send } = counted();
    const callouts = Array.from({ length: 2500 }, (_, k) => k);
    const local = callouts.map((k) => `> [!tip]- 접힘 ${k}\n> 본문 ${k}`).join("\n\n");
    const pulled = callouts
      .map((k) => `> [!tip] 접힘 ${k}\n> 본문 ${k}${k % 2 ? " 고침" : ""}`)
      .join("\n\n");
    const restored = restoreLocalForm(pulled, local, send);
    // 7,499줄 — 13번.
    expect(calls.n).toBeLessThanOrEqual(13);
    expect(fake(restored)).toBe(fake(pulled));
  });

  it("무작위 원격 편집 — 되살린 노트는 언제나 받은 노트와 같은 꼴이다", () => {
    const random = seeded(30);
    for (let n = 0; n < 500; n++) {
      const local = randomNote(random);
      let pulled = canonical(local);
      const edits = Math.floor(random() * 4);
      for (let e = 0; e < edits; e++) pulled = remoteEdit(random, pulled);
      const { calls, send } = counted();
      const restored = restoreLocalForm(pulled, local, send);
      const label = JSON.stringify({ local, pulled, restored });
      expect(fake(restored), label).toBe(fake(pulled));
      expect(calls.n, label).toBeLessThanOrEqual(64);
      if (edits === 0) expect(restored, label).toBe(local);
    }
  });
});

describe("restoreLocalForm — 실제 push 로 무작위 원격 편집", () => {
  it("되살린 노트는 언제나 받은 노트와 같은 꼴이다", () => {
    const random = seeded(31);
    for (let n = 0; n < 60; n++) {
      const local = randomNote(random);
      let pulled = pull(notionExport(local));
      const edits = Math.floor(random() * 3);
      for (let e = 0; e < edits; e++) pulled = remoteEdit(random, pulled);
      const restored = restoreLocalForm(pulled, local, sent);
      const label = JSON.stringify({ local, pulled, restored });
      expect(sent(restored), label).toBe(sent(pulled));
      if (edits === 0) expect(restored, label).toBe(local);
    }
  });
});

/** Notion 이 push 받은 노트를 내보내는 모양 — 블록 사이 빈 줄이 없다. */
function notionExport(note: string): string {
  return JSON.parse(sent(note))[1] as string;
}

/** fake push 가 보는 정준형 — 접힘을 떼고, 빈 줄을 한 줄로, 끝 줄바꿈 없이. */
function canonical(note: string): string {
  return note
    .replace(/^(> \[!\w+\])[+-]/gm, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n+$/, "");
}

/** 같은 씨앗이면 같은 수열 — 실패한 경우를 다시 돌릴 수 있다. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/** 접힌 콜아웃 · 별칭 · 문단 · 목록 · 코드가 섞이고 빈 줄 개수가 제각각인 노트. */
function randomNote(random: () => number): string {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const number = () => Math.floor(random() * 99);
  const blocks: Array<() => string[]> = [
    () => [`문단 ${number()}.`],
    () => [`## 제목 ${number()}`],
    () => [`- 항목 ${number()}`, `- 항목 ${number()}`],
    () => [
      `> [!${pick(["tip", "faq", "warning", "note"])}]${pick(["", "+", "-"])} 콜아웃 ${number()}`,
      `> 줄 ${number()}`,
      ...(random() < 0.4 ? [">", `> 문단 ${number()}`] : []),
    ],
    () => ["```js", `const a = ${number()};`, "", `const b = ${number()};`, "```"],
    () => [`<mark>마크 ${number()}</mark> 글`],
  ];
  const parts = Array.from({ length: 2 + Math.floor(random() * 5) }, () =>
    pick(blocks)().join("\n"),
  );
  const body = parts.reduce(
    (note, part) => note + "\n".repeat(2 + Math.floor(random() * 3)) + part,
  );
  const head = random() < 0.3 ? "---\ntags: [a, b]\n---\n" : "";
  return head + body + (random() < 0.5 ? "\n" : "");
}

/** 원격 편집 하나 — 줄을 고치거나 지우거나 문단을 더한다. 코드 펜스 줄은 건드리지 않는다. */
function remoteEdit(random: () => number, pulled: string): string {
  const head = /^---\n[\s\S]*?\n---\n/.exec(pulled)?.[0] ?? "";
  const lines = pulled.slice(head.length).split("\n");
  const at = Math.min(Math.floor(random() * lines.length), lines.length - 1);
  if (lines[at]!.startsWith("```")) return pulled;
  const kind = random();
  if (kind < 0.3) lines.splice(at, 0, "", `새 문단 ${Math.floor(random() * 99)}.`);
  else if (kind < 0.5) lines.splice(at, 1);
  else lines[at] = `${lines[at]} 고침`;
  return head + lines.join("\n");
}
