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

describe("LinkUpdater.apply — 다른 연결의 노트에서도 링크를 고친다 (P6)", () => {
  /** 볼트 전체와 연결 폴더 `Work` 만 보는 볼트 — 같은 파일을 나눠 본다. */
  function vault(notes: Record<string, string>) {
    const files = new Map(Object.entries(notes));
    const fsOf = (folder: string) => {
      const prefix = folder === "" ? "" : `${folder}/`;
      const inside = () =>
        [...files].filter(([path]) => path.startsWith(prefix) && path.endsWith(".md"));
      return {
        listMarkdownFiles: vi.fn(async () =>
          inside().map(([path, content]) => ({ path: path.slice(prefix.length), content })),
        ),
        listNonMarkdownFiles: vi.fn(async () => []),
        writeFile: vi.fn(async (path: string, content: string) => {
          files.set(prefix + path, content);
        }),
        getFileStat: vi.fn(async () => ({ mtime: "2026-10-30T00:00:00.000Z", size: 1 })),
      };
    };
    const stateDb = { getByPath: vi.fn(() => null), updateHash: vi.fn(), updateStatCache: vi.fn() };
    return { files, fsOf, stateDb };
  }

  it("볼트 맨 위 · 다른 연결 폴더의 노트가 옮긴 노트를 가리키면 고치고, 이 연결의 노트는 한 번만 쓴다", async () => {
    const { files, fsOf, stateDb } = vault({
      "Work/b.md": "옮긴 노트\n",
      "Work/w.md": "[[a]]\n",
      "Personal/p.md": "[[Work/a|회의]]\n",
      "home.md": "[[a]] · [[home]]\n",
    });
    const own = fsOf("Work");
    const whole = fsOf("");
    const updater = new LinkUpdater(stateDb as never, own as never, {
      fs: whole as never,
      folder: "Work",
    });

    const relinked = await updater.apply([{ from: "a.md", to: "b.md", renamed: true }]);

    expect(relinked.sort()).toEqual(["Personal/p.md", "home.md", "w.md"]);
    expect(files.get("Work/w.md")).toBe("[[b]]\n");
    expect(files.get("Personal/p.md")).toBe("[[Work/b|회의]]\n");
    expect(files.get("home.md")).toBe("[[b]] · [[home]]\n");
    expect(own.writeFile).toHaveBeenCalledTimes(1);
    expect(whole.writeFile).toHaveBeenCalledTimes(2);
  });

  it("볼트 전체를 받지 않으면 이 연결의 노트만 고친다 — 예전과 같다", async () => {
    const { files, fsOf, stateDb } = vault({
      "Work/b.md": "옮긴 노트\n",
      "home.md": "[[a]]\n",
    });
    const updater = new LinkUpdater(stateDb as never, fsOf("Work") as never);

    expect(await updater.apply([{ from: "a.md", to: "b.md" }])).toEqual([]);
    expect(files.get("home.md")).toBe("[[a]]\n");
  });

  it("옮긴 것이 없으면 볼트 전체를 읽지 않는다", async () => {
    const { fsOf, stateDb } = vault({ "home.md": "[[a]]\n" });
    const whole = fsOf("");
    const updater = new LinkUpdater(stateDb as never, fsOf("Work") as never, {
      fs: whole as never,
      folder: "Work",
    });

    expect(await updater.apply([])).toEqual([]);
    expect(whole.listMarkdownFiles).not.toHaveBeenCalled();
  });
});
