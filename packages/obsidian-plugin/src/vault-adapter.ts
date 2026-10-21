import type { Vault } from "obsidian";
import { TFile, TFolder, normalizePath } from "obsidian";
import type { VaultFS, FileInfo, FileStatInfo, NonMdFileInfo } from "@im-nobsidian/core";
import { isInternalPath } from "@im-nobsidian/core";

export class ObsidianVaultAdapter implements VaultFS {
  /** 지금 이 어댑터가 쓰는 · 지우는 · 옮기는 경로 — 경로마다 겹친 호출 수. */
  private readonly changing = new Map<string, number>();

  constructor(private readonly vault: Vault) {}

  /**
   * 이 볼트 이벤트가 이 어댑터가 부른 쓰기의 것인가. Obsidian 은 `create` · `modify` · `rename` · `delete` 이벤트를
   * 그 호출이 끝나기 전에 보낸다(1.13.7 실측) — 그래서 호출하는 동안만 경로를 적어 두면 가릴 수 있다. 폴더를 옮기면
   * 안의 노트도 이벤트를 받으므로 그 아래 경로도 이 어댑터의 것이다.
   *
   * 동기화가 받아 쓴 노트의 이벤트가 동기화를 또 불렀다 — 끝나면 한 번 더 돌아 Notion 에 다시 물었다(D4).
   */
  isOwnChange(path: string): boolean {
    const normalized = normalizePath(path);
    for (const own of this.changing.keys()) {
      if (normalized === own || normalized.startsWith(`${own}/`)) return true;
    }
    return false;
  }

  private async changingPaths<T>(paths: readonly string[], run: () => Promise<T>): Promise<T> {
    for (const path of paths) this.changing.set(path, (this.changing.get(path) ?? 0) + 1);
    try {
      return await run();
    } finally {
      for (const path of paths) {
        const left = this.changing.get(path)! - 1;
        if (left === 0) this.changing.delete(path);
        else this.changing.set(path, left);
      }
    }
  }

  async readFile(path: string): Promise<string> {
    const file = this.vault.getAbstractFileByPath(normalizePath(path));
    if (!file || !(file instanceof TFile)) {
      throw new Error(`파일을 찾을 수 없습니다: ${path}`);
    }
    return this.vault.read(file);
  }

  async readBinary(path: string): Promise<Buffer> {
    const file = this.vault.getAbstractFileByPath(normalizePath(path));
    if (!file || !(file instanceof TFile)) {
      throw new Error(`파일을 찾을 수 없습니다: ${path}`);
    }
    const arrayBuffer = await this.vault.readBinary(file);
    return Buffer.from(arrayBuffer);
  }

  async writeFile(path: string, content: string): Promise<void> {
    const normalized = normalizePath(path);
    await this.changingPaths([normalized], () => this.writeText(normalized, content));
  }

  private async writeText(normalized: string, content: string): Promise<void> {
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
    await this.changingPaths([normalized], () => this.writeBytes(normalized, data));
  }

  private async writeBytes(normalized: string, data: Buffer): Promise<void> {
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
      await this.changingPaths([file.path], () => this.vault.trash(file, true));
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

    const target = normalizePath(to);
    await this.changingPaths([file.path, target], () => this.vault.rename(file, target));
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
      if (isInternalPath(file.path)) continue;

      const content = await this.vault.read(file);
      result.push({
        path: file.path,
        content,
        mtime: new Date(file.stat.mtime).toISOString(),
      });
    }

    return result;
  }

  async listMarkdownFileStats(): Promise<FileStatInfo[]> {
    const files = this.vault.getMarkdownFiles();
    const result: FileStatInfo[] = [];

    for (const file of files) {
      if (isInternalPath(file.path)) continue;
      result.push({
        path: file.path,
        mtime: new Date(file.stat.mtime).toISOString(),
        size: file.stat.size,
      });
    }

    return result;
  }

  async getFileStat(path: string): Promise<FileStatInfo | null> {
    const file = this.vault.getAbstractFileByPath(normalizePath(path));
    if (!file || !(file instanceof TFile)) return null;
    return {
      path: file.path,
      mtime: new Date(file.stat.mtime).toISOString(),
      size: file.stat.size,
    };
  }

  async listNonMarkdownFiles(): Promise<NonMdFileInfo[]> {
    const allFiles = this.vault.getFiles();
    const result: NonMdFileInfo[] = [];

    for (const file of allFiles) {
      if (file.extension === "md") continue;
      if (isInternalPath(file.path)) continue;

      result.push({
        path: file.path,
        size: file.stat.size,
        mtime: new Date(file.stat.mtime).toISOString(),
      });
    }

    return result;
  }
}
