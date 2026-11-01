/**
 * P13 — 폴더 첨부 왕복(ADR-054). 폴더에 그냥 둔 파일은 폴더 페이지에 «캡션 = 파일 이름» 으로 올리고, 받는 쪽은 그 페이지를
 * 폴더로 두고 파일을 같은 폴더에 같은 이름으로 받는다.
 */
import { createHash } from "node:crypto";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  embeddedNamesOf,
  folderFileIdsOf,
  folderFilesOf,
  rememberFolderFileId,
} from "../../src/sync/folder-files.js";
import { FileHandler } from "../../src/sync/file-handler.js";
import { setLogger } from "../../src/utils/logger.js";
import type { NotionClient } from "../../src/notion/client.js";
import type { IStateDB } from "../../src/state/state-db-interface.js";
import {
  createMockVaultFs,
  createMockStateDb,
  createMockNotionClient,
} from "../helpers/mock-orchestrator.js";

const URL_CSV = "https://prod-files-secure.s3.us-west-2.amazonaws.com/s/f/data_v2.csv?X-Amz=1";
const URL_PDF = "https://prod-files-secure.s3.us-west-2.amazonaws.com/s/g/report.pdf?X-Amz=1";
const FILE_ID = "0123abcd-0000-4000-8000-00000000000a";
const NEW_URL = `https://file.notion.so/f/f/space/${FILE_ID}/data.csv?x=1`;
const CHILD = '<page url="https://www.notion.so/0123456789abcdef0123456789abcdef">하위</page>';

describe("folderFilesOf", () => {
  it("자식 · 빈 블록과 올린 파일뿐이면 그 파일들", () => {
    const md = `${CHILD}\n<empty-block/>\n<file src="${URL_CSV}">data\\_v2.csv</file>\n<pdf src="${URL_PDF}"></pdf>`;
    expect(folderFilesOf(md, false)).toEqual([
      { url: URL_CSV, name: "data_v2.csv" },
      { url: URL_PDF, name: "report.pdf" },
    ]);
  });

  it("글이 있으면 폴더 노트다 — null", () => {
    expect(folderFilesOf(`글\n<file src="${URL_CSV}">data_v2.csv</file>`, false)).toBeNull();
  });

  it("파일이 없으면 null — 빈 폴더 페이지는 예전 규칙(자식 유무)이 가른다", () => {
    expect(folderFilesOf(CHILD, false)).toBeNull();
  });

  it("namedOnly: 캡션이 이름과 다르면(손으로 붙인 PDF 노트) null · 이스케이프는 풀어서 견준다", () => {
    expect(folderFilesOf(`<pdf src="${URL_PDF}">분기 보고</pdf>`, true)).toBeNull();
    expect(folderFilesOf(`<file src="${URL_CSV}">data\\_v2.csv</file>`, true)).toHaveLength(1);
  });

  it("받을 수 없는 내부 참조가 섞이면 null", () => {
    expect(folderFilesOf('<file src="file://abc">x.csv</file>', false)).toBeNull();
  });
});

describe("embeddedNamesOf", () => {
  it("위키 · 마크다운 임베드와 frontmatter 링크(아이콘 · 커버)의 이름", () => {
    const names = embeddedNamesOf([
      "![[a/그림.png|300]] ![](sub/%EB%B3%B4%EA%B3%A0.pdf) [[링크만.csv]]",
      '---\nicon: "[[아이콘.png]]"\n---\n본문',
    ]);
    expect([...names].sort()).toEqual(["그림.png", "보고.pdf", "아이콘.png"].sort());
  });
});

describe("FileHandler — 폴더 첨부", () => {
  const warnings: string[] = [];
  afterEach(() => {
    warnings.length = 0;
    setLogger({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} });
  });
  function setup(files: string[]) {
    setLogger({ warn: (m) => warnings.push(m), error: () => {}, info: () => {}, debug: () => {} });
    const vaultFs = createMockVaultFs();
    (vaultFs.listNonMarkdownFiles as ReturnType<typeof vi.fn>).mockResolvedValue(
      files.map((path, i) => ({ path, size: 10 + i, mtime: "2026-11-02T00:00:00.000Z" })),
    );
    const stateDb = createMockStateDb();
    const meta = new Map<string, string>();
    stateDb.getMeta.mockImplementation((k: string) => meta.get(k) ?? null);
    stateDb.setMeta.mockImplementation((k: string, v: string) => meta.set(k, v));
    const notion = createMockNotionClient();
    (notion.uploadFile as ReturnType<typeof vi.fn>).mockResolvedValue("upload-id");
    (notion.appendChildBlocks as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "new-block", type: "file", file: { type: "file", file: { url: NEW_URL } } },
    ]);
    const handler = new FileHandler(
      vaultFs,
      notion as unknown as NotionClient,
      stateDb as unknown as IStateDB,
      2,
      { attachmentsFolder: "attachments" },
    );
    return { vaultFs, stateDb, notion, handler };
  }

  it("노트 없는 폴더는 페이지를 마련해 올리고, 캡션에 파일 이름을 적는다", async () => {
    const { stateDb, notion, handler } = setup(["proj/data.csv"]);
    const records = new Map<string, unknown>();
    stateDb.getByPath.mockImplementation((p: string) => records.get(p) ?? null);
    const ensureFolderPage = vi.fn(async (folder: string) => {
      records.set(folder, {
        notionPageId: "proj-page",
        obsidianPath: folder,
        fileType: "folder-note",
      });
    });

    const results = await handler.pushAllFiles(undefined, { ensureFolderPage });

    expect(ensureFolderPage).toHaveBeenCalledWith("proj");
    expect(results.map((r) => r.localPath)).toEqual(["proj/data.csv"]);
    const [pageId, [block]] = (notion.appendChildBlocks as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(pageId).toBe("proj-page");
    expect(JSON.stringify(block)).toContain('"content":"data.csv"');
    expect(folderFileIdsOf(stateDb as unknown as IStateDB, "proj-page").get("proj/data.csv")).toBe(
      FILE_ID,
    );
  });

  it("받은 첨부 폴더 · 노트가 붙인 파일 · 숨은 폴더는 폴더 첨부로 올리지 않는다", async () => {
    const { vaultFs, stateDb, notion, handler } = setup([
      "attachments/받은-abc.png",
      "proj/그림.png",
      ".trash/x.pdf",
    ]);
    (vaultFs.listMarkdownFiles as ReturnType<typeof vi.fn>).mockResolvedValue([
      { path: "proj/노트.md" },
    ]);
    (vaultFs.readFile as ReturnType<typeof vi.fn>).mockResolvedValue("![[그림.png]]");
    stateDb.getByPath.mockReturnValue({
      notionPageId: "p",
      obsidianPath: "proj",
      fileType: "folder-only",
    });

    expect(await handler.pushAllFiles()).toEqual([]);
    expect(notion.uploadFile).not.toHaveBeenCalled();
  });

  it("다른 페이지에 적힌 파일(노트 임베드로 올린 것)은 바뀌어도 폴더 첨부로 올리지 않는다", async () => {
    const { stateDb, notion, handler } = setup(["proj/그림.png"]);
    stateDb.getByPath.mockReturnValue({
      notionPageId: "p",
      obsidianPath: "proj",
      fileType: "folder-only",
    });
    stateDb.getFileRegistry.mockReturnValue({
      notionPageId: "note-page",
      fileSize: 1,
      fileHash: "x",
    });

    expect(await handler.pushAllFiles()).toEqual([]);
    expect(notion.uploadFile).not.toHaveBeenCalled();
  });

  it("바뀐 폴더 첨부는 새 블록을 붙이고 같은 이름의 옛 블록을 지운다", async () => {
    const { stateDb, notion, handler } = setup(["proj/data.csv"]);
    stateDb.getByPath.mockReturnValue({
      notionPageId: "p",
      obsidianPath: "proj",
      fileType: "folder-only",
    });
    stateDb.getFileRegistry.mockReturnValue({ notionPageId: "p", fileSize: 1, fileHash: "old" });
    const media = (url: string) => ({ type: "file", file: { url } });
    (notion.fetchAllChildren as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "old-block", type: "file", file: media("https://file.notion.so/f/f/s/1/data.csv?x=1") },
      { id: "new-block", type: "file", file: media("https://file.notion.so/f/f/s/2/data.csv?x=1") },
      { id: "other", type: "file", file: media("https://file.notion.so/f/f/s/3/other.csv?x=1") },
    ]);

    await handler.pushAllFiles();

    expect((notion.deleteBlock as ReturnType<typeof vi.fn>).mock.calls).toEqual([["old-block"]]);
  });

  it("폴더 노트가 있는 폴더 · 맨 위의 파일은 올리지 않고 경고로 알린다", async () => {
    const { stateDb, notion, handler } = setup(["fn/x.csv", "top.csv"]);
    stateDb.getByPath.mockImplementation((p: string) =>
      p === "fn"
        ? { notionPageId: "fn-page", obsidianPath: "fn/fn.md", fileType: "folder-note" }
        : null,
    );
    const ensureFolderPage = vi.fn();

    expect(await handler.pushAllFiles(undefined, { ensureFolderPage })).toEqual([]);
    expect(notion.uploadFile).not.toHaveBeenCalled();
    expect(ensureFolderPage).not.toHaveBeenCalled();
    expect(warnings.join("\n")).toContain("올리지 않은 첨부 2개");
    expect(warnings.join("\n")).toContain("fn/x.csv");
  });

  function receiver(body: string, local?: string) {
    const { vaultFs, stateDb } = setup([]);
    if (local !== undefined) {
      (vaultFs.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (vaultFs.readBinary as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.from(local));
    }
    const fetchFn = vi.fn(async () => new Response(Buffer.from(body)));
    const handler = new FileHandler(
      vaultFs,
      createMockNotionClient() as unknown as NotionClient,
      stateDb as unknown as IStateDB,
      2,
      { fetch: fetchFn as unknown as typeof globalThis.fetch },
    );
    return { vaultFs, stateDb, fetchFn, handler, db: stateDb as unknown as IStateDB };
  }
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const fileUrl = (id: string, name: string) =>
    `https://file.notion.so/f/f/space/0123abcd-0000-4000-8000-00000000000${id}/${name}?x=1`;

  it("receiveFolderFiles: 같은 Notion 파일 id 는 건너뛰고, 새 파일은 그 폴더에 원래 이름으로 받아 적는다", async () => {
    const { vaultFs, stateDb, fetchFn, handler, db } = receiver("a,b\n");
    stateDb.getFilesByPageId.mockReturnValue([{ localPath: "proj/old.csv", fileHash: "h" }]);
    rememberFolderFileId(db, "p", "proj/old.csv", "0123abcd-0000-4000-8000-000000000001");

    const n = await handler.receiveFolderFiles("proj", "p", [
      { url: fileUrl("1", "old.csv"), name: "old.csv" },
      { url: fileUrl("2", "new.csv"), name: "new.csv" },
    ]);

    expect(n).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(vaultFs.writeBinary).toHaveBeenCalledWith("proj/new.csv", expect.any(Buffer));
    expect(stateDb.registerFile).toHaveBeenCalledWith(
      expect.objectContaining({ localPath: "proj/new.csv", notionPageId: "p" }),
    );
    expect(folderFileIdsOf(db, "p").get("proj/new.csv")).toBe(
      "0123abcd-0000-4000-8000-000000000002",
    );
  });

  it("receiveFolderFiles: Notion 에서 바뀐 파일(id 다름)은 볼트 쪽이 그대로면 덮는다", async () => {
    const { vaultFs, stateDb, handler, db } = receiver("새 내용", "옛 내용");
    stateDb.getFilesByPageId.mockReturnValue([
      { localPath: "proj/a.csv", fileHash: sha("옛 내용") },
    ]);
    rememberFolderFileId(db, "p", "proj/a.csv", "0123abcd-0000-4000-8000-000000000001");

    expect(
      await handler.receiveFolderFiles("proj", "p", [
        { url: fileUrl("2", "a.csv"), name: "a.csv" },
      ]),
    ).toBe(1);
    expect(vaultFs.writeBinary).toHaveBeenCalledWith("proj/a.csv", Buffer.from("새 내용"));
  });

  it("receiveFolderFiles: 양쪽에서 고쳤으면 볼트의 것을 두고 알린다", async () => {
    const { vaultFs, stateDb, handler, db } = receiver("Notion 고침", "볼트 고침");
    stateDb.getFilesByPageId.mockReturnValue([
      { localPath: "proj/a.csv", fileHash: sha("옛 내용") },
    ]);
    rememberFolderFileId(db, "p", "proj/a.csv", "0123abcd-0000-4000-8000-000000000001");

    expect(
      await handler.receiveFolderFiles("proj", "p", [
        { url: fileUrl("2", "a.csv"), name: "a.csv" },
      ]),
    ).toBe(0);
    expect(vaultFs.writeBinary).not.toHaveBeenCalled();
    expect(warnings.join("\n")).toContain("양쪽에서 고침");
  });

  it("receiveFolderFiles: id 를 적기 전에 받은 파일은 받지 않고 id 만 적는다", async () => {
    const { stateDb, fetchFn, handler, db } = receiver("x");
    stateDb.getFilesByPageId.mockReturnValue([{ localPath: "proj/a.csv", fileHash: "h" }]);

    expect(
      await handler.receiveFolderFiles("proj", "p", [
        { url: fileUrl("3", "a.csv"), name: "a.csv" },
      ]),
    ).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(folderFileIdsOf(db, "p").get("proj/a.csv")).toBe("0123abcd-0000-4000-8000-000000000003");
  });

  it("receiveFolderFiles: 처음 보는 같은 이름의 다른 파일이 있으면 덮지 않는다", async () => {
    const { vaultFs, stateDb, handler } = receiver("남의 것", "내 것");

    expect(
      await handler.receiveFolderFiles("proj", "p", [
        { url: fileUrl("4", "a.csv"), name: "a.csv" },
      ]),
    ).toBe(0);
    expect(vaultFs.writeBinary).not.toHaveBeenCalled();
    expect(stateDb.registerFile).not.toHaveBeenCalled();
    expect(warnings.join("\n")).toContain("같은 이름의 다른 파일");
  });
});
