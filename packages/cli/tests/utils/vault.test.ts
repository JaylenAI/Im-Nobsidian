/** 연결 폴더(ADR-038) — CLI 가 현재 폴더를 볼트로 열 때 안쪽 연결 폴더를 비켜 가고 Obsidian 설정을 찾는다. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigManager, StateDB } from "@im-nobsidian/core";
import {
  nestedConnections,
  obsidianConfigDir,
  openVaultFs,
  outerConnectionTracking,
  vaultArgPath,
} from "../../src/utils/vault.js";

describe("openVaultFs · obsidianConfigDir", () => {
  let vault: string;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), "nobsi-vault-"));
    for (const dir of [".obsidian", ".im-nobsidian", "Work/.im-nobsidian", "Notes"]) {
      await mkdir(join(vault, dir), { recursive: true });
    }
    await writeFile(join(vault, "Notes/n.md"), "n");
    await writeFile(join(vault, "Work/w.md"), "w");
  });

  afterEach(async () => {
    await rm(vault, { recursive: true, force: true });
  });

  it("맨 위에서 열면 안쪽 연결 폴더의 노트를 보지도 쓰지도 않는다", async () => {
    expect(await nestedConnections(vault)).toEqual(["Work"]);
    const fs = await openVaultFs(vault, {});
    expect((await fs.listMarkdownFiles()).map((f) => f.path)).toEqual(["Notes/n.md"]);
    await expect(fs.writeFile("Work/w.md", "덮어쓰기")).rejects.toThrow(/다른 연결 폴더/);
    expect(await readFile(join(vault, "Work/w.md"), "utf-8")).toBe("w");
  });

  it("안쪽 연결 폴더에서 열면 그 폴더가 볼트다 — Obsidian 설정은 위에서 찾는다", async () => {
    const work = join(vault, "Work");
    expect((await (await openVaultFs(work, {})).listMarkdownFiles()).map((f) => f.path)).toEqual([
      "w.md",
    ]);
    expect(obsidianConfigDir(work)).toBe("../.obsidian");
    expect(obsidianConfigDir(vault)).toBe(".obsidian");
  });

  it("바깥 연결이 이미 동기화하는 폴더를 알아본다 — init 이 막는다", async () => {
    const db = StateDB.open(new ConfigManager(vault).dbPath);
    db.upsert({
      obsidianPath: "Notes/n.md",
      notionPageId: "p1",
      contentHash: "h",
      status: "synced",
      localLastModified: "2026-10-23T00:00:00.000Z",
      syncDirection: "both",
      fileType: "file",
    });
    db.close();
    expect(outerConnectionTracking(join(vault, "Notes"))).toEqual({ folder: vault, notes: 1 });
    expect(outerConnectionTracking(join(vault, "Work"))).toBeNull();
  });
});

describe("vaultArgPath (이슈 #8)", () => {
  it("Windows 에서 \\ 로 친 경로를 볼트 경로로", () => {
    expect(vaultArgPath("00 Me\\Daily\\a.md", "win32")).toBe("00 Me/Daily/a.md");
    expect(vaultArgPath("00 Me\\", "win32")).toBe("00 Me/");
  });

  it("다른 OS 에서 \\ 는 이름의 글자다", () => {
    expect(vaultArgPath("a\\b.md", "linux")).toBe("a\\b.md");
    expect(vaultArgPath("a\\b.md", "darwin")).toBe("a\\b.md");
  });
});
