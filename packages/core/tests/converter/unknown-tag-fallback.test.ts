/**
 * N6 — Notion 이 받지 않는 자리 태그를 볼트에 보이는 모양으로 바꾼다.
 *
 * 자리 태그는 그 페이지에 있는 블록만 가리킬 수 있다. 새 페이지 · 지운 블록 · 다른 페이지의 블록을
 * 가리키면 Notion 이 본문 전체를 거절했다(2026-10-21 실측). 없는 블록의 북마크는 볼트 링크의 주소 ·
 * 캡션으로 새로 만들고, 나머지는 보이는 링크로, 멘션은 뺀다.
 */
import { describe, expect, it } from "vitest";
import { obsidianToNotionEnhanced } from "../../src/converter/enhanced-md-converter.js";
import {
  replaceMissingUnknownTags,
  unknownTagFallbacks,
  unknownTagKeys,
} from "../../src/converter/unknown-tag-fallback.js";

const PAGE = "40013b18d3828172867ee65a5c4ace5e";
const BLOCK_A = "40013b18d38281eb8e0ce29a40a3f12c";
const BLOCK_B = "40013b18d3828129b5fed3bfecd776db";
const placeholder = (block: string, page = PAGE) => `https://app.notion.com/p/${page}#${block}`;
const marker = (url: string, type: string) =>
  `%%im-nobsidian:unknown:id=${encodeURIComponent(url)}&type=${type}%%`;
const tag = (url: string, type: string) => `<unknown url="${url}" alt="${type}"/>`;

/** 볼트 노트를 push 본문으로 바꾸고, 그 페이지에 `present` 블록만 있을 때 보낼 본문. */
function sendable(vault: string, present: string[] = []): string {
  return replaceMissingUnknownTags(
    obsidianToNotionEnhanced(vault),
    new Set(present),
    unknownTagFallbacks(vault),
  ).nfm;
}

describe("unknownTagFallbacks · replaceMissingUnknownTags (N6)", () => {
  it("없는 블록의 북마크는 볼트 링크의 주소 · 캡션으로 새 북마크", () => {
    const vault = `앞\n[🔖 예시 사이트](https://example.org/a)${marker(placeholder(BLOCK_A), "bookmark")}\n`;
    expect(sendable(vault)).toBe(
      `앞\n<bookmark url="https://example.org/a">예시 사이트</bookmark>\n`,
    );
  });

  it("그 페이지에 있는 블록의 태그는 그대로 — Notion 이 그 블록을 남긴다", () => {
    const vault = `[🔖 예시](https://example.org/a)${marker(placeholder(BLOCK_A), "bookmark")}\n`;
    expect(sendable(vault, [BLOCK_A])).toBe(`${tag(placeholder(BLOCK_A), "bookmark")}\n`);
  });

  it("블록은 ID 로 맞춘다 — 자리 주소의 페이지 칸 모양과 무관", () => {
    const remote = `${tag(placeholder(BLOCK_A, BLOCK_A), "bookmark")}\n`;
    const vault = `[🔖 예시](https://example.org/a)${marker(placeholder(BLOCK_A), "bookmark")}\n`;
    expect(sendable(vault, [...unknownTagKeys(remote)])).toBe(
      `${tag(placeholder(BLOCK_A), "bookmark")}\n`,
    );
  });

  it("캡션 없는 북마크는 빈 캡션 · 주소의 따옴표 · & 는 속성 escape · 괄호는 풀어서", () => {
    const vault =
      `[🔖 https://example.org/q?a=1&b="2"](https://example.org/q?a=1&b="2")` +
      `${marker(placeholder(BLOCK_A), "bookmark")}\n` +
      `[🔖 괄호](https://example.org/x_%28y%29)${marker(placeholder(BLOCK_B), "bookmark")}\n`;
    expect(sendable(vault)).toBe(
      `<bookmark url="https://example.org/q?a=1&amp;b=&quot;2&quot;"></bookmark>\n` +
        `<bookmark url="https://example.org/x_(y)">괄호</bookmark>\n`,
    );
  });

  it("캡션의 마크다운 글자는 escape — Notion 이 캡션을 마크다운으로 읽는다", () => {
    const vault = `[🔖 a \\[b\\] *c* _d_ $e$ <f>](https://example.org/a)${marker(placeholder(BLOCK_A), "bookmark")}\n`;
    expect(sendable(vault)).toBe(
      `<bookmark url="https://example.org/a">a \\[b\\] \\*c\\* \\_d\\_ \\$e\\$ \\<f\\></bookmark>\n`,
    );
  });

  it("원래 주소를 모르는 북마크 · 다른 블록은 보이는 링크", () => {
    const unknownBookmark = placeholder(BLOCK_A);
    const vault =
      `[🔖 Bookmark](${unknownBookmark})${marker(unknownBookmark, "bookmark")}\n` +
      `[🔗 link_preview](${placeholder(BLOCK_B)})${marker(placeholder(BLOCK_B), "link_preview")}\n`;
    expect(sendable(vault)).toBe(
      `[🔖 Bookmark](${unknownBookmark})\n[🔗 link_preview](${placeholder(BLOCK_B)})\n`,
    );
  });

  it("목록 안 북마크는 들여쓰기 그대로 — 그 항목의 자식이 된다", () => {
    const vault = `- 항목\n\t[🔖 안](https://example.org/a)${marker(placeholder(BLOCK_A), "bookmark")}\n`;
    expect(sendable(vault)).toBe(`- 항목\n\t<bookmark url="https://example.org/a">안</bookmark>\n`);
  });

  it("볼트에 짝이 없는 태그 · 없는 멘션은 뺀다", () => {
    const nfm = `앞 <unknown_mention url="notion://custom_emoji/a/b" alt="custom_emoji"/> 뒤\n${tag(placeholder(BLOCK_A), "bookmark")}\n`;
    expect(replaceMissingUnknownTags(nfm, new Set(), new Map())).toEqual({
      nfm: "앞  뒤\n\n",
      replaced: 2,
    });
  });

  it("그 페이지에 있는 멘션은 그대로", () => {
    const mention = `<unknown_mention url="notion://custom_emoji/a/b" alt="custom_emoji"/>`;
    const nfm = `앞 ${mention} 뒤\n`;
    expect(replaceMissingUnknownTags(nfm, unknownTagKeys(nfm), new Map())).toEqual({
      nfm,
      replaced: 0,
    });
  });

  it("코드 안의 태그는 건드리지 않는다", () => {
    const nfm = "```html\n" + tag(placeholder(BLOCK_A), "bookmark") + "\n```\n";
    expect(replaceMissingUnknownTags(nfm, new Set(), new Map())).toEqual({ nfm, replaced: 0 });
    expect(unknownTagKeys(nfm).size).toBe(0);
  });

  it("옛 `<unknown id>` 자리도 같은 길 — 보이는 링크가 없으면 뺀다", () => {
    const vault = `앞\n%%im-nobsidian:unknown:id=abc123&type=synced_block%%\n`;
    const nfm = obsidianToNotionEnhanced(vault);
    expect(nfm).toContain(`<unknown id="abc123"`);
    expect(sendable(vault)).toBe("앞\n\n");
    expect(sendable(vault, ["id:abc123"])).toBe(nfm);
  });
});
