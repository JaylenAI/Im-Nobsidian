import { describe, it, expect, vi, beforeEach } from "vitest";
import { ImageHandler } from "../../src/sync/image-handler.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";
import type { NotionClient } from "../../src/notion/client.js";
import type { ImageReference } from "../../src/types/convert.js";

function createMockVaultFs(): VaultFS {
  return {
    readFile: vi.fn(),
    readBinary: vi.fn().mockResolvedValue(Buffer.from("fake-image-data")),
    writeFile: vi.fn(),
    writeBinary: vi.fn(),
    deleteFile: vi.fn(),
    moveFile: vi.fn(),
    exists: vi.fn().mockResolvedValue(false),
    ensureFolder: vi.fn(),
    listMarkdownFiles: vi.fn().mockResolvedValue([]),
  };
}

describe("ImageHandler", () => {
  let handler: ImageHandler;
  let mockFs: VaultFS;

  beforeEach(() => {
    mockFs = createMockVaultFs();
    handler = new ImageHandler(mockFs, "attachments");
  });

  it("Notion 이미지 URL을 로컬 경로로 변환", async () => {
    const markdown = `# 테스트

일반 텍스트

![설명](https://prod-files-secure.s3.us-west-2.amazonaws.com/test-image.png?X-Amz-Algorithm=AWS4)

다른 텍스트`;

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Map([["content-type", "image/png"]]),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
    });

    const result = await handler.downloadAllImages(markdown, "테스트 문서");

    expect(result.downloads).toHaveLength(1);
    expect(result.content).toContain("![[attachments/");
    expect(result.content).toContain(".png");
    expect(result.content).not.toContain("prod-files-secure");
    expect(mockFs.ensureFolder).toHaveBeenCalledWith("attachments");
    expect(mockFs.writeBinary).toHaveBeenCalled();
  });

  it("Notion이 아닌 외부 URL은 건드리지 않음", async () => {
    const markdown = `![logo](https://example.com/logo.png)`;

    const result = await handler.downloadAllImages(markdown, "테스트");

    expect(result.downloads).toHaveLength(0);
    expect(result.content).toBe(markdown);
  });

  it("다운로드 실패 시 원본 URL 유지", async () => {
    const markdown = `![img](https://prod-files-secure.s3.us-west-2.amazonaws.com/broken.png)`;

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });

    const result = await handler.downloadAllImages(markdown, "테스트");

    expect(result.downloads).toHaveLength(0);
    expect(result.content).toBe(markdown);
  });

  it("이미지 없는 마크다운은 그대로 반환", async () => {
    const markdown = `# 제목\n\n텍스트만 있는 문서`;

    const result = await handler.downloadAllImages(markdown, "테스트");

    expect(result.downloads).toHaveLength(0);
    expect(result.content).toBe(markdown);
  });

  it("여러 이미지 동시 처리", async () => {
    const markdown = `![a](https://prod-files-secure.s3.us-west-2.amazonaws.com/img1.png)

![b](https://prod-files-secure.s3.us-west-2.amazonaws.com/img2.jpg)`;

    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        headers: new Map([["content-type", callCount === 1 ? "image/png" : "image/jpeg"]]),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(50 * callCount)),
      });
    });

    const result = await handler.downloadAllImages(markdown, "테스트");

    expect(result.downloads).toHaveLength(2);
    expect(mockFs.writeBinary).toHaveBeenCalledTimes(2);
  });
});

function createMockNotionClient(): NotionClient {
  return {
    uploadFile: vi.fn().mockResolvedValue("file-upload-id-123"),
    appendChildren: vi.fn().mockResolvedValue(undefined),
  } as unknown as NotionClient;
}

describe("ImageHandler — 업로드", () => {
  let handler: ImageHandler;
  let mockFs: VaultFS;
  let mockNotion: NotionClient;

  beforeEach(() => {
    mockFs = createMockVaultFs();
    mockNotion = createMockNotionClient();
    handler = new ImageHandler(mockFs, "attachments", mockNotion);
  });

  it("로컬 이미지를 Notion에 업로드", async () => {
    const result = await handler.uploadLocalImage("photo.png");

    expect(result.localPath).toBe("photo.png");
    expect(result.fileUploadId).toBe("file-upload-id-123");
    expect(mockFs.readBinary).toHaveBeenCalledWith("photo.png");
    expect(mockNotion.uploadFile).toHaveBeenCalledWith(expect.any(Blob), "photo.png", "image/png");
  });

  it("readBinary 실패 시 attachments 폴더에서 재시도", async () => {
    (mockFs.readBinary as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockResolvedValueOnce(Buffer.from("image-data"));

    const result = await handler.uploadLocalImage("photo.png");

    expect(result.fileUploadId).toBe("file-upload-id-123");
    expect(mockFs.readBinary).toHaveBeenCalledWith("attachments/photo.png");
  });

  it("JPEG 확장자에 올바른 content-type 설정", async () => {
    await handler.uploadLocalImage("img/photo.jpg");

    expect(mockNotion.uploadFile).toHaveBeenCalledWith(expect.any(Blob), "photo.jpg", "image/jpeg");
  });

  it("uploadAndAppendImages — 로컬 이미지 업로드 후 블록 추가", async () => {
    const images: ImageReference[] = [
      { url: "photo.png", localPath: "photo.png", isExternal: false },
      { url: "https://example.com/ext.png", isExternal: true },
    ];

    const results = await handler.uploadAndAppendImages("page-id-123", images);

    expect(results).toHaveLength(1);
    expect(results[0]!.fileUploadId).toBe("file-upload-id-123");
    expect(mockNotion.appendChildren).toHaveBeenCalledWith("page-id-123", [
      {
        type: "image",
        image: {
          type: "file_upload",
          file_upload: { id: "file-upload-id-123" },
        },
      },
    ]);
  });

  it("uploadAndAppendImages — 외부 이미지만 있으면 업로드 안 함", async () => {
    const images: ImageReference[] = [{ url: "https://example.com/ext.png", isExternal: true }];

    const results = await handler.uploadAndAppendImages("page-id-123", images);

    expect(results).toHaveLength(0);
    expect(mockNotion.appendChildren).not.toHaveBeenCalled();
  });

  it("uploadAndAppendImages — 업로드 실패 시 graceful degradation", async () => {
    (mockNotion.uploadFile as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Upload failed"),
    );

    const images: ImageReference[] = [
      { url: "broken.png", localPath: "broken.png", isExternal: false },
    ];

    const results = await handler.uploadAndAppendImages("page-id-123", images);

    expect(results).toHaveLength(0);
    expect(mockNotion.appendChildren).not.toHaveBeenCalled();
  });

  it("NotionClient 없으면 uploadLocalImage 에러", async () => {
    const handlerWithoutNotion = new ImageHandler(mockFs, "attachments");

    await expect(handlerWithoutNotion.uploadLocalImage("photo.png")).rejects.toThrow(
      "NotionClient required",
    );
  });

  it("NotionClient 없으면 uploadAndAppendImages 빈 배열 반환", async () => {
    const handlerWithoutNotion = new ImageHandler(mockFs, "attachments");
    const images: ImageReference[] = [
      { url: "photo.png", localPath: "photo.png", isExternal: false },
    ];

    const results = await handlerWithoutNotion.uploadAndAppendImages("page-id", images);

    expect(results).toHaveLength(0);
  });

  // I6 배선: 업로드한 이미지를 file_registry 에 전체 content_hash 로 등록해야 FileHandler 가
  // 같은 첨부를 폴더 페이지에 standalone 으로 중복 업로드하지 않는다. 외부 URL 은 미등록.
  it("uploadAndAppendImages — 업로드 이미지를 file_registry 에 등록(dedup 배선)", async () => {
    const registerFile = vi.fn();
    const handlerWithState = new ImageHandler(
      mockFs,
      "attachments",
      mockNotion,
      undefined,
      undefined,
      {
        registerFile,
      } as never,
    );

    const images: ImageReference[] = [
      { url: "docs/pic.png", localPath: "docs/pic.png", isExternal: false },
      { url: "https://example.com/ext.png", isExternal: true },
    ];

    const results = await handlerWithState.uploadAndAppendImages("page-id-123", images);

    // 로컬 1건만 업로드·등록, 외부 URL 은 업로드/등록 대상 아님.
    expect(results).toHaveLength(1);
    expect(registerFile).toHaveBeenCalledTimes(1);
    expect(registerFile).toHaveBeenCalledWith(
      expect.objectContaining({
        localPath: "docs/pic.png",
        notionPageId: "page-id-123",
        fileUploadId: "file-upload-id-123",
        fileType: "image",
        fileSize: Buffer.byteLength("fake-image-data"),
      }),
    );
    const arg = registerFile.mock.calls[0]![0] as { fileHash: string };
    expect(arg.fileHash, "전체 sha256(64 hex) 이어야 함").toMatch(/^[0-9a-f]{64}$/);
  });

  it("uploadAndAppendImages — registerFile 실패해도 append 는 성공(graceful)", async () => {
    const registerFile = vi.fn().mockImplementation(() => {
      throw new Error("registry down");
    });
    const handlerWithState = new ImageHandler(
      mockFs,
      "attachments",
      mockNotion,
      undefined,
      undefined,
      {
        registerFile,
      } as never,
    );

    const images: ImageReference[] = [
      { url: "photo.png", localPath: "photo.png", isExternal: false },
    ];

    const results = await handlerWithState.uploadAndAppendImages("page-id-123", images);

    expect(results).toHaveLength(1);
    expect(mockNotion.appendChildren).toHaveBeenCalled();
  });
});
