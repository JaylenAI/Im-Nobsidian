import type { FileInfo } from "./change-detector.js";
import { getLogger } from "../utils/logger.js";

export interface NonMdFileInfo {
  readonly path: string;
  readonly size: number;
  readonly mtime: string;
}

export interface FileStatInfo {
  readonly path: string;
  readonly mtime: string;
  readonly size: number;
}

export interface VaultFS {
  readFile(path: string): Promise<string>;
  readBinary(path: string): Promise<Buffer>;
  writeFile(path: string, content: string): Promise<void>;
  writeBinary(path: string, data: Buffer): Promise<void>;
  deleteFile(path: string): Promise<void>;
  moveFile(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  ensureFolder(path: string): Promise<void>;
  listMarkdownFiles(): Promise<FileInfo[]>;
  listMarkdownFileStats(): Promise<FileStatInfo[]>;
  listNonMarkdownFiles(): Promise<NonMdFileInfo[]>;
  getFileStat(path: string): Promise<FileStatInfo | null>;
}

/**
 * 받기 직전의 로컬 노트 — 없으면 undefined. 받은 글에서 Notion 이 담지 못한 표기(코드 펜스의 원래
 * 언어 S-20, 주석 S-29)를 되살리는 근거로만 쓴다(`localContent`). 그래서 읽지 못해도 받기를 멈추지 않고
 * undefined 를 돌려주되, 까닭을 경고로 남긴다 — 그 노트는 펜스 표기가 Notion 이름으로 바뀌고, 주석은
 * push 때 남긴 마커로 앵커 줄 다음에 들어간다.
 */
export async function readLocalNote(vaultFs: VaultFS, path: string): Promise<string | undefined> {
  try {
    if (!(await vaultFs.exists(path))) return undefined;
    return await vaultFs.readFile(path);
  } catch (error) {
    getLogger().warn(
      `[Im-Nobsidian] 로컬 노트를 읽지 못해 코드 펜스 표기 · 주석 자리 · frontmatter 의 로컬 키를 되살리지 못함 (${path}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}
