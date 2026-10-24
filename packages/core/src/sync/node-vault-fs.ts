import { readFile, writeFile, unlink, rename, mkdir, readdir, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import type { VaultFS, NonMdFileInfo, FileStatInfo } from "./vault-fs.js";
import type { FileInfo } from "./change-detector.js";
import { IGNORE_FILE } from "../constants/paths.js";
import { isMarkdownPath } from "../utils/markdown-path.js";
import { PathFilter, toVaultPath } from "../utils/path-filter.js";

export interface PathFilterConfig {
  readonly include?: string[];
  readonly exclude?: string[];
}

export class NodeVaultFS implements VaultFS {
  private readonly filter: PathFilter;

  constructor(
    private readonly rootPath: string,
    pathConfig?: PathFilterConfig,
  ) {
    const configExclude = pathConfig?.exclude ?? [];
    const ignorePatterns = this.loadImNobsidianIgnore();
    this.filter = new PathFilter(pathConfig?.include ?? [], [...configExclude, ...ignorePatterns]);
  }

  excludesPath(path: string, kind: "file" | "folder" = "file"): boolean {
    return kind === "folder" ? this.filter.excludesFolder(path) : this.filter.excludesFile(path);
  }

  private loadImNobsidianIgnore(): string[] {
    try {
      const ignorePath = join(this.rootPath, IGNORE_FILE);
      const content = readFileSync(ignorePath, "utf-8");
      return content
        .split("\n")
        .map((line: string) => line.trim())
        .filter((line: string) => line && !line.startsWith("#"));
    } catch (error) {
      // 읽지 못한 제외 파일을 빈 목록으로 보면 제외했던 파일이 말없이 올라간다 — 없을 때만 빈 목록이다.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async readFile(path: string): Promise<string> {
    const fullPath = join(this.rootPath, path);
    return readFile(fullPath, "utf-8");
  }

  async readBinary(path: string): Promise<Buffer> {
    const fullPath = join(this.rootPath, path);
    return readFile(fullPath);
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

  async listMarkdownFileStats(): Promise<FileStatInfo[]> {
    const stats: FileStatInfo[] = [];
    await this.walkDirStats(this.rootPath, stats);
    return stats;
  }

  async getFileStat(path: string): Promise<FileStatInfo | null> {
    try {
      const fullPath = join(this.rootPath, path);
      const fileStat = await stat(fullPath);
      return { path, mtime: fileStat.mtime.toISOString(), size: fileStat.size };
    } catch {
      return null;
    }
  }

  async listNonMarkdownFiles(): Promise<NonMdFileInfo[]> {
    const files: NonMdFileInfo[] = [];
    await this.walkDirNonMd(this.rootPath, files);
    return files;
  }

  /** 볼트 경로 — Windows 의 `relative()` 는 `\` 로 잇는다. 상태 DB · 패턴 · Notion 경로는 모두 `/` 다. */
  private vaultPath(fullPath: string): string {
    return toVaultPath(relative(this.rootPath, fullPath), sep);
  }

  private async walkDirNonMd(dir: string, result: NonMdFileInfo[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.name.startsWith(".")) continue;

      const relativePath = this.vaultPath(fullPath);

      if (entry.isDirectory()) {
        if (this.filter.excludesFolder(relativePath)) continue;
        await this.walkDirNonMd(fullPath, result);
        // .base 도 포함해 반환한다 — 여기서 빼면 DB rename 고아 .base 정리
        // (cleanupStaleDbArtifacts)가 영원히 못 본다. 첨부 업로드 제외는
        // 소비자(FileHandler.listUploadableFiles)가 책임진다.
      } else if (
        entry.isFile() &&
        !isMarkdownPath(entry.name) &&
        !this.filter.excludesFile(relativePath)
      ) {
        const fileStat = await stat(fullPath);
        result.push({
          path: relativePath,
          size: fileStat.size,
          mtime: fileStat.mtime.toISOString(),
        });
      }
    }
  }

  private async walkDirStats(dir: string, result: FileStatInfo[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.name.startsWith(".")) continue;

      const relativePath = this.vaultPath(fullPath);

      if (entry.isDirectory()) {
        if (this.filter.excludesFolder(relativePath)) continue;
        await this.walkDirStats(fullPath, result);
      } else if (
        entry.isFile() &&
        isMarkdownPath(entry.name) &&
        !this.filter.excludesFile(relativePath)
      ) {
        const fileStat = await stat(fullPath);
        result.push({
          path: relativePath,
          mtime: fileStat.mtime.toISOString(),
          size: fileStat.size,
        });
      }
    }
  }

  private async walkDir(dir: string, result: FileInfo[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.name.startsWith(".")) continue;

      const relativePath = this.vaultPath(fullPath);

      if (entry.isDirectory()) {
        if (this.filter.excludesFolder(relativePath)) continue;
        await this.walkDir(fullPath, result);
      } else if (
        entry.isFile() &&
        isMarkdownPath(entry.name) &&
        !this.filter.excludesFile(relativePath)
      ) {
        const content = await readFile(fullPath, "utf-8");
        const fileStat = await stat(fullPath);

        result.push({
          path: relativePath,
          content,
          mtime: fileStat.mtime.toISOString(),
        });
      }
    }
  }
}
