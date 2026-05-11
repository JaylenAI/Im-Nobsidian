import { readFile, writeFile, unlink, rename, mkdir, readdir, stat } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import type { VaultFS } from "./vault-fs.js";
import type { FileInfo } from "./change-detector.js";

export class NodeVaultFS implements VaultFS {
  constructor(private readonly rootPath: string) {}

  async readFile(path: string): Promise<string> {
    const fullPath = join(this.rootPath, path);
    return readFile(fullPath, "utf-8");
  }

  async writeFile(path: string, content: string): Promise<void> {
    const fullPath = join(this.rootPath, path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }

  async writeBinary(path: string, data: Buffer): Promise<void> {
    const fullPath = join(this.rootPath, path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, data);
  }

  async deleteFile(path: string): Promise<void> {
    const fullPath = join(this.rootPath, path);
    await unlink(fullPath);
  }

  async moveFile(from: string, to: string): Promise<void> {
    const fromPath = join(this.rootPath, from);
    const toPath = join(this.rootPath, to);
    await mkdir(dirname(toPath), { recursive: true });
    await rename(fromPath, toPath);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(join(this.rootPath, path));
      return true;
    } catch {
      return false;
    }
  }

  async ensureFolder(path: string): Promise<void> {
    await mkdir(join(this.rootPath, path), { recursive: true });
  }

  async listMarkdownFiles(): Promise<FileInfo[]> {
    const files: FileInfo[] = [];
    await this.walkDir(this.rootPath, files);
    return files;
  }

  private async walkDir(dir: string, result: FileInfo[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.name.startsWith(".")) continue;

      if (entry.isDirectory()) {
        await this.walkDir(fullPath, result);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const content = await readFile(fullPath, "utf-8");
        const fileStat = await stat(fullPath);
        const relativePath = relative(this.rootPath, fullPath);

        result.push({
          path: relativePath,
          content,
          mtime: fileStat.mtime.toISOString(),
        });
      }
    }
  }
}
