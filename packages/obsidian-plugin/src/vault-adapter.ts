import type { Vault } from "obsidian";
import { TFile, TFolder, normalizePath } from "obsidian";
import type { VaultFS, FileInfo } from "@im-nobsidian/core";

export class ObsidianVaultAdapter implements VaultFS {
  constructor(private readonly vault: Vault) {}

  async readFile(path: string): Promise<string> {
    const file = this.vault.getAbstractFileByPath(normalizePath(path));
    if (!file || !(file instanceof TFile)) {
      throw new Error(`파일을 찾을 수 없습니다: ${path}`);
    }
    return this.vault.read(file);
  }

  async writeFile(path: string, content: string): Promise<void> {
    const normalized = normalizePath(path);
    const existing = this.vault.getAbstractFileByPath(normalized);

    if (existing && existing instanceof TFile) {
      await this.vault.modify(existing, content);
    } else {
      const dir = normalized.substring(0, normalized.lastIndexOf("/"));
      if (dir) {
        await this.ensureFolder(dir);
      }
      await this.vault.create(normalized, content);
    }
  }

  async writeBinary(path: string, data: Buffer): Promise<void> {
    const normalized = normalizePath(path);
    const existing = this.vault.getAbstractFileByPath(normalized);

    if (existing && existing instanceof TFile) {
      await this.vault.modifyBinary(
        existing,
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
      );
    } else {
      const dir = normalized.substring(0, normalized.lastIndexOf("/"));
      if (dir) {
        await this.ensureFolder(dir);
      }
      await this.vault.createBinary(
        normalized,
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
      );
    }
  }

  async deleteFile(path: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(normalizePath(path));
    if (file) {
      await this.vault.trash(file, true);
    }
  }

  async moveFile(from: string, to: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(normalizePath(from));
    if (!file) {
      throw new Error(`파일을 찾을 수 없습니다: ${from}`);
    }

    const toDir = normalizePath(to).substring(0, to.lastIndexOf("/"));
    if (toDir) {
      await this.ensureFolder(toDir);
    }

    await this.vault.rename(file, normalizePath(to));
  }

  async exists(path: string): Promise<boolean> {
    return this.vault.getAbstractFileByPath(normalizePath(path)) !== null;
  }

  async ensureFolder(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const existing = this.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFolder) return;

    await this.vault.createFolder(normalized).catch(() => {
      // 이미 존재하는 경우 무시
    });
  }

  async listMarkdownFiles(): Promise<FileInfo[]> {
    const files = this.vault.getMarkdownFiles();
    const result: FileInfo[] = [];

    for (const file of files) {
      if (file.path.startsWith(".im-nobsidian/")) continue;

      const content = await this.vault.read(file);
      result.push({
        path: file.path,
        content,
        mtime: new Date(file.stat.mtime).toISOString(),
      });
    }

    return result;
  }
}
