/**
 * 파일 이름에 쓸 수 없는 글자가 든 자식 페이지 제목 — `a / b` 의 노트는 `a _ b.md` 인데 받기가 `[[a / b]]` 를 써
 * Obsidian 이 `a ` 폴더의 ` b` 노트를 가리키는 끊긴 링크가 됐다(2026-10-22 실데이터 왕복). push 도 그 줄을 자식으로
 * 알아보지 못해 자식을 본문 끝으로 옮기고 그 자리에 글 링크를 남겼다.
 *
 * 받기는 그런 자식을 id 로 남겨(`[[notion:<id>|제목]]`) 링크 패스가 실제 노트로 풀게 하고, push 는 줄 하나를 통째로
 * 차지한 그 자식의 Notion 링크를 자식 자리로 본다.
 */
import { describe, it, expect } from "vitest";
import { notionEnhancedToObsidian } from "../../src/converter/enhanced-md-converter.js";
import { resolveNotionIdWikilinks } from "../../src/converter/notion-id-links.js";
import { restoreChildTags, type ChildTag } from "../../src/converter/child-tags.js";

const ID = "3e813b18d38281a3a1f2c3d4e5f60eb0";
const tag = (title: string) => `<page url="https://www.notion.so/${ID}">${title}</page>`;
const child = (title: string): ChildTag => ({ kind: "page", id: ID, title, tag: tag(title) });

describe("받기 — 파일 이름이 될 수 없는 자식 제목", () => {
  it("id 로 남겼다가 실제 노트로 푼다", () => {
    const pulled = notionEnhancedToObsidian(`앞\n${tag("a / b")}`);

    expect(pulled).toBe(`앞\n[[notion:${ID}|a / b]]`);
    expect(resolveNotionIdWikilinks(pulled, () => "폴더/a _ b.md").markdown).toBe(
      "앞\n[[a _ b|a / b]]",
    );
  });

  it("대괄호는 별칭에서 괄호로 — 링크가 첫 `]]` 에서 끊기지 않게", () => {
    // Notion 은 태그 속 대괄호를 escape 해서 준다.
    expect(notionEnhancedToObsidian(tag("Attention \\[2017\\]"))).toBe(
      `[[notion:${ID}|Attention (2017)]]`,
    );
  });

  it("파일 이름이 되는 제목은 예전처럼 `[[제목]]`", () => {
    expect(notionEnhancedToObsidian(tag("자식 하나"))).toBe("[[자식 하나]]");
  });
});

describe("push — 자식의 Notion 링크 줄을 자식 자리로", () => {
  it("줄 하나를 차지한 자식 링크를 태그로 되돌린다", () => {
    const out = restoreChildTags(`앞\n\n[a / b](https://www.notion.so/${ID})\n\n뒤`, [
      child("a / b"),
    ]);

    expect(out.markdown).toBe(`앞\n\n${tag("a / b")}\n\n뒤`);
    expect(out.appended).toEqual([]);
  });

  it("문장 속 링크는 자식 자리가 아니다", () => {
    const out = restoreChildTags(`보라 [a / b](https://www.notion.so/${ID}) 를`, [child("a / b")]);

    expect(out.appended).toHaveLength(1);
  });
});
