/**
 * 노트가 이름만 적은 첨부를 볼트 어디서든 찾는다 — Obsidian 처럼(2026-11-02 실측: 다른 폴더의 아이콘이 ENOENT 로 올라가지
 * 않았다).
 */
import { describe, it, expect, vi } from "vitest";
import { VaultFileIndex } from "../../src/sync/vault-file-index.js";
import { ImageHandler } from "../../src/sync/image-handler.js";
import type { NotionClient } from "../../src/notion/client.js";
import { createMockVaultFs } from "../helpers/mock-orchestrator.js";

function vaultWith(paths: string[]) {
  const vaultFs = createMockVaultFs();
  (vaultFs.listNonMarkdownFiles as ReturnType<typeof vi.fn>).mockResolvedValue(
    paths.map((path) => ({ path, size: 1, mtime: "2026-11-02T00:00:00.000Z" })),
  );
  (vaultFs.exists as ReturnType<typeof vi.fn>).mockImplementation(async (p: string) =>
    paths.includes(p),
  );
  return vaultFs;
}

describe("VaultFileIndex", () => {
  it("이름 · 경로 끝으로 찾고, 노트 폴더 안(얕은 것 먼저) → 짧은 경로 순으로 준다", async () => {
    const index = new VaultFileIndex(
      vaultWith([
        "z/깊은/그림.png",
        "a/그림.png",
        "노트/attachments/그림.png",
        "노트/그림.png",
        "b/c/표.pdf",
      ]),
    );

    expect(await index.find("그림.png", "노트")).toEqual([
      "노트/그림.png",
      "노트/attachments/그림.png",
      "a/그림.png",
      "z/깊은/그림.png",
    ]);
    expect(await index.find("c/표.pdf")).toEqual(["b/c/표.pdf"]);
    expect(await index.find("없는.png")).toEqual([]);
  });

  it("대소문자 · 한글 정규화(NFD 이름)를 가리지 않는다", async () => {
    const nfd = "사진.PNG".normalize("NFD");
    const index = new VaultFileIndex(vaultWith([`img/${nfd}`]));

    expect(await index.find("사진.png")).toEqual([`img/${nfd}`]);
  });

  it("목록은 한 번 만들어 같이 쓰고, 오래되면 새로 만든다", async () => {
    let now = 0;
    const vaultFs = vaultWith(["a/x.png"]);
    const index = new VaultFileIndex(vaultFs, () => now);

    await index.find("x.png");
    await index.find("y.png");
    expect(vaultFs.listNonMarkdownFiles).toHaveBeenCalledTimes(1);
    now = 60_000;
    await index.find("x.png");
    expect(vaultFs.listNonMarkdownFiles).toHaveBeenCalledTimes(2);
  });

  it("목록을 못 읽으면 빈 결과 — 던지지 않는다", async () => {
    const vaultFs = createMockVaultFs();
    (vaultFs.listNonMarkdownFiles as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("EACCES"),
    );

    expect(await new VaultFileIndex(vaultFs).find("x.png")).toEqual([]);
  });
});

describe("ImageHandler — 세 곳에 없는 첨부", () => {
  it("다른 폴더의 파일을 이름으로 찾아 올린다 — 세 곳에서 찾으면 볼트를 훑지 않는다", async () => {
    const vaultFs = vaultWith(["icons/아이콘.png", "proj/옆.png"]);
    (vaultFs.readBinary as ReturnType<typeof vi.fn>).mockImplementation(async (p: string) => {
      if (p === "icons/아이콘.png" || p === "proj/옆.png") return Buffer.from("png");
      throw new Error(`ENOENT ${p}`);
    });
    const notion = {
      uploadFile: vi.fn().mockResolvedValue("upload-id"),
    } as unknown as NotionClient;
    const handler = new ImageHandler(vaultFs, "attachments", notion);

    expect((await handler.uploadLocalImage("옆.png", "proj")).localPath).toBe("proj/옆.png");
    expect(vaultFs.listNonMarkdownFiles).not.toHaveBeenCalled();
    expect((await handler.uploadLocalImage("아이콘.png", "proj")).localPath).toBe(
      "icons/아이콘.png",
    );
    await expect(handler.uploadLocalImage("없음.png", "proj")).rejects.toThrow("ENOENT");
  });
});
