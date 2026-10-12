/**
 * 블록 API 로 받은 본문(A3 · C10) — Markdown API 로 받은 본문과 같은 볼트 모양인지.
 *
 * 블록 폴백의 페이지 멘션은 `[[notion:<id>]]` 로 내려온다. Markdown API 경로처럼 상태 DB 역조회로
 * 제목 위키링크로 되돌아가야, 다음 push 가 같은 멘션을 다시 만든다. 북마크는 받는 페이지의 id 를
 * 자리 주소에 채운다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import type { PagePuller } from "../../src/sync/page-puller.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const BOOKMARK_ID = "3f713b18-d382-81d1-8f3f-d3725bb3dbcf";
const compact = (id: string) => id.replace(/-/g, "");

const PLAIN = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: "default",
};

describe("블록 API 폴백 pull — 볼트 모양", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-block-fallback-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const build = (preferMarkdownApi: boolean): SyncOrchestrator =>
    new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases: [] },
        conversion: { ...DEFAULT_CONFIG.conversion, preferMarkdownApi },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );

  /** 블록 API 가 돌려줄 본문을 정한다. */
  function blocksOf(results: unknown[]): void {
    notion.client.getBlockTree.mockResolvedValue(results);
  }

  it("페이지 멘션은 제목 위키링크 · 날짜 멘션은 짝 마커 · 북마크는 이 페이지의 자리 주소", async () => {
    vault.write("A.md", "가\n");
    vault.write("B.md", "나\n");
    expect(await build(true).push()).toMatchObject({ created: 2, failed: [] });
    const pageA = db.getByPath("A.md")!.notionPageId!;
    const pageB = db.getByPath("B.md")!.notionPageId!;

    blocksOf([
      {
        object: "block",
        id: "blk-1",
        type: "paragraph",
        has_children: false,
        paragraph: {
          rich_text: [
            {
              type: "text",
              text: { content: "보기 ", link: null },
              plain_text: "보기 ",
              href: null,
              annotations: PLAIN,
            },
            {
              type: "mention",
              mention: { type: "page", page: { id: pageB } },
              plain_text: "B",
              href: null,
              annotations: PLAIN,
            },
            {
              type: "text",
              text: { content: " ", link: null },
              plain_text: " ",
              href: null,
              annotations: PLAIN,
            },
            {
              type: "mention",
              mention: { type: "date", date: { start: "2026-09-26" } },
              plain_text: "2026-09-26",
              href: null,
              annotations: PLAIN,
            },
          ],
          color: "default",
        },
      },
      {
        object: "block",
        id: BOOKMARK_ID,
        type: "bookmark",
        has_children: false,
        bookmark: { url: "https://example.com/a", caption: [] },
      },
    ]);
    const orchestrator = build(false) as unknown as {
      puller: PagePuller;
      discovery: { collectInlineDbRefs: (pageId: string, markdown: string) => void };
    };
    const collect = vi.spyOn(orchestrator.discovery, "collectInlineDbRefs");
    const fetched = await orchestrator.puller.fetchPageMarkdown(pageA);
    const { content } = fetched;

    expect(content).toContain("보기 [[B]] %%im-nobsidian:mention-date:start=2026-09-26%%");
    const placeholder = `https://app.notion.com/p/${compact(pageA)}#${compact(BOOKMARK_ID)}`;
    expect(content).toContain(
      `%%im-nobsidian:unknown:id=${encodeURIComponent(placeholder)}&type=bookmark%%`,
    );
    expect(notion.client.getPageMarkdown).not.toHaveBeenCalledWith(pageA);
    // 옮긴 NFM 은 압축형이다 — Markdown API 경로처럼 블록 사이 간격을 다시 맞춘다. 지문은 남기지 않는다.
    expect([fetched.compact, fetched.fingerprint]).toEqual([true, null]);
    // 인라인 DB 수집은 옮긴 NFM 으로 한다 — 본문 속 자식 DB 를 발견하는 유일한 신호다.
    expect(collect).toHaveBeenCalledWith(pageA, expect.stringContaining('alt="bookmark"'));
  });
});
