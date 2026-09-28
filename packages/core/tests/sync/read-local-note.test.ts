/**
 * 받기 직전의 로컬 노트(`readLocalNote`) — pull 변환이 Notion 에 남길 자리가 없는 표기(코드 펜스의 원래
 * 언어, S-20)를 되살리는 근거다. 읽지 못해도 받기를 멈추지 않는다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readLocalNote } from "../../src/sync/vault-fs.js";
import { setLogger } from "../../src/utils/logger.js";
import { createMockVaultFs } from "../helpers/mock-orchestrator.js";

describe("readLocalNote — 받기 직전의 로컬 노트(S-20)", () => {
  let warn: string[];

  beforeEach(() => {
    warn = [];
    setLogger({ warn: (msg) => warn.push(msg), error: () => {}, info: () => {}, debug: () => {} });
  });

  afterEach(() => {
    setLogger({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} });
  });

  it("노트가 있으면 그 글을 돌려준다", async () => {
    const fs = createMockVaultFs();
    vi.mocked(fs.exists).mockResolvedValue(true);
    vi.mocked(fs.readFile).mockResolvedValue("```dataview\nLIST\n```\n");

    expect(await readLocalNote(fs, "Note.md")).toBe("```dataview\nLIST\n```\n");
    expect(fs.readFile).toHaveBeenCalledWith("Note.md");
  });

  it("노트가 없으면 읽지 않고 undefined — 처음 받는 노트는 경고할 일이 아니다", async () => {
    const fs = createMockVaultFs();

    expect(await readLocalNote(fs, "New.md")).toBeUndefined();
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(warn).toEqual([]);
  });

  it("읽지 못하면 받기를 멈추지 않고 undefined — 까닭을 경고로 남긴다", async () => {
    const fs = createMockVaultFs();
    vi.mocked(fs.exists).mockResolvedValue(true);
    vi.mocked(fs.readFile).mockRejectedValue(new Error("EACCES: permission denied"));

    expect(await readLocalNote(fs, "Locked.md")).toBeUndefined();
    expect(warn).toEqual([
      "[Im-Nobsidian] 로컬 노트를 읽지 못해 코드 펜스 표기를 되살리지 못함 (Locked.md): EACCES: permission denied",
    ]);
  });
});
