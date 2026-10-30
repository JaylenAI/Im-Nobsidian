/**
 * `.base` 의 폴더 필터 — 예전 버전의 `file.inFolder` 는 하위 폴더까지 보아 행의 하위 페이지(`행/…`)도 보기에 행으로
 * 나왔다(2026-10-30 격리 Obsidian 실측). 지금은 `file.folder ==` 로 쓰고, 예전 파일은 pull 이 한 번 고쳐 쓴다.
 */
import { describe, it, expect } from "vitest";
import {
  BASE_FOLDER_FILTER_UPGRADED_META_KEY,
  retargetBaseFiles,
  upgradeBaseFolderFilters,
} from "../../src/sync/db-folder-moves.js";
import { DB_BASE_FILES_META_KEY } from "../../src/sync/db-base-files.js";
import { BASE_FILE_HEADER } from "../../src/view/base-file-generator.js";
import { computeHash } from "../../src/utils/hash.js";

function memory(files: Record<string, string>) {
  const map = new Map(Object.entries(files));
  const meta = new Map<string, string>();
  let lists = 0;
  return {
    map,
    meta,
    lists: () => lists,
    vaultFs: {
      listNonMarkdownFiles: async () => {
        lists++;
        return [...map.keys()].filter((p) => !p.endsWith(".md")).map((path) => ({ path }));
      },
      readFile: async (path: string) => map.get(path)!,
      writeFile: async (path: string, content: string) => void map.set(path, content),
    } as never,
    stateDb: {
      getMeta: (key: string) => meta.get(key) ?? null,
      setMeta: (key: string, value: string) => void meta.set(key, value),
    },
  };
}

const legacy = (folder: string) =>
  `${BASE_FILE_HEADER} from Notion DB: T\nfilters:\n  and:\n    - file.inFolder("${folder}")\n    - file.ext == "md"\n`;
const current = (folder: string) =>
  `${BASE_FILE_HEADER} from Notion DB: T\nfilters:\n  and:\n    - file.folder == "${folder}"\n    - file.ext == "md"\n`;

describe("upgradeBaseFolderFilters", () => {
  it("pull 이 쓴 예전 필터를 고쳐 쓰고 기록 해시도 옮긴다 — 직접 만든 .base 는 두고, 한 번만 훑는다", async () => {
    const mine = 'filters:\n  and:\n    - file.inFolder("A/T")\n';
    const m = memory({ "A/T/T.base": legacy("A/T"), "A/mine.base": mine, "A/T/행.md": "" });
    m.meta.set(
      DB_BASE_FILES_META_KEY,
      JSON.stringify({
        db1: { basePath: "A/T/T.base", title: "T", hash: computeHash(legacy("A/T")) },
      }),
    );

    await upgradeBaseFolderFilters(m.vaultFs, m.stateDb);

    expect(m.map.get("A/T/T.base")).toBe(current("A/T"));
    expect(m.map.get("A/mine.base")).toBe(mine);
    expect(JSON.parse(m.meta.get(DB_BASE_FILES_META_KEY)!).db1.hash).toBe(
      computeHash(current("A/T")),
    );
    expect(m.meta.get(BASE_FOLDER_FILTER_UPGRADED_META_KEY)).toBe("1");

    await upgradeBaseFolderFilters(m.vaultFs, m.stateDb);
    expect(m.lists()).toBe(1);
  });

  it("Obsidian 이 머리 주석을 지운 파일도 — 보기를 기록해 둔 경로면 pull 이 쓴 것이다", async () => {
    const stripped = legacy("A/T").split("\n").slice(1).join("\n");
    const m = memory({ "A/T/T.base": stripped, "A/U.base": stripped });
    m.meta.set(
      DB_BASE_FILES_META_KEY,
      JSON.stringify({ db1: { basePath: "A/T/T.base", title: "T", hash: "x", views: [] } }),
    );
    await upgradeBaseFolderFilters(m.vaultFs, m.stateDb);
    expect(m.map.get("A/T/T.base")).toContain('file.folder == "A/T"');
    expect(m.map.get("A/U.base")).toBe(stripped);
    // 고친 보기로 남는다 — 기록 해시는 그대로.
    expect(JSON.parse(m.meta.get(DB_BASE_FILES_META_KEY)!).db1.hash).toBe("x");
  });

  it("끝까지 훑지 못했으면 다음 pull 이 다시 훑는다", async () => {
    const m = memory({ "A/T/T.base": legacy("A/T") });
    const failing = {
      ...(m.vaultFs as object),
      listNonMarkdownFiles: async () => {
        throw new Error("EIO");
      },
    } as never;
    await upgradeBaseFolderFilters(failing, m.stateDb);
    expect(m.meta.get(BASE_FOLDER_FILTER_UPGRADED_META_KEY)).toBeUndefined();
  });
});

describe("retargetBaseFiles", () => {
  it("지금 꼴과 예전 꼴을 모두 새 자리로 — 옮긴 폴더 밖은 그대로", async () => {
    const m = memory({
      "A/T/T.base": current("A/T"),
      "A/U/U.base": legacy("A/U"),
      "C/V/V.base": current("C/V"),
    });
    await retargetBaseFiles(m.vaultFs, [{ from: "A", to: "B/A" }], m.stateDb);
    expect(m.map.get("A/T/T.base")).toBe(current("B/A/T"));
    expect(m.map.get("A/U/U.base")).toBe(current("B/A/U"));
    expect(m.map.get("C/V/V.base")).toBe(current("C/V"));
  });
});
