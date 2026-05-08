import type { FileInfo } from "./change-detector.js";

export interface VaultFS {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  writeBinary(path: string, data: Buffer): Promise<void>;
  deleteFile(path: string): Promise<void>;
  moveFile(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  ensureFolder(path: string): Promise<void>;
  listMarkdownFiles(): Promise<FileInfo[]>;
}
