/**
 * `.base` 의 폴더 필터 — 예전 버전의 `file.inFolder` 는 하위 폴더까지 보아 행의 하위 페이지(`행/…`)도 보기에 행으로
 * 나왔다(2026-10-30 격리 Obsidian 실측). 지금은 `file.folder ==` 로 쓰고, 예전 파일은 pull 이 한 번 고쳐 쓴다.
 */
import { describe, it, expect } from "vitest";
import {
  BASE_FOLDER_FILTER_UPGRADED_META_KEY,
  pendingUserBaseFilterFixes,
  resolveUserBaseFilterFixes,
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

describe("직접 만든 .base 의 폴더 필터 — 묻고 고침", () => {
  const mine = (folder: string) =>
    `filters:\n  and:\n    - file.inFolder("${folder}")\nviews:\n  - type: table\n    name: 내 보기\n`;
  const mineCurrent = (folder: string) =>
    `filters:\n  and:\n    - file.folder == "${folder}"\nviews:\n  - type: table\n    name: 내 보기\n`;

  it("옮길 때 고치지 않고 물을 것으로 남긴다 — 옮긴 폴더 밖을 가리키면 남기지 않는다", async () => {
    const m = memory({ "내/할일.base": mine("A/T"), "내/다른.base": mine("C/V") });
    await retargetBaseFiles(m.vaultFs, [{ from: "A/T", to: "A/T2" }], m.stateDb);
    expect(m.map.get("내/할일.base")).toBe(mine("A/T"));
    expect(pendingUserBaseFilterFixes(m.stateDb)).toEqual([
      { path: "내/할일.base", from: "A/T", to: "A/T2" },
    ]);
  });

  it("고치면 쓴 꼴 그대로 새 폴더로 — 두 꼴 모두, 그 밖의 줄은 그대로, 다시 묻지 않는다", async () => {
    const m = memory({ "내/a.base": mine("A/T"), "내/b.base": mineCurrent("A/T") });
    await retargetBaseFiles(m.vaultFs, [{ from: "A", to: "B" }], m.stateDb);
    expect(await resolveUserBaseFilterFixes(m.vaultFs, m.stateDb, true)).toEqual([
      "내/a.base",
      "내/b.base",
    ]);
    expect(m.map.get("내/a.base")).toBe(mine("B/T"));
    expect(m.map.get("내/b.base")).toBe(mineCurrent("B/T"));
    expect(pendingUserBaseFilterFixes(m.stateDb)).toEqual([]);
  });

  it("두면 고치지 않고 다시 묻지 않는다", async () => {
    const m = memory({ "내/a.base": mine("A/T") });
    await retargetBaseFiles(m.vaultFs, [{ from: "A/T", to: "A/U" }], m.stateDb);
    expect(await resolveUserBaseFilterFixes(m.vaultFs, m.stateDb, false)).toEqual([]);
    expect(m.map.get("내/a.base")).toBe(mine("A/T"));
    expect(pendingUserBaseFilterFixes(m.stateDb)).toEqual([]);
  });

  it("묻기 전에 또 옮기면 마지막 자리로 — 그 .base 를 함께 옮겼어도, 제자리로 돌아오면 묻지 않는다", async () => {
    // 부르기 전에 파일은 이미 옮겨져 있다 — 목록은 새 자리를 보인다.
    const m = memory({ "A/U/내.base": mine("A/T") });
    await retargetBaseFiles(m.vaultFs, [{ from: "A/T", to: "A/U" }], m.stateDb);
    expect(pendingUserBaseFilterFixes(m.stateDb)[0]!.path).toBe("A/U/내.base");
    m.map.set("A/W/내.base", m.map.get("A/U/내.base")!);
    m.map.delete("A/U/내.base");
    await retargetBaseFiles(m.vaultFs, [{ from: "A/U", to: "A/W" }], m.stateDb);
    expect(pendingUserBaseFilterFixes(m.stateDb)).toEqual([
      { path: "A/W/내.base", from: "A/T", to: "A/W" },
    ]);
    m.map.set("A/T/내.base", m.map.get("A/W/내.base")!);
    m.map.delete("A/W/내.base");
    await retargetBaseFiles(m.vaultFs, [{ from: "A/W", to: "A/T" }], m.stateDb);
    expect(pendingUserBaseFilterFixes(m.stateDb)).toEqual([]);
  });

  it("동기화가 만든 .base 는 묻지 않고 고친다", async () => {
    const m = memory({ "A/T/T.base": current("A/T") });
    await retargetBaseFiles(m.vaultFs, [{ from: "A/T", to: "A/U" }], m.stateDb);
    expect(m.map.get("A/T/T.base")).toBe(current("A/U"));
    expect(pendingUserBaseFilterFixes(m.stateDb)).toEqual([]);
  });

  it("고치기 전에 지웠으면 건너뛴다", async () => {
    const m = memory({ "내/a.base": mine("A/T") });
    await retargetBaseFiles(m.vaultFs, [{ from: "A/T", to: "A/U" }], m.stateDb);
    m.map.delete("내/a.base");
    m.vaultFs.readFile = async () => Promise.reject(new Error("ENOENT"));
    expect(await resolveUserBaseFilterFixes(m.vaultFs, m.stateDb, true)).toEqual([]);
  });
});
