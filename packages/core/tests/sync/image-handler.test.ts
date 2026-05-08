import { describe, it, expect, vi, beforeEach } from "vitest";
import { ImageHandler } from "../../src/sync/image-handler.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";

function createMockVaultFs(): VaultFS {
  return {
    readFile: vi.fn(),
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
