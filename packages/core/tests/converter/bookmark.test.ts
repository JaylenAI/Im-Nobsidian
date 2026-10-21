/**
 * F-09 — 북마크가 볼트에서 원래 주소 대신 Notion 블록 링크(「🔖 Bookmark」)로 보이던 결함.
 *
 * Markdown API 는 북마크를 주소 · 캡션 없는 자리 태그로만 보낸다(실측 2026-10-04). 받을 때 블록을 읽어
 * 가시 링크에 주소와 캡션을 넣고, 왕복은 뒤따르는 마커가 맡는다 — push 는 받은 태그를 그대로 돌려보낸다.
 */
import { describe, it, expect } from "vitest";
import { bookmarkBlockId, bookmarkBlockIds, vaultBookmarks } from "../../src/converter/bookmark.js";
import {
  notionEnhancedToObsidian,
  obsidianToNotionEnhanced,
} from "../../src/converter/enhanced-md-converter.js";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";
import type { BookmarkTarget } from "../../src/types/convert.js";

const PAGE = "3ef13b1800004000800000000000a6df";
const A = "3ef13b1800014000800000000071c0e0";
const B = "3ef13b180002400080000000008eb1a0";
const tagUrl = (block: string) => `https://app.notion.com/p/${PAGE}#${block}`;
const tag = (block: string) => `<unknown url="${tagUrl(block)}" alt="bookmark"/>`;
const marker = (block: string) =>
  `%%im-nobsidian:unknown:id=${encodeURIComponent(tagUrl(block))}&type=bookmark%%`;

const PULL = { direction: "pull", path: "markdown-api", filePath: "a.md" } as const;
const PUSH = { direction: "push", path: "markdown-api", filePath: "a.md" } as const;

/** 받아 볼트에 쓰는 글 — 변환기 뒤 후처리기까지. */
const pull = (nfm: string, bookmarks?: ReadonlyMap<string, BookmarkTarget>): string =>
  createDefaultPipeline().convertToMarkdown(notionEnhancedToObsidian(nfm, { bookmarks }), PULL);
/** push 가 Notion 에 보내는 글. */
const push = (note: string): string =>
  obsidianToNotionEnhanced(createDefaultPipeline().convertToNotion(note, PUSH).content);

const targets = (entries: Array<[string, string, string?]>) =>
  new Map(entries.map(([id, url, caption]) => [id, { url, caption: caption ?? "" }]));

describe("bookmarkBlockIds — 읽을 북마크 블록", () => {
  it("북마크 자리 태그의 블록 ID 를 한 번씩 — 하이픈 없이", () => {
    const hyphened = `${B.slice(0, 8)}-${B.slice(8, 12)}-${B.slice(12, 16)}-${B.slice(16, 20)}-${B.slice(20)}`;
    const nfm = [tag(A), `\t${tag(A)}`, `<unknown url="${tagUrl(hyphened)}" alt="bookmark"/>`].join(
      "\n",
    );
    expect(bookmarkBlockIds(nfm)).toEqual([A, B]);
  });

  it("코드 안 · 다른 블록 · 잘린 블록(alt 없음)의 태그는 읽지 않는다", () => {
    const nfm = [
      "```md",
      tag(A),
      "```",
      `<unknown url="${tagUrl(B)}" alt="embed"/>`,
      `<unknown url="${tagUrl(B)}"/>`,
    ].join("\n");
    expect(bookmarkBlockIds(nfm)).toEqual([]);
  });

  it("블록을 가리키지 않는 url 은 ID 가 없다", () => {
    expect(bookmarkBlockId("https://example.com/a#frag")).toBeUndefined();
    expect(bookmarkBlockId(tagUrl(A))).toBe(A);
  });
});

describe("받기 — 가시 링크에 북마크의 주소와 캡션", () => {
  it("캡션이 없으면 주소가 이름이고, 목적지의 괄호는 인코딩한다", () => {
    const url = "https://example.com/a(b)c?x=1&y=2#frag";
    expect(pull(tag(A), targets([[A, url]]))).toBe(
      `[🔖 ${url}](https://example.com/a%28b%29c?x=1&y=2#frag)${marker(A)}`,
    );
  });

  it("캡션이 있으면 캡션이 이름 — 대괄호 · 백틱은 escape, 줄바꿈은 펴고, `%%` 는 줄인다", () => {
    const caption = "[PDF] `a]b`\n논문 %%x%%";
    expect(pull(tag(A), targets([[A, "https://arxiv.org/abs/1706.03762", caption]]))).toBe(
      `[🔖 \\[PDF\\] \\\`a\\]b\\\` 논문 %x%](https://arxiv.org/abs/1706.03762)${marker(A)}`,
    );
  });

  it("블록을 읽지 못한 북마크는 Notion 의 블록을 가리키는 링크로 남는다", () => {
    expect(pull(`${tag(A)}\n\n${tag(B)}`, targets([[B, "https://example.org/"]]))).toBe(
      `[🔖 Bookmark](${tagUrl(A)})${marker(A)}\n\n[🔖 https://example.org/](https://example.org/)${marker(B)}`,
    );
  });

  it("Notion 주소를 북마크해도 위키링크로 바뀌지 않는다", () => {
    const url = "https://www.notion.so/0123456789abcdef0123456789abcdef";
    expect(pull(tag(A), targets([[A, url]]))).toBe(`[🔖 ${url}](${url})${marker(A)}`);
  });

  it("목록 · 토글 안 북마크도 같은 깊이에서 바뀐다", () => {
    const nfm = `- 항목\n\t${tag(A)}\n<details>\n<summary>토글</summary>\n\t${tag(B)}\n</details>`;
    const note = pull(
      nfm,
      targets([
        [A, "https://example.net/in-list"],
        [B, "https://example.org/nested"],
      ]),
    );
    expect(note).toContain(
      `- 항목\n    [🔖 https://example.net/in-list](https://example.net/in-list)${marker(A)}`,
    );
    expect(note).toContain(
      `> [!toggle]- 토글\n> [🔖 https://example.org/nested](https://example.org/nested)${marker(B)}`,
    );
  });
});

describe("다시 보내기 — 받은 태그 그대로", () => {
  it("주소 · 캡션을 넣은 가시 링크는 마커와 함께 버려진다", () => {
    const nfm = `앞\n\n${tag(A)}\n\n${tag(B)}\n\n뒤`;
    const note = pull(
      nfm,
      targets([
        [A, "https://example.com/a(b)c"],
        [B, "https://arxiv.org/abs/1706.03762", "[PDF] `a]b` %%x%%"],
      ]),
    );
    expect(push(note)).toBe(nfm);
  });

  it("목록 안 북마크도 항목의 자식 태그로 돌아간다", () => {
    const note = pull(`- 항목\n\t${tag(A)}`, targets([[A, "https://example.net/", "목록 [안]"]]));
    // 목록의 자식 줄은 네 칸으로 보낸다 — 북마크와 무관한 push 의 들여쓰기다.
    expect(push(note)).toBe(`- 항목\n    ${tag(A)}`);
  });

  it("예전에 받은 「🔖 Bookmark」 링크도 그대로 태그로 돌아간다", () => {
    const old = `[🔖 Bookmark](${tagUrl(A)})${marker(A)}`;
    expect(push(old)).toBe(tag(A));
  });
});

describe("vaultBookmarks — 블록 방식 push 가 북마크를 새로 만들 주소", () => {
  it("받은 노트의 북마크 링크를 자리 주소 → 주소 · 캡션으로 — 괄호도 원래대로", () => {
    const note = pull(
      `${tag(A)}\n\n- 항목\n\t${tag(B)}`,
      targets([
        [A, "https://example.com/a(b)c", "캡션 [안]"],
        [B, "https://example.net/"],
      ]),
    );
    expect(vaultBookmarks(note)).toEqual(
      new Map([
        [tagUrl(A), { url: "https://example.com/a(b)c", caption: "캡션 [안]" }],
        [tagUrl(B), { url: "https://example.net/", caption: "" }],
      ]),
    );
  });

  it("주소를 모르는 「🔖 Bookmark」 링크와 코드 속 링크는 뺀다", () => {
    const old = `[🔖 Bookmark](${tagUrl(A)})${marker(A)}`;
    const fenced = "```\n[🔖 x](https://example.com/x)" + marker(B) + "\n```";
    expect(vaultBookmarks(`${old}\n\n${fenced}`).size).toBe(0);
  });
});

describe("받아 둔 노트의 북마크 링크 — 로컬 표기 유지와 함께(B14)", () => {
  /** 받기 직전의 로컬 노트를 알고 받는다 — 로컬 표기 유지(`local-form.ts`)가 돈다. */
  const repull = (nfm: string, local: string, bookmarks?: ReadonlyMap<string, BookmarkTarget>) =>
    createDefaultPipeline().convertToMarkdown(notionEnhancedToObsidian(nfm, { bookmarks }), PULL, {
      localContent: local,
    });
  const oldLink = `[🔖 Bookmark](${tagUrl(A)})${marker(A)}`;
  const readLink = `[🔖 예시](https://example.com/)${marker(A)}`;

  it("옛 링크(Notion 블록 주소)는 북마크를 읽어 받으면 새 링크가 된다", () => {
    const nfm = `글\n${tag(A)}`;
    const local = `글\n\n${oldLink}\n`;
    expect(repull(nfm, local, targets([[A, "https://example.com/", "예시"]]))).toBe(
      `글\n\n${readLink}\n`,
    );
  });

  it("Notion 에서 캡션이 바뀌면 받은 캡션이 이긴다", () => {
    const local = `글\n\n${readLink}\n`;
    expect(
      repull(`글\n${tag(A)}`, local, targets([[A, "https://example.com/", "새 캡션"]])),
    ).toContain("[🔖 새 캡션](https://example.com/)");
  });

  it("이번에 블록을 읽지 못했으면 볼트의 링크를 지킨다", () => {
    const local = `글\n\n${readLink}\n`;
    expect(repull(`글\n${tag(A)}`, local)).toBe(local);
  });

  it("다른 줄의 로컬 표기는 그대로 지킨다", () => {
    const local = `> [!faq]- 질문\n> 답\n\n${oldLink}\n`;
    const nfm = `<callout icon="❓">\n\t질문\n\t답\n</callout>\n${tag(A)}`;
    expect(repull(nfm, local, targets([[A, "https://example.com/", "예시"]]))).toBe(
      `> [!faq]- 질문\n> 답\n\n${readLink}\n`,
    );
  });
});
