import { describe, it, expect, vi, afterEach } from "vitest";
import { FileHandler } from "../../src/sync/file-handler.js";
import { setLogger } from "../../src/utils/logger.js";
import { getBlockType, getMimeType } from "../../src/utils/mime.js";
import type { NotionClient } from "../../src/notion/client.js";
import type { IStateDB } from "../../src/state/state-db-interface.js";
import {
  createMockVaultFs,
  createMockStateDb,
  createMockNotionClient,
} from "../helpers/mock-orchestrator.js";

describe("FileHandler", () => {
  describe("getBlockType", () => {
    it("이미지 확장자 → image 블록", () => {
      expect(getBlockType("photo.png")).toBe("image");
      expect(getBlockType("photo.jpg")).toBe("image");
      expect(getBlockType("photo.jpeg")).toBe("image");
      expect(getBlockType("photo.gif")).toBe("image");
      expect(getBlockType("photo.webp")).toBe("image");
      expect(getBlockType("photo.svg")).toBe("image");
      expect(getBlockType("photo.bmp")).toBe("image");
      expect(getBlockType("photo.ico")).toBe("image");
      expect(getBlockType("photo.tiff")).toBe("image");
      expect(getBlockType("photo.avif")).toBe("image");
      expect(getBlockType("photo.heic")).toBe("image");
    });

    it("PDF → pdf 블록", () => {
      expect(getBlockType("document.pdf")).toBe("pdf");
      expect(getBlockType("report.PDF")).toBe("pdf");
    });

    it("비디오 확장자 → video 블록", () => {
      expect(getBlockType("video.mp4")).toBe("video");
      expect(getBlockType("video.mov")).toBe("video");
      expect(getBlockType("video.webm")).toBe("video");
      expect(getBlockType("video.avi")).toBe("video");
      expect(getBlockType("video.mkv")).toBe("video");
    });

    it("오디오 확장자 → audio 블록", () => {
      expect(getBlockType("music.mp3")).toBe("audio");
      expect(getBlockType("music.wav")).toBe("audio");
      expect(getBlockType("music.ogg")).toBe("audio");
      expect(getBlockType("music.m4a")).toBe("audio");
      expect(getBlockType("music.flac")).toBe("audio");
    });

    it("기타 파일 → file 블록", () => {
      expect(getBlockType("doc.docx")).toBe("file");
      expect(getBlockType("data.xlsx")).toBe("file");
      expect(getBlockType("archive.zip")).toBe("file");
      expect(getBlockType("code.py")).toBe("file");
      expect(getBlockType("doc.hwp")).toBe("file");
      expect(getBlockType("data.xls")).toBe("file");
    });

    it("확장자 없는 파일 → file 블록", () => {
      expect(getBlockType("Makefile")).toBe("file");
      expect(getBlockType("README")).toBe("file");
    });

    it("대소문자 무관", () => {
      expect(getBlockType("photo.PNG")).toBe("image");
      expect(getBlockType("video.MP4")).toBe("video");
      expect(getBlockType("music.MP3")).toBe("audio");
    });
  });

  describe("getMimeType", () => {
    it("이미지 MIME 타입", () => {
      expect(getMimeType("photo.png")).toBe("image/png");
      expect(getMimeType("photo.jpg")).toBe("image/jpeg");
      expect(getMimeType("photo.gif")).toBe("image/gif");
      expect(getMimeType("photo.webp")).toBe("image/webp");
      expect(getMimeType("photo.svg")).toBe("image/svg+xml");
    });

    it("문서 MIME 타입", () => {
      expect(getMimeType("doc.pdf")).toBe("application/pdf");
      expect(getMimeType("doc.docx")).toBe(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
      expect(getMimeType("data.xlsx")).toBe(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      expect(getMimeType("archive.zip")).toBe("application/zip");
    });

    it("미디어 MIME 타입", () => {
      expect(getMimeType("video.mp4")).toBe("video/mp4");
      expect(getMimeType("video.webm")).toBe("video/webm");
      expect(getMimeType("music.mp3")).toBe("audio/mpeg");
      expect(getMimeType("music.wav")).toBe("audio/wav");
    });

    it("알 수 없는 확장자 → application/octet-stream", () => {
      expect(getMimeType("file.xyz")).toBe("application/octet-stream");
      expect(getMimeType("Makefile")).toBe("application/octet-stream");
    });

    it("코드 파일 MIME 타입", () => {
      expect(getMimeType("code.py")).toBe("text/x-python");
      expect(getMimeType("data.json")).toBe("application/json");
      expect(getMimeType("data.csv")).toBe("text/csv");
    });
  });

  // Obsidian 어댑터는 .base 를 걸러주지 않고, node VaultFS 도 이제 .base 를 반환한다.
  // FileHandler 가 도구 내부 산출물을 첨부 업로드에서 일괄 차단하는지 잠근다.
  describe("내부 산출물(.base/.notion.json) 첨부 업로드 차단", () => {
    it("pushAllFiles: 사이드카·베이스 파일은 업로드하지 않는다", async () => {
      const vaultFs = createMockVaultFs();
      (vaultFs.listNonMarkdownFiles as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "para/사진.png", size: 10, mtime: "2026-01-01T00:00:00.000Z" },
        { path: "para/0. 인박스.base", size: 20, mtime: "2026-01-01T00:00:00.000Z" },
        { path: "para/0. 인박스.notion.json", size: 30, mtime: "2026-01-01T00:00:00.000Z" },
      ]);
      const stateDb = createMockStateDb();
      stateDb.getByPath.mockReturnValue({ notionPageId: "folder-page-id" });
      const notion = createMockNotionClient();

      const handler = new FileHandler(
        vaultFs,
        notion as unknown as NotionClient,
        stateDb as unknown as IStateDB,
      );
      const results = await handler.pushAllFiles();

      expect(results.map((r) => r.localPath)).toEqual(["para/사진.png"]);
      expect(notion.uploadFile).toHaveBeenCalledTimes(1);
    });

    it("pushFilesForFolder 도 동일하게 차단한다", async () => {
      const vaultFs = createMockVaultFs();
      (vaultFs.listNonMarkdownFiles as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "para/만다라트.base", size: 20, mtime: "2026-01-01T00:00:00.000Z" },
      ]);
      const stateDb = createMockStateDb();
      const notion = createMockNotionClient();

      const handler = new FileHandler(
        vaultFs,
        notion as unknown as NotionClient,
        stateDb as unknown as IStateDB,
      );
      const results = await handler.pushFilesForFolder("folder-page-id", "para");

      expect(results).toEqual([]);
      expect(notion.uploadFile).not.toHaveBeenCalled();
    });
  });

  /**
   * R9f — 첨부 1건 업로드의 시간 상한.
   *
   * 업로드는 호출 1건마다 상한이 있어도(SDK 30초) 멀티파트는 파트 수만큼 호출이 늘어나는
   * 합성 경로다. 끝나지 않는 업로드 하나가 세마포어를 쥔 채 남으면 push 전체가 멎는다.
   *
   * **두 경로를 모두 잠그는 것이 이 블록의 핵심이다.** R9a 는 같은 다운로드 로직이 두 벌
   * 존재한 탓에 한쪽만 상한이 걸린 채 남았던 사고였고, 여기도 같은 코드가 두 루프에
   * 나뉘어 있었다. 상한을 지우면 실패가 아니라 hang 으로 드러난다.
   */
  describe("첨부 업로드 시간 상한 (R9f)", () => {
    /** 절대 끝나지 않는 업로드 — 상한이 없으면 테스트가 hang 으로 드러난다. */
    const neverUpload = () => new Promise<never>(() => {});
    const ITEM_TIMEOUT_MS = 40;

    function captureWarnings(): string[] {
      const messages: string[] = [];
      setLogger({
        warn: (msg, ...rest) => messages.push([msg, ...rest.map(String)].join(" ")),
        error: () => {},
        info: () => {},
        debug: () => {},
      });
      return messages;
    }

    afterEach(() => {
      setLogger({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} });
    });

    it("pushAllFiles: 멈춘 첨부는 상한에서 끊기고 나머지는 계속 올라간다", async () => {
      const warnings = captureWarnings();
      const vaultFs = createMockVaultFs();
      (vaultFs.listNonMarkdownFiles as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "para/멈춘 첨부.png", size: 10, mtime: "2026-07-27T00:00:00.000Z" },
        { path: "para/정상 첨부.png", size: 11, mtime: "2026-07-27T00:00:00.000Z" },
      ]);
      const stateDb = createMockStateDb();
      stateDb.getByPath.mockReturnValue({ notionPageId: "folder-page-id" });
      const notion = createMockNotionClient();
      (notion.uploadFile as ReturnType<typeof vi.fn>).mockImplementation(
        (_buffer: Buffer, filename: string) =>
          filename.includes("멈춘") ? neverUpload() : Promise.resolve("upload-id"),
      );

      const handler = new FileHandler(
        vaultFs,
        notion as unknown as NotionClient,
        stateDb as unknown as IStateDB,
        2,
        { itemTimeoutMs: ITEM_TIMEOUT_MS },
      );
      const results = await handler.pushAllFiles();

      expect(results.map((r) => r.localPath)).toEqual(["para/정상 첨부.png"]);
      // 어느 첨부에서 멎었는지가 로그에 남아야 한다 — 조용히 사라지면 안 된다.
      expect(warnings.join("\n")).toContain("para/멈춘 첨부.png");
      expect(warnings.join("\n")).toContain("시간 상한 초과");
    });

    it("pushFilesForFolder 에도 같은 상한이 걸린다 (경로 비대칭 금지)", async () => {
      const warnings = captureWarnings();
      const vaultFs = createMockVaultFs();
      (vaultFs.listNonMarkdownFiles as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "para/멈춘 첨부.png", size: 10, mtime: "2026-07-27T00:00:00.000Z" },
      ]);
      const stateDb = createMockStateDb();
      const notion = createMockNotionClient();
      (notion.uploadFile as ReturnType<typeof vi.fn>).mockImplementation(neverUpload);

      const handler = new FileHandler(
        vaultFs,
        notion as unknown as NotionClient,
        stateDb as unknown as IStateDB,
        2,
        { itemTimeoutMs: ITEM_TIMEOUT_MS },
      );
      const results = await handler.pushFilesForFolder("folder-page-id", "para");

      expect(results).toEqual([]);
      expect(warnings.join("\n")).toContain("시간 상한 초과");
    });

    it("상한에 걸려도 슬롯을 반납해 다음 첨부가 막히지 않는다", async () => {
      captureWarnings();
      const vaultFs = createMockVaultFs();
      (vaultFs.listNonMarkdownFiles as ReturnType<typeof vi.fn>).mockResolvedValue([
        { path: "para/멈춘 1.png", size: 10, mtime: "2026-07-27T00:00:00.000Z" },
        { path: "para/멈춘 2.png", size: 11, mtime: "2026-07-27T00:00:00.000Z" },
        { path: "para/정상.png", size: 12, mtime: "2026-07-27T00:00:00.000Z" },
      ]);
      const stateDb = createMockStateDb();
      stateDb.getByPath.mockReturnValue({ notionPageId: "folder-page-id" });
      const notion = createMockNotionClient();
      (notion.uploadFile as ReturnType<typeof vi.fn>).mockImplementation(
        (_buffer: Buffer, filename: string) =>
          filename.includes("멈춘") ? neverUpload() : Promise.resolve("upload-id"),
      );

      // 동시성 1 — 상한이 슬롯을 놓지 않으면 세 번째 첨부는 영원히 차례가 오지 않는다.
      const handler = new FileHandler(
        vaultFs,
        notion as unknown as NotionClient,
        stateDb as unknown as IStateDB,
        1,
        { itemTimeoutMs: ITEM_TIMEOUT_MS },
      );
      const results = await handler.pushAllFiles();

      expect(results.map((r) => r.localPath)).toEqual(["para/정상.png"]);
    });
  });
});
