/**
 * push 한 직후 같은 볼트로 받으면 노트를 다시 쓰던 것 — 2026-10-22 실데이터 E2E 에서 1,492 노트를 새 루트로
 * 올리고 그 볼트로 받자 13 노트가 다시 쓰였다. 받은 글이 로컬과 다르지만 push 하면 Notion 에서 같은 자리들이다.
 *
 * - 폴더 노트 끝의 자식 페이지 — 새로 올리면 자식이 페이지 끝에 붙고, 받으면 끝에 `[[자식]]` 줄이 생긴다.
 *   push 는 가리키는 줄이 없는 자식을 본문 끝에 되돌려 놓는다(`restoreChildTags`) — 로컬 노트에 그 줄이
 *   없어도 Notion 에서 같다.
 * - 동기화 블록 참조의 url — 참조를 둔 페이지의 id 가 들어 있어 페이지마다 다르다. push 는 `#블록id` 만 쓴다.
 * - Notion 페이지 링크의 이름 조각 — `notion.so/제목-<id>` 를 보내면 Notion 은 `notion.so/<id>` 로 돌려준다.
 * - Notion 이 거는 자동 링크 — 글 속 `x.md` 를 `[x.md](http://x.md)` 로 돌려준다. 그 링크를 보내도 같다.
 */
import { describe, it, expect } from "vitest";
import { createDefaultPipeline } from "../../src/converter/pipeline-factory.js";
import { notionEnhancedToObsidian } from "../../src/converter/enhanced-md-converter.js";
import { isCompactExport } from "../../src/converter/post-processors/block-spacer.js";
import { extractChildTags } from "../../src/converter/child-tags.js";

const pipeline = createDefaultPipeline();
const PULL = {
  direction: "pull",
  path: "markdown-api",
  filePath: "폴더/폴더.md",
  parentMode: "page",
} as const;

/** Notion 이 내보낸 글을 받는다 — page-puller 처럼 자식 태그를 원시 글에서 모아 넘긴다. */
const pull = (exported: string, local?: string): string =>
  pipeline.convertToMarkdown(notionEnhancedToObsidian(exported), PULL, {
    notionExportCompact: isCompactExport(exported),
    remoteChildren: extractChildTags(exported),
    ...(local === undefined ? {} : { localContent: local }),
  });

const A = "11111111111111111111111111111111";
const B = "22222222222222222222222222222222";
const BLOCK = "33333333333333333333333333333333";
const page = (id: string, title: string) =>
  `<page url="https://www.notion.so/${id}">${title}</page>`;

describe("push 직후 같은 볼트로 받기 — Notion 에서 같은 자리는 로컬 노트 그대로", () => {
  it("본문 끝에 붙은 자식 페이지 — 로컬에 가리키는 줄이 없어도 그대로", () => {
    const local = "폴더 노트 본문\n\n다음 문단\n";
    const exported = `폴더 노트 본문\n다음 문단\n${page(A, "자식 하나")}\n${page(B, "자식 둘")}`;

    expect(pull(exported, local)).toBe(local);
  });

  it("자식이 로컬이 가리키는 자리와 다른 곳에 있으면 받은 글 — push 하면 자식이 옮겨 간다", () => {
    const local = "[[자식 하나]]\n\n폴더 노트 본문\n";
    const exported = `폴더 노트 본문\n${page(A, "자식 하나")}`;

    expect(pull(exported, local)).not.toBe(local);
  });

  it("로컬 노트 없이 받으면 자식 줄은 예전처럼 쓴다", () => {
    expect(pull(`본문\n${page(A, "자식 하나")}`)).toContain("[[자식 하나]]");
  });

  it("동기화 블록 참조 — 참조를 둔 페이지 id 만 다른 url 은 그대로", () => {
    const ref = (pageId: string) =>
      `<synced_block_reference url="https://app.notion.com/p/${pageId}#${BLOCK}">\n\t원본의 글\n</synced_block_reference>`;
    const local = pull(`앞 문단\n${ref(A)}\n뒷 문단`);

    expect(pull(`앞 문단\n${ref(B)}\n뒷 문단`, local)).toBe(local);
  });

  it("동기화 블록 참조 — 원본의 글이 바뀌었으면 받은 글", () => {
    const ref = (text: string) =>
      `<synced_block_reference url="https://app.notion.com/p/${A}#${BLOCK}">\n\t${text}\n</synced_block_reference>`;
    const local = pull(`앞 문단\n${ref("옛 글")}`);

    expect(pull(`앞 문단\n${ref("새 글")}`, local)).toContain("새 글");
  });

  it("Notion 페이지 링크 — 이름 조각 · 워크스페이스 조각이 빠진 url 은 같은 링크", () => {
    const local = `[제목](https://www.notion.so/My-Title-${A}) · [앱](https://www.notion.so/team/APP-${B})\n`;
    const exported = `[제목](https://www.notion.so/${A}) · [앱](https://www.notion.so/${B})`;

    expect(pull(exported, local)).toBe(local);
  });

  it("Notion 블록 링크 — `notion.so/<id>#블록` 이 `app.notion.com/p/<id>#블록` 으로 돌아와도 같은 링크", () => {
    const local = `각주[.](https://www.notion.so/${A}#${BLOCK}) 끝\n`;

    expect(pull(`각주[.](https://app.notion.com/p/${A}#${BLOCK}) 끝`, local)).toBe(local);
  });

  it("Notion 페이지 링크 — 다른 페이지를 가리키면 받은 글", () => {
    const local = `[제목](https://www.notion.so/My-Title-${A})\n`;

    expect(pull(`[제목](https://www.notion.so/${B})`, local)).not.toBe(local);
  });

  it("Notion 이 건 자동 링크 — 글자와 주소가 같은 도메인 꼴이면 그대로", () => {
    const local = "설정은 config.md 와 example.com 을 본다\n";
    const exported =
      "설정은 [config.md](http://config.md) 와 [example.com](https://example.com) 을 본다";

    expect(pull(exported, local)).toBe(local);
  });

  it("점 없는 글에 건 링크는 Notion 이 걸지 않는다 — 받은 글", () => {
    const local = "그냥 foo 라는 글\n";

    expect(pull("그냥 [foo](http://foo) 라는 글", local)).not.toBe(local);
  });
});
