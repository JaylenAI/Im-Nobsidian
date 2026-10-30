import { describe, it, expect, vi } from "vitest";
import { LinkUpdater } from "../../src/sync/link-updater.js";
import { computeHash } from "../../src/utils/hash.js";

/** 노트 몇 개와 그 레코드 — 레코드의 해시는 지금 내용(동기화된 노트)이다. */
function setup(notes: Record<string, string>, edited: readonly string[] = []) {
  const files = new Map(Object.entries(notes));
  const vaultFs = {
    listMarkdownFiles: vi.fn(async () => [...files].map(([path, content]) => ({ path, content }))),
    writeFile: vi.fn(async (path: string, content: string) => {
      files.set(path, content);
    }),
    getFileStat: vi.fn(async () => ({ mtime: "2026-10-30T00:00:00.000Z", size: 1 })),
  };
  const stateDb = {
    getByPath: vi.fn((path: string) =>
      files.has(path)
        ? {
            id: path,
            contentHash: edited.includes(path) ? "local-edit" : computeHash(notes[path]!),
          }
        : null,
    ),
    updateHash: vi.fn(),
    updateStatCache: vi.fn(),
  };
  return {
    files,
    stateDb,
    updater: new LinkUpdater(stateDb as never, vaultFs as never),
  };
}

describe("LinkUpdater.dropEmbeds — Notion 에서 지운 링크드 뷰의 임베드 (P6)", () => {
  const GONE = "E2E/할일/할일 - 완료만.base";

  it("치운 .base 를 넣은 줄과 그 앞 빈 줄을 빼고, 동기화된 노트는 사본도 맞춘다", async () => {
    const { files, stateDb, updater } = setup({
      "a.md": `글\n\n![[${GONE}|완료만]]\n\n끝\n`,
      "b.md": `![[${GONE}]]\n\n글\n`,
      "c.md": `![[E2E/할일/할일.base]]\n`,
    });

    expect(await updater.dropEmbeds([GONE])).toEqual(["a.md", "b.md"]);

    expect(files.get("a.md")).toBe("글\n\n끝\n");
    expect(files.get("b.md")).toBe("글\n");
    expect(files.get("c.md")).toBe("![[E2E/할일/할일.base]]\n");
    expect(stateDb.updateHash).toHaveBeenCalledWith(
      "a.md",
      computeHash("글\n\n끝\n"),
      Buffer.from("글\n\n끝\n", "utf-8"),
    );
  });

  it("올리지 않은 편집이 있는 노트는 사본을 두어 그 편집과 함께 올라가게 한다", async () => {
    const { stateDb, updater } = setup({ "a.md": `글\n\n![[${GONE}]]\n` }, ["a.md"]);

    expect(await updater.dropEmbeds([GONE])).toEqual(["a.md"]);
    expect(stateDb.updateHash).not.toHaveBeenCalled();
  });

  it("치운 것이 없으면 노트를 읽지 않는다", async () => {
    const { updater } = setup({ "a.md": "글\n" });
    expect(await updater.dropEmbeds([])).toEqual([]);
  });
});
