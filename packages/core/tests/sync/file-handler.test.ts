import { describe, it, expect } from "vitest";
import { getBlockType, getMimeType } from "../../src/sync/file-handler.js";

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
});
