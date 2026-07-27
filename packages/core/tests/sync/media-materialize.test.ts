import { describe, it, expect, vi, beforeEach } from "vitest";
import { ImageHandler } from "../../src/sync/image-handler.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";
import type { NotionClient } from "../../src/notion/client.js";

/**
 * R1 — 임베드가 Notion 에서 두 조각으로 갈라지던 문제의 회귀 방어.
 *
 * push 는 `![[foo.png]]` 를 자리표시자 quote 로 바꿔 보내고, 실제 이미지는 페이지 맨 끝에
 * 따로 붙였다. 결과적으로 사용자가 Notion 에서 보는 본문에는 `%% im-nobsidian:local-image:… %%`
 * 리터럴이 남고 이미지는 흐름에서 이탈했다(실측 175파일 / 마커 978건 중 964건이 이 쌍).
 * 여기서는 자리표시자를 **제자리**에서 실제 블록으로 교체하는지, 실패했을 때 마커를
 * 남겨 두는지, 그리고 pull 이 캡션으로 원본 경로를 되찾는지를 고정한다.
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

/** Notion 블록 트리를 부모 id → 자식 배열로 흉내 낸다. */
function createTreeClient(tree: Record<string, unknown[]>): {
  client: NotionClient;
  appendChildren: ReturnType<typeof vi.fn>;
  deleteBlock: ReturnType<typeof vi.fn>;
} {
  const appendChildren = vi.fn().mockResolvedValue(["new-block-id"]);
  const deleteBlock = vi.fn().mockResolvedValue(undefined);
  const client = {
    uploadFile: vi.fn().mockResolvedValue("upload-1"),
    fetchAllChildren: vi.fn().mockImplementation(async (id: string) => tree[id] ?? []),
    appendChildren,
    deleteBlock,
  } as unknown as NotionClient;
  return { client, appendChildren, deleteBlock };
}

function quote(id: string, text: string, hasChildren = false) {
  return {
    id,
    type: "quote",
    has_children: hasChildren,
    quote: { rich_text: [{ plain_text: text }] },
  };
}

const IMG_MARKER = "📎 t-img.png %% im-nobsidian:local-image:assets/t-img.png %%";
const FILE_MARKER = "📎 t-doc.txt %% im-nobsidian:local-file:docs/t-doc.txt %%";

describe("ImageHandler.materializeLocalMedia — 자리표시자 제자리 교체(R1)", () => {
  let mockFs: VaultFS;

  beforeEach(() => {
    mockFs = createMockVaultFs();
  });

  it("최상위 자리표시자를 실제 image 블록으로 바꾸고 원본 quote 를 지운다", async () => {
    const { client, appendChildren, deleteBlock } = createTreeClient({
      "page-1": [quote("blk-ph", IMG_MARKER)],
    });
    const handler = new ImageHandler(mockFs, "attachments", client);

    const result = await handler.materializeLocalMedia("page-1", `> ${IMG_MARKER}\n`);

    // 자리표시자 바로 뒤에 꽂아야 본문 순서가 유지된다.
    expect(appendChildren).toHaveBeenCalledWith(
      "page-1",
      [
        {
          type: "image",
          image: {
            type: "file_upload",
            file_upload: { id: "upload-1" },
            caption: [{ type: "text", text: { content: "assets/t-img.png" } }],
          },
        },
      ],
      { after: "blk-ph" },
    );
    expect(deleteBlock).toHaveBeenCalledWith("blk-ph");
    expect(result.uploaded).toHaveLength(1);
    expect(result.handledTargets.has("assets/t-img.png")).toBe(true);
  });

  it("콜아웃 안에 중첩된 자리표시자도 그 콜아웃을 부모로 삼아 교체한다", async () => {
    const { client, appendChildren, deleteBlock } = createTreeClient({
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
    expect(appendChildren).toHaveBeenCalledWith(
      "callout-1",
      [
        {
          type: "file",
          file: {
            type: "file_upload",
            file_upload: { id: "upload-1" },
            name: "t-doc.txt",
            caption: [{ type: "text", text: { content: "docs/t-doc.txt" } }],
          },
        },
      ],
      { after: "blk-nested" },
    );
    expect(deleteBlock).toHaveBeenCalledWith("blk-nested");
    expect(result.uploaded).toHaveLength(1);
  });

  it("`|크기` 별칭이 붙어도 볼트 경로로 업로드하고 캡션엔 별칭을 그대로 남긴다", async () => {
    const marker = "📎 t-img.png %% im-nobsidian:local-image:assets/t-img.png|300 %%";
    const { client, appendChildren } = createTreeClient({ "page-1": [quote("blk-ph", marker)] });
    const handler = new ImageHandler(mockFs, "attachments", client);

    const result = await handler.materializeLocalMedia("page-1", `> ${marker}\n`);

    expect(mockFs.readBinary).toHaveBeenCalledWith("assets/t-img.png");
    const block = appendChildren.mock.calls[0]![1][0] as {
      image: { caption: { text: { content: string } }[] };
    };
    // 캡션이 pull 의 진실원이라 별칭까지 살려야 `![[assets/t-img.png|300]]` 로 되돌아온다.
    expect(block.image.caption[0]!.text.content).toBe("assets/t-img.png|300");
    expect(result.handledTargets.has("assets/t-img.png|300")).toBe(true);
    expect(result.handledTargets.has("assets/t-img.png")).toBe(true);
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
    const { client, appendChildren, deleteBlock } = createTreeClient({
      "page-1": [quote("blk-ph", IMG_MARKER)],
    });
    const handler = new ImageHandler(mockFs, "attachments", client);

    const result = await handler.materializeLocalMedia("page-1", `> ${IMG_MARKER}\n`);

    // 마커가 살아 있어야 pull 이 임베드를 복원한다 — 반쯤 지우는 게 더 나쁘다.
    expect(appendChildren).not.toHaveBeenCalled();
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
    const registerFile = vi.fn();
    const { client } = createTreeClient({ "page-1": [quote("blk-ph", IMG_MARKER)] });
    const handler = new ImageHandler(mockFs, "attachments", client, undefined, undefined, {
      registerFile,
    } as never);

    await handler.materializeLocalMedia("page-1", `> ${IMG_MARKER}\n`);

    expect(registerFile).toHaveBeenCalledWith(
      expect.objectContaining({
        localPath: "assets/t-img.png",
        notionPageId: "page-1",
        fileUploadId: "upload-1",
        fileType: "image",
      }),
    );
  });

  it("child_page 안으로는 내려가지 않는다 — 남의 페이지 블록을 건드리면 안 된다", async () => {
    const { client, appendChildren } = createTreeClient({
      "page-1": [{ id: "sub-page", type: "child_page", has_children: true, child_page: {} }],
      "sub-page": [quote("blk-ph", IMG_MARKER)],
    });
    const handler = new ImageHandler(mockFs, "attachments", client);

    const result = await handler.materializeLocalMedia("page-1", `> ${IMG_MARKER}\n`);

    expect(client.fetchAllChildren).toHaveBeenCalledTimes(1);
    expect(appendChildren).not.toHaveBeenCalled();
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

  it("NotionClient 가 없으면 아무 일도 하지 않는다", async () => {
    const handler = new ImageHandler(mockFs, "attachments");

    const result = await handler.materializeLocalMedia("page-1", `> ${IMG_MARKER}\n`);

    expect(result.uploaded).toHaveLength(0);
    expect(result.handledTargets.size).toBe(0);
  });
});

describe("ImageHandler — pull 이 캡션으로 원본 임베드를 되살린다(R1)", () => {
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
    const { handler, fs } = handlerWith(["assets/t-img.png"]);

    const result = await handler.downloadAllImages(
      `![assets/t-img.png](${s3("t-img.png")})\n`,
      "테스트",
    );

    expect(result.content).toContain("![[assets/t-img.png]]");
    expect(result.content).not.toContain("attachments/");
    expect(result.downloads).toHaveLength(0);
    expect(fs.writeBinary).not.toHaveBeenCalled();
  });

  it("`\\|` 로 이스케이프된 별칭도 원래 형태로 되돌린다", async () => {
    const { handler } = handlerWith(["assets/t-img.png"]);

    const result = await handler.downloadAllImages(
      `![assets/t-img.png\\|300](${s3("t-img.png")})\n`,
      "테스트",
    );

    expect(result.content).toContain("![[assets/t-img.png|300]]");
  });

  it("사용자가 손으로 쓴 캡션은 경로로 오인하지 않고 정상 다운로드한다", async () => {
    const { handler } = handlerWith(["assets/t-img.png"]);

    // 파일명이 업로드 파일명과 다르므로 경로가 아니라 설명글이다.
    const result = await handler.downloadAllImages(
      `![우리 팀 워크숍 사진](${s3("t-img.png")})\n`,
      "테스트",
    );

    expect(result.content).toContain("![[attachments/");
    expect(result.downloads).toHaveLength(1);
  });

  it("캡션이 맞아도 볼트에 파일이 없으면 다운로드로 떨어진다", async () => {
    const { handler } = handlerWith([]);

    const result = await handler.downloadAllImages(
      `![assets/t-img.png](${s3("t-img.png")})\n`,
      "테스트",
    );

    expect(result.content).toContain("![[attachments/");
    expect(result.downloads).toHaveLength(1);
  });

  // 실측 회귀: 노트 폴더 안의 파일을 파일명만으로 임베드(`![[t-img.png]]`)하면 push 는
  // 노트 폴더까지 뒤져 잘 올렸는데 pull 은 볼트 루트만 확인해 원본을 못 찾고 사본을
  // 새로 받았다 — 왕복할 때마다 첨부가 한 벌씩 늘어난다. push 와 같은 사다리를 쓴다.
  it("노트 폴더 안의 파일도 파일명만으로 원본 복원한다", async () => {
    const { handler, fs } = handlerWith(["__e2e_probe__/t-img.png"]);

    const result = await handler.downloadAllImages(
      `![t-img.png](${s3("t-img.png")})\n`,
      "테스트",
      undefined,
      "__e2e_probe__/R1-media-inplace.md",
    );

    expect(result.content).toContain("![[t-img.png]]");
    expect(result.downloads).toHaveLength(0);
    expect(fs.writeBinary).not.toHaveBeenCalled();
  });

  it("노트 경로를 안 주면 노트 폴더 후보 없이 판정한다(기존 동작 유지)", async () => {
    const { handler } = handlerWith(["__e2e_probe__/t-img.png"]);

    const result = await handler.downloadAllImages(`![t-img.png](${s3("t-img.png")})\n`, "테스트");

    expect(result.content).toContain("![[attachments/");
    expect(result.downloads).toHaveLength(1);
  });

  it("첨부 파일도 노트 폴더 사다리로 원본 복원한다", async () => {
    const { handler, fs } = handlerWith(["__e2e_probe__/t-doc.txt"]);

    const result = await handler.downloadAllFiles(
      `[📎 t-doc.txt](${s3("t-doc.txt")})\n`,
      "테스트",
      "__e2e_probe__/R1-media-inplace.md",
    );

    expect(result.content).toContain("![[t-doc.txt]]");
    expect(result.downloads).toHaveLength(0);
    expect(fs.writeBinary).not.toHaveBeenCalled();
  });
});
