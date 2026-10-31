/**
 * P11 — 모바일의 연결 폴더 찾기(볼트 어댑터). 데스크톱의 core `findConnectionFolders`(Node `fs`)와 같은 답을 내는지
 * 같은 볼트 모양으로 견준다.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findConnectionFolders, INTERNAL_DIR, STATE_DB_PATH } from "@im-nobsidian/core";
import { findConnectionFoldersInVault } from "../../src/connection/vault-connection-folders.js";
import { MemoryVault } from "../helpers/mobile-host.js";

const memory = () => new MemoryVault({ TFile: class {}, TFolder: class {} } as never);

const LAYOUT = [
  STATE_DB_PATH,
  `프로젝트/${STATE_DB_PATH}`,
  `프로젝트/하위/${INTERNAL_DIR}/x`,
  `일기/2026/노트.md`,
  `.숨김/${INTERNAL_DIR}/x`,
  `.obsidian/plugins/x/${INTERNAL_DIR}/y`,
  `깊은/a/b/c/${INTERNAL_DIR}/z`,
];

describe("findConnectionFoldersInVault", () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it("데스크톱(core, Node fs)과 같은 폴더를 찾는다", async () => {
    dir = await mkdtemp(join(tmpdir(), "im-nobsidian-folders-"));
    const vault = memory();
    for (const path of LAYOUT) {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), "x");
      vault.write(path, "x");
    }
    const desktop = (await findConnectionFolders(dir)).sort();
    const mobile = (await findConnectionFoldersInVault(vault.adapter)).sort();
    expect(mobile).toEqual(desktop);
    expect(mobile).toEqual(["", "깊은/a/b/c", "프로젝트", "프로젝트/하위"]);
  });

  it("맨 위를 `/` 로 시작하는 경로로 주는 어댑터도", async () => {
    const vault = memory();
    vault.write(`a/${STATE_DB_PATH}`, "x");
    const list = vault.adapter.list;
    const slashed = {
      list: async (path: string) => {
        const listed = await list(path);
        return path === "/"
          ? { files: listed.files.map((p) => `/${p}`), folders: listed.folders.map((p) => `/${p}`) }
          : listed;
      },
    };
    expect(await findConnectionFoldersInVault(slashed)).toEqual(["a"]);
  });
});
