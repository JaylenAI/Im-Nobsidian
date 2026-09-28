/**
 * S-21 — 달러 기호 · 블록 수식이 push · pull 을 거쳐 노트 그대로 남는지 끝까지 돌린다.
 *
 * push 의 수식 정규화가 코드 안의 `$` 와 수식이 아닌 달러까지 고쳐, Notion 의 코드가 바뀌고
 * 글이 수식이 되었다(`$ echo $HOME` → `$echo$HOME`, `$5 and $10` → `$5 and$10`). 콜아웃 안 블록
 * 수식은 닫는 `$$` 가 콜아웃 밖으로 나가 Notion 이 뒤 문단을 수식으로 삼켰다. 이제 push 는 코드
 * 밖의 블록 수식만 줄머리째 제 줄에 세운다.
 *
 * 실제 StateDB(임시 파일) · 메모리 볼트 · 메모리 Notion 으로, 처음 push 가 만든 레코드를 그대로
 * 이어 쓴다(list-code-roundtrip 과 같은 하니스).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

/** Obsidian 에서 쓴 노트 — 수식 · 수식이 아닌 달러 · 코드 안의 달러. */
const NOTE = [
  "인라인 $E = mc^2$ 수식",
  "",
  "공백 $ x $ 달러",
  "",
  "가격 $5 and $10 이다",
  "",
  "금액 $1,000 ~ $2,000",
  "",
  "실행 `$ echo $HOME` 끝",
  "",
  "```bash",
  "$ echo $HOME",
  "echo $$",
  "x=$(( $a + $b ))",
  "```",
  "",
  "$$",
  "\\int_0^1 x dx",
  "$$",
  "",
].join("\n");

/**
 * 같은 노트를 Notion 이 내보내는 모양 — 수식은 `$`백틱, 글의 달러 · 물결은 이스케이프, 블록 사이 빈
 * 줄 없음(실측, 프로브 `__qa_probe_s21_math`).
 */
const NOTION_EXPORT = [
  "인라인 $`E = mc^2`$ 수식",
  "공백 \\$ x \\$ 달러",
  "가격 \\$5 and \\$10 이다",
  "금액 \\$1,000 \\~ \\$2,000",
  "실행 `$ echo $HOME` 끝",
  "```bash",
  "$ echo $HOME",
  "echo $$",
  "x=$(( $a + $b ))",
  "```",
  "$$",
  "\\int_0^1 x dx",
  "$$",
].join("\n");

/** 콜아웃 · 목록 안 블록 수식 — 첫 콜아웃은 실볼트 노트 4장의 모양이다(Notion 에서 받은 것). */
const CONTAINER_NOTE = [
  "> [!note] $$",
  "> \\textbf{A}",
  "> $$",
  "",
  "뒤 문단",
  "",
  "> [!note] 제목",
  "> $$",
  "> x^2",
  "> $$",
  "",
  "- 항목",
  "    $$",
  "    y^2",
  "    $$",
  "",
].join("\n");

/** 올리는 본문 — Notion 은 콜아웃 · 목록 항목의 자식 수식 블록으로 읽는다(실측, 프로브 s21b). */
const CONTAINER_PUSHED = [
  '<callout icon="📝">',
  "\t$$",
  "\t\\textbf{A}",
  "\t$$",
  "</callout>",
  "",
  "뒤 문단",
  "",
  '<callout icon="📝">',
  "\t제목",
  "\t$$",
  "\tx^2",
  "\t$$",
  "</callout>",
  "",
  "- 항목",
  "    $$",
  "    y^2",
  "    $$",
].join("\n");

/** 같은 구조를 Notion 이 내보내는 모양 — 목록 자식 수식은 `$$` · 식 줄 모두 탭이다(실측, 프로브 s21b). */
const CONTAINER_EXPORT = [
  '<callout icon="📝">',
  "\t$$",
  "\t\\textbf{A}",
  "\t$$",
  "</callout>",
  "뒤 문단",
  '<callout icon="📝">',
  "\t제목",
  "\t$$",
  "\tx^2",
  "\t$$",
  "</callout>",
  "- 항목",
  "\t$$",
  "\ty^2",
  "\t$$",
].join("\n");

/** 노트 한 장을 처음 push 한 하니스. */
function harness(note: string) {
  const state = {} as {
    tempDir: string;
    db: StateDB;
    vault: MemoryVault;
    notion: ReturnType<typeof memoryNotion>;
    orchestrator: SyncOrchestrator;
    pageId: string;
  };

  beforeEach(async () => {
    state.tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-math-"));
    state.db = StateDB.open(join(state.tempDir, "state.db"));
    state.vault = new MemoryVault();
    state.notion = memoryNotion();
    state.orchestrator = new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases: [] },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      state.db,
      state.notion.client as never,
      state.vault.fs(),
    );
    state.vault.write("Note.md", note);
    expect(await state.orchestrator.push()).toMatchObject({ created: 1, failed: [] });
    state.pageId = state.db.getByPath("Note.md")!.notionPageId!;
  });

  afterEach(async () => {
    state.db.close();
    await rm(state.tempDir, { recursive: true, force: true });
  });

  return {
    state,
    body: (): string => state.notion.pages.get(state.pageId)!.body,
    /** Notion 본문을 `markdown` 으로 바꾼 뒤 받는다. */
    pullRemote: async (markdown: string) => {
      state.notion.edit(state.pageId, (page) => {
        page.body = markdown;
      });
      return state.orchestrator.pull();
    },
    /** 받은 노트를 다시 올릴 때 Notion 본문을 갈아 끼우지 않는가. */
    repushIsNoop: async () => {
      state.notion.client.replacePageMarkdown.mockClear();
      expect(await state.orchestrator.push()).toMatchObject({
        created: 0,
        updated: 0,
        failed: [],
      });
      expect(state.notion.client.replacePageMarkdown).not.toHaveBeenCalled();
    },
  };
}

describe("달러 기호 왕복(S-21)", () => {
  const h = harness(NOTE);

  it("올리는 본문은 노트 그대로다 — 코드 · 수식이 아닌 달러를 고치지 않는다", () => {
    expect(h.body().trimEnd()).toBe(NOTE.trimEnd());
  });

  it("Notion 이 내보낸 모양으로 받아도 고친 줄 말고는 노트 그대로다", async () => {
    expect(
      await h.pullRemote(NOTION_EXPORT.replace("수식", "수식 — Notion 에서 고침")),
    ).toMatchObject({ updated: 1, failed: [] });

    // 끝 줄바꿈은 pull 이 붙이지 않는다(따로 다룸) — 여기서는 보지 않는다.
    expect(h.state.vault.read("Note.md")?.trimEnd()).toBe(
      NOTE.replace("수식", "수식 — Notion 에서 고침").trimEnd(),
    );
  });

  it("받은 노트를 다시 올려도 Notion 본문은 그대로다", async () => {
    await h.pullRemote(NOTION_EXPORT);
    await h.repushIsNoop();
  });
});

describe("콜아웃 · 목록 안 블록 수식 왕복(S-21)", () => {
  const h = harness(CONTAINER_NOTE);

  it("수식이 콜아웃 · 목록 항목 안에 남는 본문을 올린다 — 닫는 $$ 가 밖으로 나가지 않는다", () => {
    expect(h.body().trimEnd()).toBe(CONTAINER_PUSHED);
  });

  it("Notion 이 내보낸 모양으로 받아도 고친 줄 말고는 노트 그대로다", async () => {
    const edited = (text: string) => text.replace("뒤 문단", "뒤 문단 — Notion 에서 고침");
    expect(await h.pullRemote(edited(CONTAINER_EXPORT))).toMatchObject({ updated: 1, failed: [] });

    expect(h.state.vault.read("Note.md")?.trimEnd()).toBe(edited(CONTAINER_NOTE).trimEnd());
  });

  it("받은 노트를 다시 올려도 Notion 본문은 그대로다", async () => {
    await h.pullRemote(CONTAINER_EXPORT);
    await h.repushIsNoop();
  });
});
