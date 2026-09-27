/**
 * S-03 — 자식 페이지 · 자식 DB 가 있는 페이지의 본문을 통째로 바꿀 때, Notion 이 준 자식
 * 태그를 push 본문의 «그 자식을 가리키던 줄» 에 되돌려 놓는지.
 *
 * 실측(2026-09-27): `replace_content` 에 받은 `<page>` · `<database>` 태그를 넣으면 자식이
 * 같은 id 로 남고, 태그를 옮기면 자식도 옮겨 간다. 태그가 빠지면 삭제 불허 요청은 거절된다.
 */
import { describe, it, expect } from "vitest";
import {
  baseEmbedPaths,
  extractChildTags,
  restoreChildTags,
  type ChildTag,
} from "../../src/converter/child-tags.js";
import { encodeMarkerTarget } from "../../src/converter/marker-url.js";

const PAGE_ID = "3e813b18d38281a3a1f2c3d4e5f60eb0";
const DB_ID = "060db215aaaa4bbbbcccc1234567d466";
const PAGE_TAG = `<page url="https://app.notion.com/p/${PAGE_ID}">S03 자식 페이지</page>`;
const DB_TAG = `<database url="https://app.notion.com/p/${DB_ID}" inline="true" data-source-url="collection://16a332b6-0000-4000-8000-00000000dabd">S03 자식 DB</database>`;

const PAGE: ChildTag = { kind: "page", id: PAGE_ID, title: "S03 자식 페이지", tag: PAGE_TAG };
const DB: ChildTag = { kind: "database", id: DB_ID, title: "S03 자식 DB", tag: DB_TAG };

const mention = (id: string) => `<mention-page url="https://www.notion.so/${id}"/>`;
const basePlaceholder = (target: string) =>
  `> 📎 ${target.split("|")[0]!.split("/").pop()} %% im-nobsidian:local-file:${encodeMarkerTarget(target)} %%`;

describe("extractChildTags — Notion 이 준 본문의 자식 태그", () => {
  it("페이지 · DB 태그를 나온 순서대로, id 는 하이픈 없는 32자리로", () => {
    const md = `첫 문단\n${DB_TAG}\n둘째 문단\n${PAGE_TAG}\n`;
    expect(extractChildTags(md)).toEqual([DB, PAGE]);
  });

  it("www.notion.so 호스트도 같은 id 로 읽는다", () => {
    const md = `<page url="https://www.notion.so/${PAGE_ID}">제목</page>`;
    expect(extractChildTags(md)[0]?.id).toBe(PAGE_ID);
  });

  it("같은 자식이 두 번 나오면 한 번만", () => {
    expect(extractChildTags(`${PAGE_TAG}\n${PAGE_TAG}`)).toHaveLength(1);
  });

  it("url 에 id 가 없는 태그는 자식으로 세지 않는다", () => {
    expect(extractChildTags(`<database inline="true">이름뿐</database>`)).toEqual([]);
  });
});

describe("restoreChildTags — 자식을 가리키던 줄에 태그를 되돌린다", () => {
  it("자식이 없으면 본문을 그대로 돌려준다", () => {
    const md = "본문\n\n[[아무개]]\n";
    expect(restoreChildTags(md, [])).toEqual({ markdown: md, placed: 0, appended: [] });
  });

  it("해석된 [[자식]] 의 멘션 줄 → 페이지 태그 (같은 자리)", () => {
    const md = `첫 문단\n\n${mention(PAGE_ID)}\n\n끝 문단\n`;
    const r = restoreChildTags(md, [PAGE]);
    expect(r.markdown).toBe(`첫 문단\n\n${PAGE_TAG}\n\n끝 문단\n`);
    expect(r).toMatchObject({ placed: 1, appended: [] });
  });

  it("콜아웃 안(탭 들여쓰기)과 인용 안의 멘션은 접두사를 지킨다", () => {
    const md = `<callout icon="📝">\n\t콜아웃\n\t${mention(PAGE_ID)}\n</callout>\n`;
    expect(restoreChildTags(md, [PAGE]).markdown).toContain(`\t${PAGE_TAG}\n</callout>`);
    expect(restoreChildTags(`> ${mention(PAGE_ID)}\n`, [PAGE]).markdown).toBe(`> ${PAGE_TAG}\n`);
  });

  it("해석되지 못한 [[제목]] · [[폴더/제목|별칭]] 은 제목으로 맞춘다 (굵게 · 대소문자 무시)", () => {
    const bold: ChildTag = { ...PAGE, title: "**S03 자식 페이지**" };
    expect(restoreChildTags("[[S03 자식 페이지]]\n", [bold]).markdown).toBe(`${PAGE_TAG}\n`);
    expect(restoreChildTags("[[폴더/s03 자식 페이지.md|딴 이름]]\n", [PAGE]).markdown).toBe(
      `${PAGE_TAG}\n`,
    );
  });

  it(".base 임베드 자리표시자 → DB 태그, 자리표시자의 `>` 는 남기지 않고 들여쓰기는 지킨다", () => {
    const md = `본문\n\n${basePlaceholder("폴더/S03-자식-DB/S03 자식 DB.base|S03 자식 DB")}\n`;
    expect(restoreChildTags(md, [DB]).markdown).toBe(`본문\n\n${DB_TAG}\n`);
    const indented = `\t${basePlaceholder("S03 자식 DB.base")}\n`;
    expect(restoreChildTags(indented, [DB]).markdown).toBe(`\t${DB_TAG}\n`);
  });

  it(".base 는 DB id 로 먼저 맞춘다 — 제목이 빈 링크드 뷰도 제자리", () => {
    const linked: ChildTag = { ...DB, title: "", tag: DB_TAG.replace("S03 자식 DB<", "<") };
    const md = `${basePlaceholder("폴더/원본 DB.base|원본 DB")}\n`;
    const r = restoreChildTags(md, [linked], {
      databaseIdsOfBase: (p) =>
        p === "폴더/원본 DB.base" ? ["060db215-aaaa-4bbb-bccc-c1234567d466"] : [],
    });
    expect(r.markdown).toBe(`${linked.tag}\n`);
    expect(r.appended).toEqual([]);
  });

  it(".base 가 아닌 첨부(같은 이름의 pdf)는 DB 로 보지 않는다", () => {
    const md = `${basePlaceholder("S03 자식 DB.pdf")}\n`;
    const r = restoreChildTags(md, [DB]);
    expect(r.markdown.startsWith(md.trimEnd())).toBe(true);
    expect(r.appended).toEqual([DB]);
  });

  it("`.base` 를 못 만든 DB 자리표시(`**제목** *(Notion DB)*` + 마커) → DB 태그", () => {
    const md = `**S03 자식 DB** *(Notion DB)*%%im-nobsidian:child-database:id=${DB_ID}&title=S03%20%EC%9E%90%EC%8B%9D%20DB%%\n`;
    expect(restoreChildTags(md, [DB]).markdown).toBe(`${DB_TAG}\n`);
  });

  it("문장 속 링크 · 목록 항목은 자식 자리가 아니다 — 가리키는 줄이 없으면 끝에 덧붙인다", () => {
    const md = `문장 속 ${mention(PAGE_ID)} 멘션.\n\n- [[S03 자식 페이지]]\n`;
    const r = restoreChildTags(md, [PAGE, DB]);
    expect(r.markdown).toBe(`${md.trimEnd()}\n\n${PAGE_TAG}\n\n${DB_TAG}\n`);
    expect(r).toMatchObject({ placed: 0, appended: [PAGE, DB] });
  });

  it("코드 블록 안은 보지 않는다", () => {
    const md = "```md\n[[S03 자식 페이지]]\n```\n";
    const r = restoreChildTags(md, [PAGE]);
    expect(r.markdown).toBe(`${md.trimEnd()}\n\n${PAGE_TAG}\n`);
  });

  it("한 자식은 먼저 나온 한 줄에만 — 두 번째 줄은 그대로 둔다", () => {
    const md = `[[S03 자식 페이지]]\n\n[[S03 자식 페이지]]\n`;
    expect(restoreChildTags(md, [PAGE]).markdown).toBe(`${PAGE_TAG}\n\n[[S03 자식 페이지]]\n`);
  });

  it("이미 태그인 줄은 그 자식으로 세고 겹쳐 싣지 않는다", () => {
    const r = restoreChildTags(`${PAGE_TAG}\n`, [PAGE]);
    expect(r).toEqual({ markdown: `${PAGE_TAG}\n`, placed: 1, appended: [] });
  });
});

describe("baseEmbedPaths — 다시 보낼 때 DB id 를 찾아볼 .base 경로", () => {
  it(".base 자리표시자의 경로만, 별칭은 떼고 한 번씩", () => {
    const md = [
      basePlaceholder("폴더/가.base|가"),
      basePlaceholder("폴더/가.base"),
      basePlaceholder("사진.pdf"),
    ].join("\n\n");
    expect(baseEmbedPaths(md)).toEqual(["폴더/가.base"]);
  });
});
