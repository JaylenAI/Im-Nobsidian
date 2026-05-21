import type { FileInfo } from "./change-detector.js";

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
