/**
 * 블록 폴백 pull — 블록 트리를 Notion 이 Markdown API 로 내보내는 글(NFM)과 같은 글로 옮기는지.
 *
 * 픽스처(`tests/fixtures/nfm/`)는 탐침 페이지 12장의 블록 API 응답과 같은 페이지의 Markdown API export 를
 * 그대로 받은 짝이다(2026-10-12). 사용자 id · 이름만 가짜로 바꿨다. 블록 API 가 주지 않는 것은
 * {@link BLOCK_API_GAPS} 로 export 에서 빼고 견준다 — 그 밖의 줄은 글자까지 같아야 한다.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { blocksToNfm, type NfmSourceBlock } from "../../src/converter/blocks-to-nfm.js";
import { notionEnhancedToObsidian } from "../../src/converter/enhanced-md-converter.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "nfm");

function fixture(name: string): { pageId: string; blocks: NfmSourceBlock[]; nfm: string } {
  const { pageId, blocks } = JSON.parse(
    readFileSync(join(FIXTURE_DIR, `${name}.blocks.json`), "utf8"),
  ) as { pageId: string; blocks: NfmSourceBlock[] };
  const nfm = readFileSync(join(FIXTURE_DIR, `${name}.nfm.md`), "utf8").replace(/\n$/, "");
  return { pageId, blocks, nfm };
}

/** 콜아웃 첫 줄 아래에 단 자식 — Markdown API 로만 만들 수 있고 블록 API 의 자식 목록에 없다. */
const HIDDEN_CALLOUT_LINE_CHILDREN: Record<string, readonly string[]> = {
  "corpus-02": [
    '\t\t### 발표 자료 {toggle="true"}',
    "\t\t\t슬라이드 열 장 이내로 정리하고 데모 영상을 첨부한다.",
    '\t\t### 사전 질의 {toggle="true"}',
    "\t\t\t참석자에게 하루 전 질문을 받아 순서를 정한다.",
  ],
  "corpus-08": [
    '\t\t\t\t### 준비 {toggle="true"}',
    "\t\t\t\t\t<details>",
    "\t\t\t\t\t<summary>필요 권한</summary>",
    "\t\t\t\t\t\t읽기 권한과 통합 토큰이 모두 있어야 한다.",
    "\t\t\t\t\t</details>",
  ],
};

const withoutLines = (nfm: string, lines: readonly string[]) =>
  nfm
    .split("\n")
    .filter((line) => !lines.includes(line))
    .join("\n");

/** 블록 API 가 주지 않아 옮길 수 없는 것 — export 를 블록 API 로 알 수 있는 만큼으로 줄인다. */
const BLOCK_API_GAPS: Record<string, (nfm: string) => string> = {
  "corpus-02": (nfm) => withoutLines(nfm, HIDDEN_CALLOUT_LINE_CHILDREN["corpus-02"]!),
  "corpus-08": (nfm) => withoutLines(nfm, HIDDEN_CALLOUT_LINE_CHILDREN["corpus-08"]!),
  // 표의 열 너비 · 행 색
  "corpus-03": (nfm) =>
    nfm
      .replace(/<colgroup>\n(?:<col [^\n]*\n)*<\/colgroup>\n/, "")
      .replace(/<tr color="[^"]*">/, "<tr>"),
  // 인라인 DB 의 data source 와 표시 방식 · 정각이 아닌 지역 시간대의 이름(같은 시각을 UTC 로 낸다)
  "blocks-3": (nfm) =>
    nfm.replace(
      /<mention-page url="([^"]*\/([0-9a-f]{32}))"\/>/g,
      (tag, url: string, id: string) => {
        const target = MENTION_TITLES[id];
        if (!target) return tag;
        return `<mention-${target.kind} url="${url}">${target.title}</mention-${target.kind}>`;
      },
    ),
  "blocks-1": (nfm) =>
    nfm
      .replace(/(<database url="[^"]*") inline="true" data-source-url="[^"]*"/, "$1")
      .replace('startTime="09:00" timeZone="Asia/Calcutta"', 'startTime="03:30" timeZone="UTC"'),
};

/**
 * 멘션한 페이지 · DB 의 제목 — Notion 은 받는 페이지의 자식이면 제목을 싣고(`blocks-1`), 아니면 싣지 않으며 DB 도
 * `mention-page` 로 낸다(`blocks-3`). 블록 API 로는 둘을 가를 수 없어 늘 제목을 싣고 종류를 지킨다 — 두 모양은
 * 볼트에서 같은 위키링크가 된다.
 */
const MENTION_TITLES: Record<string, { kind: string; title: string }> = {
  "3f713b18d382810a969cfe109ae082c6": { kind: "page", title: "__bf_nfm_child" },
  "3f713b18d3828175aefcdd34abc335a0": { kind: "page", title: "__bf_nfm2" },
  a5a68faa1a2144b6a8ffaff450a3ed20: { kind: "database", title: "__bf_nfm_db" },
};

const PAIRS = [
  ...Array.from({ length: 10 }, (_, i) => `corpus-${String(i + 1).padStart(2, "0")}`),
  "blocks-1",
  "blocks-2",
  "blocks-3",
];

describe("blocksToNfm — Notion 의 Markdown API export 와 같은 글", () => {
  it.each(PAIRS)("%s", (name) => {
    const { pageId, blocks, nfm } = fixture(name);
    const expected = (BLOCK_API_GAPS[name] ?? ((s: string) => s))(nfm);

    expect(blocksToNfm(blocks, { pageId })).toBe(expected);
  });

  it("빼고 견준 것은 블록 API 로 알 수 없는 것뿐이다 — 줄인 export 가 원본과 다르다", () => {
    for (const name of Object.keys(BLOCK_API_GAPS)) {
      const { nfm } = fixture(name);
      expect(BLOCK_API_GAPS[name]!(nfm), name).not.toBe(nfm);
    }
  });

  it("볼트 노트도 Markdown API 로 받은 것과 같다", () => {
    for (const name of PAIRS.filter((n) => !(n in BLOCK_API_GAPS))) {
      const { pageId, blocks, nfm } = fixture(name);
      expect(notionEnhancedToObsidian(blocksToNfm(blocks, { pageId })), name).toBe(
        notionEnhancedToObsidian(nfm),
      );
    }
  });
});

// ─── 픽스처에 없는 모양 ───

const PAGE = "11111111-2222-4333-8444-555555555555";
const PAGE32 = PAGE.replace(/-/g, "");
const URL_OF = (id: string) => `https://app.notion.com/p/${id.replace(/-/g, "")}`;

const plain = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default",
};
const text = (content: string, annotations: Partial<typeof plain> = {}, link?: string) => ({
  type: "text",
  plain_text: content,
  text: { content, link: link ? { url: link } : null },
  annotations: { ...plain, ...annotations },
});
const mention = (value: Record<string, unknown>, plainText = "") => ({
  type: "mention",
  plain_text: plainText,
  mention: value,
  annotations: plain,
});

let seq = 0;
function block(
  type: string,
  body: Record<string, unknown> = {},
  children?: NfmSourceBlock[],
): NfmSourceBlock {
  seq += 1;
  const id = `aaaaaaaa-bbbb-4ccc-8ddd-${String(seq).padStart(12, "0")}`;
  return {
    id,
    type,
    has_children: children !== undefined,
    ...(children ? { children } : {}),
    [type]: body,
  } as NfmSourceBlock;
}
const para = (...rich: unknown[]) => block("paragraph", { rich_text: rich, color: "default" });
const nfm = (...blocks: NfmSourceBlock[]) => blocksToNfm(blocks, { pageId: PAGE });

describe("blocksToNfm — 글 조각", () => {
  it("escape 하는 글자와 그대로 두는 글자, 줄바꿈은 <br>", () => {
    expect(nfm(para(text('\\ * < > ` ~ [ ] | $ { } _ # & "\n둘')))).toBe(
      '\\\\ \\* \\< \\> \\` \\~ \\[ \\] \\| \\$ \\{ \\} _ # & "<br>둘',
    );
  });

  it("서식이 같은 이웃 조각은 하나로, 다르면 따로 — 링크가 다르면 따로", () => {
    expect(nfm(para(text("가", { bold: true }), text("나", { bold: true })))).toBe("**가나**");
    expect(nfm(para(text("가", { bold: true }), text("나", { italic: true })))).toBe("**가***나*");
    expect(
      nfm(para(text("가", {}, "https://a.example"), text("나", {}, "https://b.example"))),
    ).toBe("[가](https://a.example)[나](https://b.example)");
  });

  it("서식 차례 — span(색 · 밑줄) › 링크 › 굵게 › 기울임 › 취소선 › 코드", () => {
    const all = { bold: true, italic: true, strikethrough: true, code: true, underline: true };
    expect(nfm(para(text("x", { ...all, color: "red_background" }, "https://a.example")))).toBe(
      '<span color="red_bg" underline="true">[***~~`x`~~***](https://a.example)</span>',
    );
  });

  it("인라인 코드 · 링크 주소 · 수식 안의 글자는 escape 하지 않는다 — 줄바꿈만 <br>", () => {
    expect(nfm(para(text("a*b <c> |d|\n둘", { code: true })))).toBe("`a*b <c> |d|<br>둘`");
    expect(nfm(para(text("[x]", {}, "https://e.example/a_(b)?r=*")))).toBe(
      "[\\[x\\]](https://e.example/a_(b)?r=*)",
    );
  });

  it("서식을 입힌 봇 멘션도 빈 서식 기호를 남기지 않는다", () => {
    const bot = {
      ...mention({ type: "user", user: { id: "b-1", type: "bot" } }, "@봇"),
      annotations: { ...plain, bold: true },
    };
    expect(nfm(para(text("가"), bot, text("나")))).toBe("가나");
  });

  it("봇 멘션은 내보내지 않고, 사람 멘션은 id 를 싣는다", () => {
    const person = mention({ type: "user", user: { id: "u-1" } }, "@사람");
    const bot = mention({ type: "user", user: { id: "b-1", type: "bot" } }, "@봇");
    expect(nfm(para(text("가 "), person, text(" "), bot, text(" 나")))).toBe(
      '가 <mention-user url="user://u-1"/>  나',
    );
  });

  it("id 가 없는 멘션 · 읽지 못한 날짜는 보이는 글로 둔다", () => {
    const noId = mention({ type: "user", user: {} }, "@누구");
    const page = mention({ type: "page", page: {} }, "페이지*");
    const date = mention({ type: "date", date: { start: "" } }, "언젠가");
    expect(nfm(para(noId))).toBe("@누구");
    expect(nfm(para(page))).toBe("페이지\\*");
    expect(nfm(para(date))).toBe("언젠가");
  });

  it("페이지 · DB 멘션은 Notion 주소와 제목을 싣는다", () => {
    const page = mention({ type: "page", page: { id: PAGE } }, "제목");
    const db = mention({ type: "database", database: { id: PAGE } }, "디비");
    expect(nfm(para(page, db))).toBe(
      `<mention-page url="${URL_OF(PAGE)}">제목</mention-page>` +
        `<mention-database url="${URL_OF(PAGE)}">디비</mention-database>`,
    );
  });

  it("그 밖의 멘션(링크 미리보기)은 주소가 있으면 링크, 없으면 글", () => {
    const preview = {
      ...mention({ type: "link_preview", link_preview: {} }, "미리"),
      href: "https://x.example",
    };
    const bare = mention({ type: "template_mention", template_mention: {} }, "틀");
    expect(nfm(para(preview, text(" "), bare))).toBe("[미리](https://x.example) 틀");
  });

  it("인라인 수식은 $`식`$", () => {
    expect(nfm(para({ type: "equation", plain_text: "x", equation: { expression: "x^2" } }))).toBe(
      "$`x^2`$",
    );
  });
});

describe("blocksToNfm — 블록", () => {
  it("빈 문단은 <empty-block/> — 색이나 자식이 있으면 빈 줄이 아니다", () => {
    expect(nfm(para())).toBe("<empty-block/>");
    expect(nfm(block("paragraph", { rich_text: [], color: "blue" }))).toBe(' {color="blue"}');
    expect(nfm(block("paragraph", { rich_text: [] }, [para(text("자"))]))).toBe("\n\t자");
  });

  it("번호 목록은 다른 블록이 끼면 1 부터 다시 센다", () => {
    const num = (s: string) => block("numbered_list_item", { rich_text: [text(s)] });
    expect(nfm(num("a"), num("b"), para(text("끼")), num("c"))).toBe("1. a\n2. b\n끼\n1. c");
  });

  it("빈 제목은 # 만, 접는 제목 · 색은 {toggle color}", () => {
    expect(nfm(block("heading_1", { rich_text: [], color: "default" }))).toBe("#");
    expect(
      nfm(block("heading_3", { rich_text: [text("t")], is_toggleable: true, color: "purple" })),
    ).toBe('### t {toggle="true" color="purple"}');
  });

  it("글이 없는 콜아웃은 아이콘 · 색 줄과 자식만, 아이콘 모양별 표기", () => {
    const callout = (icon: unknown, color = "default") =>
      nfm(block("callout", { rich_text: [], icon, color }, [para(text("자"))]));
    expect(callout(null, "blue_background")).toBe('<callout color="blue_bg">\n\t자\n</callout>');
    expect(callout({ type: "file", file: { url: "https://f.example/i.png" } })).toBe(
      '<callout icon="https://f.example/i.png">\n\t자\n</callout>',
    );
    expect(callout({ type: "icon", icon: { name: "pin" } })).toBe(
      '<callout icon="/icons/pin.svg">\n\t자\n</callout>',
    );
    expect(callout({ type: "custom_emoji", custom_emoji: {} })).toBe("<callout>\n\t자\n</callout>");
  });

  it("깊이 안의 코드는 펜스만 들여쓰고, 블록 수식은 식의 첫 줄만 들여쓴다", () => {
    const code = block("code", { rich_text: [text("a\nb")], language: "js" });
    const eq = block("equation", { expression: "a\\\\\nb" });
    expect(nfm(block("toggle", { rich_text: [text("t")] }, [code, eq]))).toBe(
      "<details>\n<summary>t</summary>\n\t```js\na\nb\n\t```\n\t$$\n\ta\\\\\nb\n\t$$\n</details>",
    );
  });

  it("칼럼 비율은 백분율로 — 부동소수 찌꺼기를 남기지 않는다", () => {
    expect(nfm(block("column", { width_ratio: 0.07 }, [para(text("a"))]))).toBe(
      '<column ratio="7">\n\ta\n</column>',
    );
  });

  it("칼럼 비율이 없으면 ratio 를 싣지 않는다", () => {
    expect(nfm(block("column_list", {}, [block("column", {}, [para(text("a"))])]))).toBe(
      "<columns>\n\t<column>\n\t\ta\n\t</column>\n</columns>",
    );
  });

  it("업로드한 파일은 file 주소를, 캡션은 서식째", () => {
    const image = block("image", {
      type: "file",
      file: { url: "https://s.example/a.png" },
      caption: [text("캡", { bold: true })],
    });
    expect(nfm(image)).toBe("![**캡**](https://s.example/a.png)");
  });

  it("북마크 · 바로가기 · 경로는 이 페이지의 블록 주소를 싣는 자리 태그", () => {
    const [bookmark, alias, crumb] = [
      block("bookmark", { url: "https://x.example" }),
      block("link_to_page", { type: "page_id", page_id: PAGE }),
      block("breadcrumb"),
    ];
    const at = (b: NfmSourceBlock) =>
      `https://app.notion.com/p/${PAGE32}#${b.id.replace(/-/g, "")}`;
    expect(nfm(bookmark, alias, crumb)).toBe(
      [
        `<unknown url="${at(bookmark)}" alt="bookmark"/>`,
        `<unknown url="${at(alias)}" alt="alias"/>`,
        `<unknown url="${at(crumb)}" alt="breadcrumb"/>`,
      ].join("\n"),
    );
  });

  it("동기화 참조 블록도 이 페이지 주소에 원본 블록 id 를 붙인다", () => {
    const source = "99999999-8888-4777-8666-555555555555";
    const ref = block("synced_block", { synced_from: { block_id: source } }, [para(text("원"))]);

    expect(nfm(ref)).toBe(
      `<synced_block_reference url="${URL_OF(PAGE)}#${source.replace(/-/g, "")}">\n\t원\n</synced_block_reference>`,
    );
  });

  it("자식 페이지 · DB 는 주소와 제목", () => {
    const child = block("child_page", { title: "자*식" });
    const db = block("child_database", { title: "디비" });
    expect(nfm(child, db)).toBe(
      `<page url="${URL_OF(child.id)}">자\\*식</page>\n<database url="${URL_OF(db.id)}">디비</database>`,
    );
  });

  it("탭은 자식 하나가 탭 하나다", () => {
    expect(nfm(block("tab", {}, [para(text("가")), para(text("나"))]))).toBe(
      "<tabs>\n\t<tab>\n\t\t가\n\t</tab>\n\t<tab>\n\t\t나\n\t</tab>\n</tabs>",
    );
  });
});
