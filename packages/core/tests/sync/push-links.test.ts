/**
 * Phase 3 — push 의 링크 두 가지 (N6 · N8), 오케스트레이터 배선 수준.
 *
 * N6: 볼트의 북마크 링크가 그 페이지에 없는 블록을 가리키면 Notion 이 본문 전체를 거절해 그 노트의 push 가
 * 통째로 실패했다(새 페이지 · 복사한 노트 · Notion 에서 지운 북마크). 메모리 Notion 이 실측한 거절을 흉내 낸다.
 *
 * N8: 같은 push 에서 뒤에 만드는 노트로 가는 `[[위키링크]]` 는 멘션 대신 글 링크로 올라가고, 노트를
 * 고치기 전까지 그대로였다.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { unknownTagKeys } from "../../src/converter/unknown-tag-fallback.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

const OTHER_PAGE = "40013b18d3828172867ee65a5c4ace5e";
const OTHER_BLOCK = "40013b18d38281eb8e0ce29a40a3f12c";
const placeholder = (page: string, block: string) => `https://app.notion.com/p/${page}#${block}`;
const bookmarkPair = (url: string, caption: string, at: string) =>
  `[🔖 ${caption}](${url})%%im-nobsidian:unknown:id=${encodeURIComponent(at)}&type=bookmark%%`;

function validationError(message: string): Error {
  return Object.assign(new Error(message), { code: "validation_error", status: 400 });
}

describe("push 의 링크 (Phase 3)", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let notion: ReturnType<typeof memoryNotion>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-push-links-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    notion = memoryNotion();
    rejectUnknownTagsLikeNotion();
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const build = (): SyncOrchestrator =>
    new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases: [] },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      vault.fs(),
    );

  /**
   * 실측한 Notion 처럼 — 새 페이지의 자리 태그는 모두, 본문 교체는 지금 본문에 없는 블록의 태그를
   * 거절한다(2026-10-21).
   */
  function rejectUnknownTagsLikeNotion(): void {
    const create = notion.client.createPageWithMarkdown.getMockImplementation()!;
    notion.client.createPageWithMarkdown.mockImplementation(
      async (params: { markdown: string }) => {
        if (unknownTagKeys(params.markdown).size > 0) {
          throw validationError("Failed to parse markdown content: Block does not exist");
        }
        return create(params);
      },
    );
    const replace = notion.client.replacePageMarkdown.getMockImplementation()!;
    notion.client.replacePageMarkdown.mockImplementation(async (id: string, markdown: string) => {
      const present = unknownTagKeys(notion.pages.get(id)?.body ?? "");
      if ([...unknownTagKeys(markdown)].some((key) => !present.has(key))) {
        throw validationError(
          "The update page tool cannot safely create new `<unknown .../>` blocks.",
        );
      }
      return replace(id, markdown);
    });
  }

  /** Notion 에 남은 본문 — 끝 줄바꿈은 견주지 않는다. */
  const bodyOf = (path: string): string =>
    notion.pages.get(db.getByPath(path)!.notionPageId!)!.body.trimEnd();

  describe("N6 — 없는 블록을 가리키는 북마크", () => {
    it("다른 페이지의 북마크를 담은 새 노트 — 새 북마크로 만들고 실패하지 않는다", async () => {
      vault.write(
        "복사.md",
        `앞\n${bookmarkPair("https://example.org/a", "예시", placeholder(OTHER_PAGE, OTHER_BLOCK))}\n`,
      );

      expect(await build().push()).toMatchObject({ created: 1, failed: [] });
      expect(bodyOf("복사.md")).toBe(`앞\n<bookmark url="https://example.org/a">예시</bookmark>`);
    });

    it("Notion 에서 지운 북마크가 남은 노트를 고쳐 올려도 실패하지 않는다 — 있는 북마크는 그대로", async () => {
      vault.write("노트.md", "처음\n");
      expect(await build().push()).toMatchObject({ created: 1, failed: [] });
      const pageId = db.getByPath("노트.md")!.notionPageId!.replace(/-/g, "");
      const kept = placeholder(pageId, "40013b18d38281aaaaaaaaaaaaaaaaaaaa".slice(0, 32));
      const gone = placeholder(pageId, OTHER_BLOCK);
      // Notion 에는 북마크 하나만 남아 있다 — 다른 하나는 Notion 에서 지웠다.
      notion.pages.get(db.getByPath("노트.md")!.notionPageId!)!.body =
        `처음\n<unknown url="${kept}" alt="bookmark"/>\n`;

      vault.write(
        "노트.md",
        `고침\n${bookmarkPair("https://example.org/k", "남은 것", kept)}\n` +
          `${bookmarkPair("https://example.org/g", "지운 것", gone)}\n`,
      );
      const result = await build().push();

      expect(result).toMatchObject({ updated: 1, failed: [] });
      expect(bodyOf("노트.md")).toBe(
        `고침\n<unknown url="${kept}" alt="bookmark"/>\n` +
          `<bookmark url="https://example.org/g">지운 것</bookmark>`,
      );
    });
  });

  describe("N8 — 같은 push 에서 뒤에 만든 노트로 가는 위키링크", () => {
    const mentionOf = (path: string) =>
      `<mention-page url="https://www.notion.so/${db.getByPath(path)!.notionPageId!.replace(/-/g, "")}"/>`;

    it("서로를 가리키는 새 노트 둘 — 첫 push 에서 둘 다 멘션이 된다", async () => {
      vault.write("A.md", "B 로: [[B]]\n");
      vault.write("B.md", "A 로: [[A]]\n");

      expect(await build().push()).toMatchObject({ created: 2, updated: 0, failed: [] });

      expect(bodyOf("A.md")).toBe(`B 로: ${mentionOf("B.md")}`);
      expect(bodyOf("B.md")).toBe(`A 로: ${mentionOf("A.md")}`);
    });

    it("예전에 글 링크로 올라간 노트 — 대상을 만든 push 가 고치지 않은 그 노트도 멘션으로 바꾼다", async () => {
      vault.write("C.md", "D 로: [[D]]\n");
      await build().push();
      expect(bodyOf("C.md")).toBe("D 로: [[D]]");

      vault.write("D.md", "새 노트\n");
      expect(await build().push()).toMatchObject({ created: 1, updated: 1, failed: [] });
      expect(bodyOf("C.md")).toBe(`D 로: ${mentionOf("D.md")}`);

      // 다시 보내면 마커가 새로 적혀 같은 노트를 또 고르지 않는다.
      expect(await build().push()).toMatchObject({ created: 0, updated: 0, failed: [] });
    });

    it("올리지 않은 로컬 수정이 있는 노트는 범위 밖이면 같이 보내지 않는다", async () => {
      vault.write("C.md", "D 로: [[D]]\n");
      await build().push();

      vault.write("C.md", "아직 안 올린 수정 [[D]]\n");
      vault.write("D.md", "새 노트\n");
      expect(await build().push({ paths: ["D.md"] })).toMatchObject({
        created: 1,
        updated: 0,
        failed: [],
      });
      expect(bodyOf("C.md")).toBe("D 로: [[D]]");
      expect(bodyOf("C.md")).not.toContain("아직 안 올린 수정");

      expect(await build().push()).toMatchObject({ updated: 1, failed: [] });
      expect(bodyOf("C.md")).toBe(`아직 안 올린 수정 ${mentionOf("D.md")}`);
    });

    it("아직 풀리지 않는 링크만 있는 노트는 다시 보내지 않는다", async () => {
      vault.write("E.md", "없는 노트로: [[없음]]\n");
      await build().push();

      vault.write("F.md", "다른 새 노트\n");
      expect(await build().push()).toMatchObject({ created: 1, updated: 0, failed: [] });
    });

    it("이번 push 에서 올리지 못한 노트는 링크 패스가 몰래 올리지 않는다 — 실패로 남는다", async () => {
      vault.write("C.md", "D 로: [[D]]\n");
      await build().push();
      const pageC = db.getByPath("C.md")!.notionPageId!;

      const replace = notion.client.replacePageMarkdown.getMockImplementation()!;
      let refusals = 2; // 첫 시도와 재시도
      notion.client.replacePageMarkdown.mockImplementation(async (id: string, markdown: string) => {
        if (id === pageC && refusals-- > 0)
          throw Object.assign(new Error("Bad Gateway"), { status: 502 });
        return replace(id, markdown);
      });
      vault.write("C.md", "고친 글 [[D]]\n");
      vault.write("D.md", "새 노트\n");

      const result = await build().push();
      expect(result.created).toBe(1);
      expect(result.failed.map((f) => f.path)).toEqual(["C.md"]);
      expect(bodyOf("C.md")).toBe("D 로: [[D]]");
    });

    it("범위를 좁힌 push 는 범위 밖 노트를 다시 보내지 않는다", async () => {
      vault.write("C.md", "D 로: [[D]]\n");
      await build().push();

      vault.write("D.md", "새 노트\n");
      expect(await build().push({ paths: ["D.md"] })).toMatchObject({ created: 1, updated: 0 });
      expect(bodyOf("C.md")).toBe("D 로: [[D]]");
    });
  });
});
