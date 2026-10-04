/**
 * S-28 — 콜아웃 · 토글 안의 이미지 · 첨부 임베드는 그 컨테이너 안에 자리표시자로 간다.
 *
 * 예전에는 일반 인용처럼 인용 접두를 떼고 컨테이너 밖으로 내보내, 뒷줄은 일반 인용이 되고 이미지뿐인
 * 토글은 비고 토글 속 칼럼은 마커가 짝을 잃어 사라졌다(실볼트 컨테이너 속 임베드 203줄 · 30노트).
 * 자리표시자 인용은 업로드 뒤 이미지 블록으로 제자리 교체된다(ImageHandler) — 콜아웃 · 토글 · 겹친
 * 콜아웃 · 토글 속 칼럼 안에서도 그 자리의 자식으로 들어감을 실측했다(2026-10-04).
 */
import { describe, it, expect } from "vitest";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";
import { pushContainerKind } from "../../src/converter/container-head.js";
import { restoreChildTags, type ChildTag } from "../../src/converter/child-tags.js";

const PUSH = { direction: "push", path: "markdown-api", filePath: "note.md" } as const;
const PULL = { ...PUSH, direction: "pull" } as const;
const T = "\t";

/** push 가 Notion 에 보내는 글(Markdown API 의 enhanced markdown). */
const sent = (note: string): string =>
  obsidianToNotionEnhanced(createDefaultPipeline().convertToNotion(note, PUSH).content);

/** push → Notion → pull 한 바퀴 — 자리표시자가 이미지로 바뀌지 않은 채 돌아오는 경우. */
const roundTrip = (note: string): string =>
  createDefaultPipeline().convertToMarkdown(notionEnhancedToObsidian(sent(note)), PULL, {});

const image = (name: string) => `> 📎 ${name} %% im-nobsidian:local-image:${name} %%`;

const COLUMNS_IN_TOGGLE = [
  "> [!toggle]- 참고",
  "> %%im-nobsidian:column-list:start%%",
  "> %%im-nobsidian:column%%",
  "> ![[c.png]]",
  "> %%im-nobsidian:column%%",
  "> ![[d.png]]",
  "> %%im-nobsidian:column-list:end%%",
  "",
  "다음",
].join("\n");

describe("콜아웃 · 토글 안 임베드 — 자리표시자가 그 자리의 자식이 된다", () => {
  /** [배치, 노트, 보내는 글] */
  const CASES: Array<[string, string, string]> = [
    [
      "콜아웃 본문 — 앞뒤 줄은 콜아웃에 남는다",
      "> [!note] 제목\n> 앞 줄\n> ![[a.png]]\n> 뒤 줄\n\n다음",
      `<callout icon="📝">\n${T}제목\n${T}앞 줄\n${T}${image("a.png")}\n${T}뒤 줄\n</callout>\n\n다음`,
    ],
    [
      "이미지뿐인 토글 — 비지 않는다",
      "> [!toggle]- 토글\n> ![[b.png]]\n\n다음",
      `<details>\n<summary>토글</summary>\n\n${image("b.png")}\n\n</details>\n\n다음`,
    ],
    [
      "토글 속 칼럼 — 칼럼째 남는다",
      COLUMNS_IN_TOGGLE,
      [
        "<details>",
        "<summary>참고</summary>",
        "",
        "<columns>",
        `${T}<column>`,
        `${T}${T}${image("c.png")}`,
        `${T}</column>`,
        `${T}<column>`,
        `${T}${T}${image("d.png")}`,
        `${T}</column>`,
        "</columns>",
        "",
        "</details>",
        "",
        "다음",
      ].join("\n"),
    ],
    [
      "겹친 콜아웃 — 안쪽 콜아웃에",
      "> [!tip] 겹친 콜아웃\n> > [!note] 안쪽\n> > ![[f.png]]\n\n다음",
      `<callout icon="💡">\n${T}겹친 콜아웃\n${T}<callout icon="📝">\n${T}${T}안쪽\n${T}${T}${image("f.png")}\n${T}</callout>\n</callout>\n\n다음`,
    ],
    [
      "토글 속 콜아웃 — 콜아웃에",
      "> [!toggle]- 토글\n> > [!note] 안\n> > ![[a.png]]\n> > 뒤 줄\n> 토글 끝\n\n다음",
      `<details>\n<summary>토글</summary>\n\n<callout icon="📝">\n${T}안\n${T}${image("a.png")}\n${T}뒤 줄\n</callout>\n토글 끝\n\n</details>\n\n다음`,
    ],
    [
      "목록 안 콜아웃",
      "- 항목\n  > [!note] 제목\n  > ![[a.png]]\n  > 뒤 줄\n- 다음 항목",
      `- 항목\n${T}<callout icon="📝">\n${T}${T}제목\n${T}${T}${image("a.png")}\n${T}${T}뒤 줄\n${T}</callout>\n- 다음 항목`,
    ],
    [
      "연달은 두 임베드 — 줄마다 자리표시자 하나",
      "> [!note] 제목\n> ![[a.png]]\n> ![[b.pdf]]\n\n다음",
      `<callout icon="📝">\n${T}제목\n${T}${image("a.png")}\n${T}> 📎 b.pdf %% im-nobsidian:local-file:b.pdf %%\n</callout>\n\n다음`,
    ],
    [
      "제목 없는 콜아웃 — 첫 줄이 자리표시자",
      "> [!note]\n> ![[a.png]]\n> 뒤 줄\n\n다음",
      `<callout icon="📝">\n${T}${image("a.png")}\n${T}뒤 줄\n</callout>\n\n다음`,
    ],
    [
      "콜아웃 속 목록 항목에 딸린 임베드 — 항목의 자식으로",
      "> [!note] 제목\n> - 항목\n>   ![[a.png]]\n>   계속\n> - 다음 항목\n\n다음",
      `<callout icon="📝">\n${T}제목\n${T}- 항목\n${T}${T}${image("a.png")}\n${T}${T}계속\n${T}- 다음 항목\n</callout>\n\n다음`,
    ],
    [
      "토글 속 목록 항목에 딸린 임베드 — 항목의 자식으로",
      "> [!toggle]- 토글\n> 1. 항목\n> \t- 하위\n>   ![[b.png]]\n> \t- 하위 둘\n\n다음",
      `<details>\n<summary>토글</summary>\n\n1. 항목\n${T}- 하위\n\n${T}${image("b.png")}\n\n${T}- 하위 둘\n\n</details>\n\n다음`,
    ],
  ];

  it.each(CASES)("%s", (_name, note, expected) => {
    expect(sent(note)).toBe(expected);
  });
});

describe("앞뒤 글과 끊기 — 자리표시자에 이어 붙을 자리만", () => {
  it("콜아웃은 줄바꿈 하나로 갈린다 — 같은 줄의 앞뒤 글도", () => {
    expect(sent("> [!note] 제목\n> 앞 ![[a.png]] 뒤\n\n다음")).toBe(
      `<callout icon="📝">\n${T}제목\n${T}앞\n${T}${image("a.png")}\n${T}뒤\n</callout>\n\n다음`,
    );
  });

  it("토글 본문은 들여쓰기 없이 실려 뒷글이 이어 붙으므로 빈 줄로 끊는다", () => {
    expect(sent("> [!toggle]- 토글\n> 앞 줄\n> ![[b.png]]\n> 뒤 줄\n\n다음")).toBe(
      `<details>\n<summary>토글</summary>\n\n앞 줄\n\n${image("b.png")}\n\n뒤 줄\n\n</details>\n\n다음`,
    );
    expect(sent("> [!toggle]- 토글\n> 앞 ![[b.png]] 뒤\n\n다음")).toBe(
      `<details>\n<summary>토글</summary>\n\n앞\n\n${image("b.png")}\n\n뒤\n\n</details>\n\n다음`,
    );
  });

  it("목록 항목 속 앞뒤 글도 항목에 남는다", () => {
    expect(sent("> [!note] 제목\n> - 항목\n>   앞 ![[a.png]] 뒤\n> - 다음\n\n다음")).toBe(
      `<callout icon="📝">\n${T}제목\n${T}- 항목\n${T}${T}앞\n${T}${T}${image("a.png")}\n${T}${T}뒤\n${T}- 다음\n</callout>\n\n다음`,
    );
    expect(sent("> [!note] 제목\n> - 항목\n>   > 인용\n>   > ![[a.png]]\n> - 다음\n\n다음")).toBe(
      `<callout icon="📝">\n${T}제목\n${T}- 항목\n${T}${T}> 인용\n\n${T}${T}${image("a.png")}\n${T}- 다음\n</callout>\n\n다음`,
    );
  });

  it("칼럼 마커뿐인 줄과는 끊지 않는다 — 글이 아니다", () => {
    expect(sent(COLUMNS_IN_TOGGLE)).not.toMatch(/📎[^\n]*\n\n/);
  });

  it("컨테이너 안 일반 인용 속 임베드는 그 인용 밖, 컨테이너 안으로 떨어진다", () => {
    expect(sent("> [!note] 제목\n> > 인용 앞\n> > ![[a.png]]\n> > 인용 뒤\n\n다음")).toBe(
      `<callout icon="📝">\n${T}제목\n${T}> 인용 앞\n\n${T}${image("a.png")}\n\n${T}> 인용 뒤\n</callout>\n\n다음`,
    );
    expect(sent("> [!toggle]- 토글\n> > 인용 앞\n> > ![[a.png]]\n> > 인용 뒤\n\n다음")).toBe(
      `<details>\n<summary>토글</summary>\n\n> 인용 앞\n\n${image("a.png")}\n\n> 인용 뒤\n\n</details>\n\n다음`,
    );
  });
});

describe("머리 줄의 임베드 — 제목에서 빼 첫 자식 줄로 내린다", () => {
  it("콜아웃 색 마커는 머리 줄에 남는다 — 글자로 새지 않는다", () => {
    expect(
      sent("> [!note] ![[table.base|표]] %%im-nobsidian:callout-style:color=orange_bg%%\n\n다음"),
    ).toBe(
      `<callout color="orange_bg">\n${T}> 📎 table.base %% im-nobsidian:local-file:table.base%7C%ED%91%9C %%\n</callout>\n\n다음`,
    );
  });

  it("제목 글은 남기고 임베드만 내린다", () => {
    expect(
      sent("> [!note] 제목 ![[a.png]] 뒤 %%im-nobsidian:callout-style:color=red%%\n> 본문\n\n다음"),
    ).toBe(
      `<callout color="red">\n${T}제목 뒤\n${T}${image("a.png")}\n${T}본문\n</callout>\n\n다음`,
    );
  });

  it("토글 · 겹친 콜아웃의 머리 줄도", () => {
    expect(sent("> [!toggle]- ![[a.png]]\n> 본문\n\n다음")).toBe(
      `<details>\n<summary></summary>\n\n${image("a.png")}\n\n본문\n\n</details>\n\n다음`,
    );
    expect(sent("> [!tip] 바깥\n> > [!note] ![[a.png]]\n> 바깥 끝\n\n다음")).toBe(
      `<callout icon="💡">\n${T}바깥\n${T}<callout icon="📝">\n${T}${T}${image("a.png")}\n${T}</callout>\n${T}바깥 끝\n</callout>\n\n다음`,
    );
  });

  it("노트 임베드 · 인라인 코드 속 임베드는 글자 그대로", () => {
    expect(sent("> [!note] ![[노트]] 제목\n\n다음")).toBe(
      `<callout icon="📝">\n${T}![[노트]] 제목\n</callout>\n\n다음`,
    );
    expect(sent("> [!note] `![[a.png]]` 설명\n> 본문\n\n다음")).toBe(
      `<callout icon="📝">\n${T}\`![[a.png]]\` 설명\n${T}본문\n</callout>\n\n다음`,
    );
  });
});

describe("변환기가 컨테이너로 보지 않는 인용 — 예전처럼 인용 밖으로 낸다", () => {
  // 이 인용들은 Notion 에 일반 인용으로 간다. 그 안에 자리표시자를 겹쳐 두면 Notion 이 앞뒤 글과
  // 이어 붙여, 이미지로 교체할 때 그 글이 함께 지워진다.
  const PLAIN: Array<[string, string]> = [
    ["일반 인용", "> 인용 앞\n> ![[a.png]]\n> 인용 뒤"],
    ["`>` 뒤 공백 없는 머리", ">[!note] 제목\n>앞\n>![[a.png]]\n>뒤 줄"],
    ["종류에 낱말 글자가 아닌 것", "> [!my-type] 제목\n> ![[a.png]]\n> 뒤 줄"],
    ["접기 표시 없는 토글", "> [!toggle] 제목\n> ![[a.png]]\n> 뒤 줄"],
    ["대문자 토글", "> [!Toggle]- 제목\n> ![[a.png]]\n> 뒤 줄"],
    ["일반 인용 속 콜아웃", "> 인용\n> > [!note] 안\n> > ![[a.png]]"],
  ];

  it.each(PLAIN)("%s", (_name, note) => {
    const out = sent(`${note}\n\n다음`);
    expect(out.split("\n")).toContain(image("a.png"));
    expect(out).not.toContain("<callout");
    expect(out).not.toContain("<details");
  });

  it("본문이 `> ` 꼴에서 끊긴 콜아웃 — 끊긴 뒤의 임베드는 콜아웃 밖이다", () => {
    // 변환기는 콜아웃 본문을 `> ` · `>` 줄까지만 받는다. `>붙은 줄` 부터는 일반 인용이다.
    const out = sent("> [!note] 제목\n>붙은 줄\n> ![[a.png]]\n> 뒤 줄\n\n다음");
    expect(out).toContain(`<callout icon="📝">\n${T}제목\n</callout>`);
    expect(out.split("\n")).toContain(image("a.png"));
  });
});

describe("pushContainerKind — 변환기와 같은 규칙", () => {
  const HEADS = [
    "> [!note] 제목",
    "> [!NOTE] 대문자",
    "> [!note]- 접힘",
    "  > [!tip] 목록 안",
    "> [!toggle]- 토글",
    "> [!toggle] 접기 없음",
    "> [!toggle]+ 펼침",
    "> [!Toggle]- 대문자",
    ">[!note] 붙음",
    ">  [!note] 두 칸",
    "    > [!note] 네 칸",
    "> [!my-type] 하이픈",
    "> [!tab] 탭",
    "> 인용",
  ];

  it.each(HEADS)("%s", (head) => {
    const out = obsidianToNotionEnhanced(`${head}\n> 본문`).trimStart();
    const actual = out.startsWith("<callout")
      ? "callout"
      : out.startsWith("<details")
        ? "toggle"
        : null;
    expect(pushContainerKind(head)).toBe(actual);
  });
});

describe("`.base` 임베드 — 자식 DB 태그가 컨테이너 안 제자리에 놓인다", () => {
  const DB_ID = "060db215aaaa4bbbbcccc1234567d466";
  const DB_TAG = `<database url="https://app.notion.com/p/${DB_ID}" inline="true">표</database>`;
  const DB: ChildTag = { kind: "database", id: DB_ID, title: "표", tag: DB_TAG };

  it("콜아웃 머리 줄에 받은 DB", () => {
    const out = sent(
      "> [!note] ![[table.base|표]] %%im-nobsidian:callout-style:color=orange_bg%%\n\n다음",
    );
    expect(restoreChildTags(out, [DB]).markdown).toBe(
      `<callout color="orange_bg">\n${T}${DB_TAG}\n</callout>\n\n다음`,
    );
  });

  it("토글 본문의 DB", () => {
    const out = sent("> [!toggle]- 토글\n> 설명\n> ![[table.base|표]]\n\n다음");
    expect(restoreChildTags(out, [DB]).markdown).toBe(
      `<details>\n<summary>토글</summary>\n\n설명\n\n${DB_TAG}\n\n</details>\n\n다음`,
    );
  });
});

describe("왕복 — 받은 노트에서도 임베드가 컨테이너 안에 있다", () => {
  it.each([
    ["이미지뿐인 토글", "> [!toggle]- 토글\n> ![[b.pdf]]\n\n다음"],
    ["토글 속 칼럼", COLUMNS_IN_TOGGLE.replace(/\.png/g, ".pdf")],
    ["겹친 콜아웃", "> [!tip] 겹친 콜아웃\n> > [!note] 안쪽\n> > ![[f.pdf]]\n\n다음"],
  ])("%s — 노트 그대로", (_name, note) => {
    expect(roundTrip(note)).toBe(note);
  });

  it("콜아웃 본문 — 앞뒤 줄이 콜아웃에 남고 두 번째부터 고정된다", () => {
    const once = roundTrip("> [!note] 제목\n> 앞 줄\n> ![[a.pdf]]\n> 뒤 줄\n\n다음");
    expect(once).toBe("> [!note] 제목\n> 앞 줄\n> ![[a.pdf]]\n>\n> 뒤 줄\n\n다음");
    expect(roundTrip(once)).toBe(once);
  });
});
