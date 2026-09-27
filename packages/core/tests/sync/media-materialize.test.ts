import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ImageHandler,
  captionOfEmbed,
  embedTargetFromCaption,
  splitEmbedTarget,
} from "../../src/sync/image-handler.js";
import {
  recallUploadedMedia,
  rememberUploadedMedia,
  type UploadedMedia,
} from "../../src/sync/uploaded-media.js";
import { encodeMarkerTarget } from "../../src/converter/marker-url.js";
import { setLogger } from "../../src/utils/logger.js";
import type { IStateDB } from "../../src/state/state-db-interface.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";
import type { NotionClient } from "../../src/notion/client.js";

/**
 * R1 — 임베드가 Notion 에서 두 조각으로 갈라지던 문제의 회귀 방어.
 *
 * push 는 `![[foo.png]]` 를 자리표시자 quote 로 바꿔 보내고, 실제 이미지는 페이지 맨 끝에
 * 따로 붙였다. 결과적으로 사용자가 Notion 에서 보는 본문에는 `%% im-nobsidian:local-image:… %%`
 * 리터럴이 남고 이미지는 흐름에서 이탈했다(실측 175파일 / 마커 978건 중 964건이 이 쌍).
 * 여기서는 자리표시자를 **제자리**에서 실제 블록으로 교체하는지, 실패했을 때 마커를
 * 남겨 두는지, 그리고 pull 이 원본 임베드를 되찾는지를 고정한다.
 *
 * S-05 — 올린 블록의 캡션에 임베드 대상을 그대로 적어 Notion 에 `assets/사진.png|300` 같은 경로 ·
 * 크기가 보였다. 이제 캡션에는 사람이 적은 설명만 싣고, 어느 임베드였는지는 Notion 이 그 파일을
 * 저장한 id 로 적어 둔다. pull 은 그 id 로 임베드를 되찾는다.
 */

function createMockVaultFs(overrides: Partial<VaultFS> = {}): VaultFS {
  return {
    readFile: vi.fn(),
    readBinary: vi.fn().mockResolvedValue(Buffer.from("fake-bytes")),
    writeFile: vi.fn(),
    writeBinary: vi.fn(),
    deleteFile: vi.fn(),
    moveFile: vi.fn(),
    exists: vi.fn().mockResolvedValue(false),
    ensureFolder: vi.fn(),
    listMarkdownFiles: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as VaultFS;
}

const SPACE_ID = "5d2f8a41-3c7e-4b19-9e0a-7f6d2c1b8a93";
const IMG_FILE_ID = "0f5a3c1e-7b2d-4e8f-9a61-3c2b1d0e9f87";
const DOC_FILE_ID = "a9c4e2b7-1d38-4f6a-8b05-e7c9d3f1a264";

/** Notion 이 저장한 파일의 서명 URL — `…/<space>/<파일 id>/<이름>?서명`. */
function signedUrl(fileId: string, name: string): string {
  return (
    `https://prod-files-secure.s3.us-west-2.amazonaws.com/${SPACE_ID}/${fileId}/` +
    `${encodeURIComponent(name)}?X-Amz-Algorithm=AWS4`
  );
}

/** Notion 블록 트리를 부모 id → 자식 배열로 흉내 낸다. */
function createTreeClient(tree: Record<string, unknown[]>): {
  client: NotionClient;
  appendChildBlocks: ReturnType<typeof vi.fn>;
  deleteBlock: ReturnType<typeof vi.fn>;
  getFileBlockUrl: ReturnType<typeof vi.fn>;
} {
  // 만든 미디어 블록의 응답에는 Notion 이 저장한 파일의 URL 이 실려 온다.
  const appendChildBlocks = vi
    .fn()
    .mockImplementation(async (_parentId: string, blocks: { type: string }[]) =>
      blocks.map((block) => ({
        id: "new-block-id",
        type: block.type,
        [block.type]: { type: "file", file: { url: signedUrl(IMG_FILE_ID, "t-img.png") } },
      })),
    );
  const deleteBlock = vi.fn().mockResolvedValue(undefined);
  const getFileBlockUrl = vi.fn().mockResolvedValue(null);
  const client = {
    uploadFile: vi.fn().mockResolvedValue("upload-1"),
    fetchAllChildren: vi.fn().mockImplementation(async (id: string) => tree[id] ?? []),
    appendChildBlocks,
    deleteBlock,
    getFileBlockUrl,
  } as unknown as NotionClient;
  return { client, appendChildBlocks, deleteBlock, getFileBlockUrl };
}

/** 상태 DB 중 올린 미디어 기록이 쓰는 부분만 — sync_metadata 와 file_registry. */
function createMetaDb(): IStateDB {
  const meta = new Map<string, string>();
  return {
    getMeta: vi.fn((key: string) => meta.get(key) ?? null),
    setMeta: vi.fn((key: string, value: string) => void meta.set(key, value)),
    registerFile: vi.fn(),
    getFilesByPageId: vi.fn().mockReturnValue([]),
  } as unknown as IStateDB;
}

function quote(id: string, text: string, hasChildren = false) {
  return {
    id,
    type: "quote",
    has_children: hasChildren,
    quote: { rich_text: [{ plain_text: text }] },
  };
}

/** push 가 심는 자리표시자 한 줄 — 경로는 퍼센트 인코딩해 싣는다. */
function marker(kind: "image" | "file", target: string): string {
  const name = target.split("|")[0]!.split("/").pop();
  return `📎 ${name} %% im-nobsidian:local-${kind}:${encodeMarkerTarget(target)} %%`;
}

const IMG_MARKER = "📎 t-img.png %% im-nobsidian:local-image:assets/t-img.png %%";
const FILE_MARKER = "📎 t-doc.txt %% im-nobsidian:local-file:docs/t-doc.txt %%";

describe("ImageHandler.materializeLocalMedia — 자리표시자 제자리 교체(R1)", () => {
  let mockFs: VaultFS;

  beforeEach(() => {
    mockFs = createMockVaultFs();
  });

  it("최상위 자리표시자를 실제 image 블록으로 바꾸고 원본 quote 를 지운다", async () => {
    const { client, appendChildBlocks, deleteBlock } = createTreeClient({
      "page-1": [quote("blk-ph", IMG_MARKER)],
    });
    const handler = new ImageHandler(mockFs, "attachments", client);

    const result = await handler.materializeLocalMedia("page-1", `> ${IMG_MARKER}\n`);

    // 자리표시자 바로 뒤에 꽂아야 본문 순서가 유지된다. 설명이 없으니 캡션은 비운다(S-05).
    expect(appendChildBlocks).toHaveBeenCalledWith(
      "page-1",
      [
        {
          type: "image",
          image: { type: "file_upload", file_upload: { id: "upload-1" }, caption: [] },
        },
      ],
      { after: "blk-ph" },
    );
    expect(deleteBlock).toHaveBeenCalledWith("blk-ph");
    expect(result.uploaded).toHaveLength(1);
    expect(result.handledTargets.has("assets/t-img.png")).toBe(true);
  });

  it("콜아웃 안에 중첩된 자리표시자도 그 콜아웃을 부모로 삼아 교체한다", async () => {
    const { client, appendChildBlocks, deleteBlock } = createTreeClient({
      "page-1": [
        {
          id: "callout-1",
          type: "callout",
          has_children: true,
          callout: { rich_text: [{ plain_text: "안내" }] },
        },
      ],
      "callout-1": [quote("blk-nested", FILE_MARKER)],
    });
    const handler = new ImageHandler(mockFs, "attachments", client);

    const result = await handler.materializeLocalMedia("page-1", `> ${FILE_MARKER}\n`);

    // after_block 은 같은 부모의 형제만 기준으로 삼으므로 부모가 콜아웃이어야 한다.
    // 파일 블록은 이름으로 파일 이름을 보여 준다 — 캡션에 또 적지 않는다.
    expect(appendChildBlocks).toHaveBeenCalledWith(
      "callout-1",
      [
        {
          type: "file",
          file: {
            type: "file_upload",
            file_upload: { id: "upload-1" },
            name: "t-doc.txt",
            caption: [],
          },
        },
      ],
      { after: "blk-nested" },
    );
    expect(deleteBlock).toHaveBeenCalledWith("blk-nested");
    expect(result.uploaded).toHaveLength(1);
  });

  it("`|크기` 별칭은 볼트 경로로 올리고 캡션에 싣지 않는다 — 크기는 Obsidian 이 그릴 너비다", async () => {
    const sized = marker("image", "assets/t-img.png|300");
    const { client, appendChildBlocks } = createTreeClient({ "page-1": [quote("blk-ph", sized)] });
    const handler = new ImageHandler(mockFs, "attachments", client);

    const result = await handler.materializeLocalMedia("page-1", `> ${sized}\n`);

    expect(mockFs.readBinary).toHaveBeenCalledWith("assets/t-img.png");
    const block = appendChildBlocks.mock.calls[0]![1][0] as { image: { caption: unknown[] } };
    expect(block.image.caption).toEqual([]);
    expect(result.handledTargets.has("assets/t-img.png|300")).toBe(true);
    expect(result.handledTargets.has("assets/t-img.png")).toBe(true);
  });

  it("`|설명` 은 캡션으로 싣는다 — 경로 · 크기는 싣지 않는다(S-05)", async () => {
    const described = marker("image", "assets/t-img.png|워크숍 사진|300");
    const { client, appendChildBlocks } = createTreeClient({
      "page-1": [quote("blk-ph", described)],
    });
    const handler = new ImageHandler(mockFs, "attachments", client);

    await handler.materializeLocalMedia("page-1", `> ${described}\n`);

    const block = appendChildBlocks.mock.calls[0]![1][0] as { image: { caption: unknown[] } };
    expect(block.image.caption).toEqual([{ type: "text", text: { content: "워크숍 사진" } }]);
  });

  it("마커가 없는 본문이면 블록 조회조차 하지 않는다", async () => {
    const { client } = createTreeClient({ "page-1": [quote("blk-ph", IMG_MARKER)] });
    const handler = new ImageHandler(mockFs, "attachments", client);

    const result = await handler.materializeLocalMedia("page-1", "# 제목\n\n본문만 있음\n");

    expect(client.fetchAllChildren).not.toHaveBeenCalled();
    expect(result.uploaded).toHaveLength(0);
  });

  it("볼트에 파일이 없으면(ENOENT) 자리표시자를 지우지 않고 남긴다", async () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    mockFs = createMockVaultFs({ readBinary: vi.fn().mockRejectedValue(enoent) });
    const { client, appendChildBlocks, deleteBlock } = createTreeClient({
      "page-1": [quote("blk-ph", IMG_MARKER)],
    });
    const handler = new ImageHandler(mockFs, "attachments", client);

    const result = await handler.materializeLocalMedia("page-1", `> ${IMG_MARKER}\n`);

    // 마커가 살아 있어야 pull 이 임베드를 복원한다 — 반쯤 지우는 게 더 나쁘다.
    expect(appendChildBlocks).not.toHaveBeenCalled();
    expect(deleteBlock).not.toHaveBeenCalled();
    expect(result.uploaded).toHaveLength(0);
    expect(result.handledTargets.size).toBe(0);
  });

  it("블록 조회가 실패해도 push 전체를 깨뜨리지 않는다", async () => {
    const { client, deleteBlock } = createTreeClient({});
    (client.fetchAllChildren as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("500"));
    const handler = new ImageHandler(mockFs, "attachments", client);

    const result = await handler.materializeLocalMedia("page-1", `> ${IMG_MARKER}\n`);

    expect(result.uploaded).toHaveLength(0);
    expect(deleteBlock).not.toHaveBeenCalled();
  });

  it("업로드분을 file_registry 에 등록해 폴더 스캔의 중복 업로드를 막는다", async () => {
    const db = createMetaDb();
    const { client } = createTreeClient({ "page-1": [quote("blk-ph", IMG_MARKER)] });
    const handler = new ImageHandler(mockFs, "attachments", client, undefined, undefined, db);

    await handler.materializeLocalMedia("page-1", `> ${IMG_MARKER}\n`);

    expect(db.registerFile).toHaveBeenCalledWith(
      expect.objectContaining({
        localPath: "assets/t-img.png",
        notionPageId: "page-1",
        fileUploadId: "upload-1",
        fileType: "image",
      }),
    );
  });

  it("child_page 안으로는 내려가지 않는다 — 남의 페이지 블록을 건드리면 안 된다", async () => {
    const { client, appendChildBlocks } = createTreeClient({
      "page-1": [{ id: "sub-page", type: "child_page", has_children: true, child_page: {} }],
      "sub-page": [quote("blk-ph", IMG_MARKER)],
    });
    const handler = new ImageHandler(mockFs, "attachments", client);

    const result = await handler.materializeLocalMedia("page-1", `> ${IMG_MARKER}\n`);

    expect(client.fetchAllChildren).toHaveBeenCalledTimes(1);
    expect(appendChildBlocks).not.toHaveBeenCalled();
    expect(result.uploaded).toHaveLength(0);
  });

  // 실측 회귀: ImageHandler 가 이미지 확장자만 담은 축소판 MIME 테이블을 따로 들고 있어
  // `![[t-doc.txt]]` 를 application/octet-stream 으로 올렸고 Notion 이 400 으로 거절했다.
  it("비이미지 첨부도 올바른 content-type 으로 업로드한다", async () => {
    const { client } = createTreeClient({ "page-1": [quote("blk-ph", FILE_MARKER)] });
    const handler = new ImageHandler(mockFs, "attachments", client);

    await handler.materializeLocalMedia("page-1", `> ${FILE_MARKER}\n`);

    expect(client.uploadFile).toHaveBeenCalledWith(expect.any(Blob), "t-doc.txt", "text/plain");
  });

  // S-14 — 표에 없는 확장자는 업로드를 만들 때 400 으로 거절된다(실측: `.base`). 거르지 않으면
  // 자리표시자가 남아 push 할 때마다 같은 요청이 같은 이유로 실패한다(실볼트 `.ipynb` 임베드 42건).
  describe("Notion 이 받지 않는 형식 (S-14)", () => {
    const NOTEBOOK_MARKER = "📎 분석.ipynb %% im-nobsidian:local-file:nb/분석.ipynb %%";
    let info: string[];

    beforeEach(() => {
      info = [];
      setLogger({
        warn: () => {},
        error: () => {},
        info: (msg) => info.push(msg),
        debug: () => {},
      });
    });

    afterEach(() => {
      setLogger({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} });
    });

    it("올리지 않고 자리표시자를 남긴다 — 페이지를 고치지 않았다", async () => {
      const { client, appendChildBlocks, deleteBlock } = createTreeClient({
        "page-1": [quote("blk-ph", NOTEBOOK_MARKER)],
      });
      const handler = new ImageHandler(mockFs, "attachments", client);

      const result = await handler.materializeLocalMedia(
        "page-1",
        `> ${NOTEBOOK_MARKER}\n`,
        "연구/노트.md",
      );

      expect(mockFs.readBinary).not.toHaveBeenCalled();
      expect(client.uploadFile).not.toHaveBeenCalled();
      expect(appendChildBlocks).not.toHaveBeenCalled();
      expect(deleteBlock).not.toHaveBeenCalled();
      expect(result.touched).toBe(false);
      expect(info).toEqual([
        "[Im-Nobsidian] Notion 이 받지 않는 형식이라 올리지 않은 임베드 (연구/노트.md): " +
          "nb/분석.ipynb — Notion 에는 파일 이름 자리표시자로 남는다",
      ]);
    });

    it("받는 형식과 섞여 있으면 받는 것만 올린다", async () => {
      const { client, deleteBlock } = createTreeClient({
        "page-1": [quote("blk-nb", NOTEBOOK_MARKER), quote("blk-img", IMG_MARKER)],
      });
      const handler = new ImageHandler(mockFs, "attachments", client);

      const result = await handler.materializeLocalMedia(
        "page-1",
        `> ${NOTEBOOK_MARKER}\n\n> ${IMG_MARKER}\n`,
      );

      expect(client.uploadFile).toHaveBeenCalledTimes(1);
      expect(deleteBlock).toHaveBeenCalledWith("blk-img");
      expect(deleteBlock).not.toHaveBeenCalledWith("blk-nb");
      expect(result.touched).toBe(true);
    });
  });

  it("NotionClient 가 없으면 아무 일도 하지 않는다", async () => {
    const handler = new ImageHandler(mockFs, "attachments");

    const result = await handler.materializeLocalMedia("page-1", `> ${IMG_MARKER}\n`);

    expect(result.uploaded).toHaveLength(0);
    expect(result.handledTargets.size).toBe(0);
  });
});

describe("ImageHandler.materializeLocalMedia — 올린 파일의 id 를 적어 둔다(S-05)", () => {
  const SIZED = marker("image", "t-img.png|300");
  let warn: string[];

  beforeEach(() => {
    warn = [];
    setLogger({
      warn: (msg) => warn.push(msg),
      error: () => {},
      info: () => {},
      debug: () => {},
    });
  });

  afterEach(() => {
    setLogger({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} });
  });

  it("임베드 대상 · 올린 볼트 파일과 함께 적는다", async () => {
    const db = createMetaDb();
    const { client, getFileBlockUrl } = createTreeClient({ "page-1": [quote("blk-ph", SIZED)] });
    const handler = new ImageHandler(createMockVaultFs(), "attachments", client, undefined, {}, db);

    await handler.materializeLocalMedia("page-1", `> ${SIZED}\n`, "notes/노트.md");

    // 파일 이름만 적은 임베드는 노트 폴더에서 찾아 올린다 — 적는 경로도 찾은 그 파일이다.
    expect([...recallUploadedMedia(db, "page-1").values()]).toEqual([
      { fileId: IMG_FILE_ID, target: "t-img.png|300", localPath: "notes/t-img.png" },
    ]);
    // 만든 응답에 파일 URL 이 실려 오면 다시 조회하지 않는다.
    expect(getFileBlockUrl).not.toHaveBeenCalled();
  });

  it("응답에 파일 URL 이 없으면 블록을 한 번 조회해 id 를 얻는다", async () => {
    const db = createMetaDb();
    const { client, appendChildBlocks, getFileBlockUrl } = createTreeClient({
      "page-1": [quote("blk-ph", SIZED)],
    });
    appendChildBlocks.mockResolvedValue([
      { id: "new-block-id", type: "image", image: { type: "file_upload", file_upload: {} } },
    ]);
    getFileBlockUrl.mockResolvedValue(signedUrl(IMG_FILE_ID, "t-img.png"));
    const handler = new ImageHandler(createMockVaultFs(), "attachments", client, undefined, {}, db);

    await handler.materializeLocalMedia("page-1", `> ${SIZED}\n`, "notes/노트.md");

    expect(getFileBlockUrl).toHaveBeenCalledWith("new-block-id");
    expect(recallUploadedMedia(db, "page-1").has(IMG_FILE_ID)).toBe(true);
  });

  it("id 를 끝내 모르면 적지 않고 알린다 — 블록은 제자리에 둔다", async () => {
    const db = createMetaDb();
    const { client, appendChildBlocks, deleteBlock } = createTreeClient({
      "page-1": [quote("blk-ph", SIZED)],
    });
    appendChildBlocks.mockResolvedValue([{ id: "new-block-id", type: "image", image: {} }]);
    const handler = new ImageHandler(createMockVaultFs(), "attachments", client, undefined, {}, db);

    const result = await handler.materializeLocalMedia("page-1", `> ${SIZED}\n`);

    expect(deleteBlock).toHaveBeenCalledWith("blk-ph");
    expect(result.uploaded).toHaveLength(1);
    expect(recallUploadedMedia(db, "page-1").size).toBe(0);
    expect(warn).toEqual([
      "[Im-Nobsidian] 올린 미디어의 Notion 파일을 확인하지 못함 (t-img.png) — " +
        "다음 pull 이 사본을 받을 수 있다",
    ]);
  });

  it("다시 올리면 지난 기록을 통째로 바꾼다 — 본문 push 가 미디어 블록을 모두 새로 만든다", async () => {
    const db = createMetaDb();
    rememberUploadedMedia(db, "page-1", [
      { fileId: DOC_FILE_ID, target: "옛.png", localPath: "옛.png" },
    ]);
    const { client } = createTreeClient({ "page-1": [quote("blk-ph", SIZED)] });
    const handler = new ImageHandler(createMockVaultFs(), "attachments", client, undefined, {}, db);

    await handler.materializeLocalMedia("page-1", `> ${SIZED}\n`);

    expect([...recallUploadedMedia(db, "page-1").keys()]).toEqual([IMG_FILE_ID]);
  });

  it("기록을 적지 못해도 push 를 깨뜨리지 않는다 — 다음 pull 이 사본을 받을 뿐이다", async () => {
    const db = createMetaDb();
    (db.setMeta as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("database is locked");
    });
    const { client, deleteBlock } = createTreeClient({ "page-1": [quote("blk-ph", SIZED)] });
    const handler = new ImageHandler(createMockVaultFs(), "attachments", client, undefined, {}, db);

    const result = await handler.materializeLocalMedia("page-1", `> ${SIZED}\n`);

    expect(result.uploaded).toHaveLength(1);
    expect(deleteBlock).toHaveBeenCalledWith("blk-ph");
    expect(warn).toEqual([
      "[Im-Nobsidian] 올린 미디어 기록 실패 (page-1) — 다음 pull 이 사본을 받을 수 있다: " +
        "database is locked",
    ]);
  });

  it("왕복 — 올린 블록을 받은 본문에서 노트의 임베드로 되찾는다", async () => {
    const db = createMetaDb();
    const { client } = createTreeClient({ "page-1": [quote("blk-ph", SIZED)] });
    const fs = createMockVaultFs({
      exists: vi.fn(async (p: string) => p === "notes/t-img.png"),
    });
    const handler = new ImageHandler(fs, "attachments", client, undefined, {}, db);

    await handler.materializeLocalMedia("page-1", `> ${SIZED}\n`, "notes/노트.md");
    const pulled = await handler.restoreUploadedMedia(
      `# 노트\n\n![](${signedUrl(IMG_FILE_ID, "t-img.png")})\n`,
      "page-1",
      "notes/노트.md",
    );

    expect(pulled).toBe("# 노트\n\n![[t-img.png|300]]\n");
  });
});

describe("ImageHandler.restoreUploadedMedia — 올린 파일의 id 로 임베드를 되찾는다(S-05)", () => {
  const IMG_URL = signedUrl(IMG_FILE_ID, "t-img.png");
  const DOC_URL = signedUrl(DOC_FILE_ID, "t-doc.txt");
  const IMG: UploadedMedia = {
    fileId: IMG_FILE_ID,
    target: "assets/t-img.png|워크숍|300",
    localPath: "assets/t-img.png",
  };
  const DOC: UploadedMedia = {
    fileId: DOC_FILE_ID,
    target: "docs/t-doc.txt",
    localPath: "docs/t-doc.txt",
  };
  let fetchSpy: ReturnType<typeof vi.fn>;

  /** page-1 에 `media` 를 올려 둔 핸들러. `existing` 은 볼트에 있는 파일. */
  function handlerWith(
    media: UploadedMedia[],
    existing: string[] = media.map((m) => m.localPath),
  ): ImageHandler {
    const db = createMetaDb();
    rememberUploadedMedia(db, "page-1", media);
    const fs = createMockVaultFs({ exists: vi.fn(async (p: string) => existing.includes(p)) });
    fetchSpy = vi.fn();
    return new ImageHandler(fs, "attachments", undefined, fetchSpy as never, {}, db);
  }

  it("캡션이 그대로면 적어 둔 임베드 그대로 — 아무것도 내려받지 않는다", async () => {
    const handler = handlerWith([IMG]);

    const result = await handler.restoreUploadedMedia(
      `앞\n\n![워크숍](${IMG_URL})\n\n뒤\n`,
      "page-1",
    );

    expect(result).toBe("앞\n\n![[assets/t-img.png|워크숍|300]]\n\n뒤\n");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Notion 에서 캡션을 비우면 경로와 크기만 남긴다", async () => {
    const handler = handlerWith([IMG]);

    const result = await handler.restoreUploadedMedia(`![](${IMG_URL})\n`, "page-1");

    expect(result).toBe("![[assets/t-img.png|300]]\n");
  });

  it("Notion 에서 캡션을 고치면 새 설명을 싣는다", async () => {
    const handler = handlerWith([IMG]);

    const result = await handler.restoreUploadedMedia(`![새 설명](${IMG_URL})\n`, "page-1");

    expect(result).toBe("![[assets/t-img.png|새 설명|300]]\n");
  });

  it("같은 이름의 다른 파일로 바꾼 것은 되살리지 않는다 — 옛 로컬 파일로 되돌리면 그 편집을 잃는다", async () => {
    const handler = handlerWith([IMG]);
    const replaced = `![워크숍](${signedUrl("7e1d9c3b-5a2f-4c8e-b6d4-2f9a1e3c7b50", "t-img.png")})\n`;

    const result = await handler.restoreUploadedMedia(replaced, "page-1");

    expect(result).toBe(replaced);
  });

  it("볼트에서 그 파일이 사라졌으면 되살리지 않는다 — 뒤이어 사본을 받는다", async () => {
    const handler = handlerWith([IMG], []);
    const pulled = `![워크숍](${IMG_URL})\n`;

    expect(await handler.restoreUploadedMedia(pulled, "page-1")).toBe(pulled);
  });

  it("다른 페이지에 올린 기록으로는 되살리지 않는다", async () => {
    const handler = handlerWith([IMG]);
    const pulled = `![워크숍](${IMG_URL})\n`;

    expect(await handler.restoreUploadedMedia(pulled, "page-2")).toBe(pulled);
  });

  it("파일 링크 · 태그도 되찾는다 — 파일 블록이 보여 주는 이름은 캡션으로 보지 않는다", async () => {
    const handler = handlerWith([{ ...DOC, target: "docs/t-doc.txt|계약서 사본" }]);

    const result = await handler.restoreUploadedMedia(
      `[📎 t-doc.txt](${DOC_URL})\n\n<file src="${DOC_URL}">t-doc.txt</file>\n`,
      "page-1",
    );

    expect(result).toBe("![[docs/t-doc.txt|계약서 사본]]\n\n![[docs/t-doc.txt|계약서 사본]]\n");
  });

  it("DB 행의 자리 이름(`[📎 file]`)은 빈 캡션으로 본다", async () => {
    const handler = handlerWith([{ ...DOC, target: "docs/t-doc.txt|계약서 사본" }]);

    const result = await handler.restoreUploadedMedia(`[📎 file](${DOC_URL})\n`, "page-1");

    expect(result).toBe("![[docs/t-doc.txt]]\n");
  });

  it("markdown API 의 내부 참조(`file://`)도 id 로 되찾는다", async () => {
    const handler = handlerWith([DOC]);
    const internal =
      "file://" +
      encodeURIComponent(
        JSON.stringify({
          source: `attachment:${DOC_FILE_ID}:t-doc.txt`,
          permissionRecord: { table: "block", id: "blk-1", spaceId: SPACE_ID },
        }),
      );

    const result = await handler.restoreUploadedMedia(
      `<file src="${internal}">t-doc.txt</file>\n`,
      "page-1",
    );

    expect(result).toBe("![[docs/t-doc.txt]]\n");
  });

  it("대상에 `$` 가 있어도 치환 패턴으로 읽지 않는다", async () => {
    const handler = handlerWith([
      { fileId: IMG_FILE_ID, target: "assets/가격$&.png", localPath: "assets/가격$&.png" },
    ]);

    const result = await handler.restoreUploadedMedia(
      `![](${signedUrl(IMG_FILE_ID, "가격$&.png")})\n`,
      "page-1",
    );

    expect(result).toBe("![[assets/가격$&.png]]\n");
  });
});

describe("ImageHandler.restoreUploadedMedia — 기록이 없는 옛 페이지는 캡션으로 되찾는다(R1)", () => {
  const s3 = (name: string) =>
    `https://prod-files-secure.s3.us-west-2.amazonaws.com/${name}?X-Amz-Algorithm=AWS4`;

  function handlerWith(existing: string[]): { handler: ImageHandler; fs: VaultFS } {
    const fs = createMockVaultFs({
      exists: vi.fn().mockImplementation(async (p: string) => existing.includes(p)),
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([["content-type", "image/png"]]),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(64)),
    });
    return { handler: new ImageHandler(fs, "attachments"), fs };
  }

  it("캡션 파일명이 업로드 파일명과 같고 볼트에 있으면 원본 위키링크로 복원한다", async () => {
    const { handler } = handlerWith(["assets/t-img.png"]);

    const result = await handler.restoreUploadedMedia(`![assets/t-img.png](${s3("t-img.png")})\n`);

    expect(result).toBe("![[assets/t-img.png]]\n");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("`\\|` 로 이스케이프된 별칭도 원래 형태로 되돌린다", async () => {
    const { handler } = handlerWith(["assets/t-img.png"]);

    const result = await handler.restoreUploadedMedia(
      `![assets/t-img.png\\|300](${s3("t-img.png")})\n`,
    );

    expect(result).toBe("![[assets/t-img.png|300]]\n");
  });

  it("사용자가 손으로 쓴 캡션은 경로로 오인하지 않는다 — 뒤이어 사본을 받는다", async () => {
    const { handler } = handlerWith(["assets/t-img.png"]);
    // 파일명이 업로드 파일명과 다르므로 경로가 아니라 설명글이다.
    const pulled = `![우리 팀 워크숍 사진](${s3("t-img.png")})\n`;

    const restored = await handler.restoreUploadedMedia(pulled);
    const result = await handler.downloadAllImages(restored, "테스트");

    expect(restored).toBe(pulled);
    expect(result.content).toContain("![[attachments/");
    expect(result.content).toContain("|우리 팀 워크숍 사진]]");
    expect(result.downloads).toHaveLength(1);
  });

  it("캡션이 맞아도 볼트에 파일이 없으면 그대로 둔다 — 뒤이어 사본을 받는다", async () => {
    const { handler } = handlerWith([]);
    const pulled = `![assets/t-img.png](${s3("t-img.png")})\n`;

    expect(await handler.restoreUploadedMedia(pulled)).toBe(pulled);
  });

  // 실측 회귀: 노트 폴더 안의 파일을 파일명만으로 임베드(`![[t-img.png]]`)하면 push 는
  // 노트 폴더까지 뒤져 잘 올렸는데 pull 은 볼트 루트만 확인해 원본을 못 찾고 사본을
  // 새로 받았다 — 왕복할 때마다 첨부가 한 벌씩 늘어난다. push 와 같은 사다리를 쓴다.
  it("노트 폴더 안의 파일도 파일명만으로 원본 복원한다", async () => {
    const { handler, fs } = handlerWith(["__e2e_probe__/t-img.png"]);

    const result = await handler.restoreUploadedMedia(
      `![t-img.png](${s3("t-img.png")})\n`,
      undefined,
      "__e2e_probe__/R1-media-inplace.md",
    );

    expect(result).toBe("![[t-img.png]]\n");
    expect(fs.writeBinary).not.toHaveBeenCalled();
  });

  it("노트 경로를 안 주면 노트 폴더 후보 없이 판정한다", async () => {
    const { handler } = handlerWith(["__e2e_probe__/t-img.png"]);
    const pulled = `![t-img.png](${s3("t-img.png")})\n`;

    expect(await handler.restoreUploadedMedia(pulled)).toBe(pulled);
  });

  it("첨부 파일도 노트 폴더 사다리로 원본 복원한다", async () => {
    const { handler } = handlerWith(["__e2e_probe__/t-doc.txt"]);

    const result = await handler.restoreUploadedMedia(
      `[📎 t-doc.txt](${s3("t-doc.txt")})\n`,
      undefined,
      "__e2e_probe__/R1-media-inplace.md",
    );

    expect(result).toBe("![[t-doc.txt]]\n");
  });
});

describe("임베드 캡션 규칙(S-05)", () => {
  it.each([
    ["a.png", { path: "a.png", description: "", size: "" }],
    ["a.png|300", { path: "a.png", description: "", size: "300" }],
    ["a.png|300x200", { path: "a.png", description: "", size: "300x200" }],
    ["a.png|설명", { path: "a.png", description: "설명", size: "" }],
    ["a.png|설명|300", { path: "a.png", description: "설명", size: "300" }],
    ["a.png|설명|부연", { path: "a.png", description: "설명|부연", size: "" }],
  ])("splitEmbedTarget(%s)", (target, parts) => {
    expect(splitEmbedTarget(target)).toEqual(parts);
  });

  it("push 캡션은 설명만 — 경로 · 크기 · 파일 이름을 싣지 않는다", () => {
    expect(captionOfEmbed("assets/t-img.png")).toBe("");
    expect(captionOfEmbed("assets/t-img.png|300")).toBe("");
    expect(captionOfEmbed("assets/t-img.png|워크숍 사진|300")).toBe("워크숍 사진");
  });

  it.each([
    // [적어 둔 대상, 받은 캡션, 기대]
    ["a.png|설명|300", "설명", "a.png|설명|300"],
    ["a.png|300", "a.png|300", "a.png|300"], // 옛 push 가 대상 전체를 캡션으로 달았다
    ["a.png|설명", "a.png", "a.png|설명"], // 파일 블록이 이름을 보여 준다 — 지우지 않는다
    ["a.png|설명|300", "", "a.png|300"],
    ["a.png|설명|300", "새 설명", "a.png|새 설명|300"],
    ["a.png|300", "설명", "a.png|설명"],
    ["a.png", "설명", "a.png|설명"],
    ["a.png", "[[노트]] 참고 | 비교", "a.png|노트 참고 - 비교"], // 위키링크 별칭으로 안전하게
  ])("embedTargetFromCaption(%s, %s) → %s", (target, caption, expected) => {
    expect(embedTargetFromCaption(target, caption, "a.png")).toBe(expected);
  });
});
