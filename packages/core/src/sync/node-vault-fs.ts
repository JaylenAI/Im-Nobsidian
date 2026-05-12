import { readFile, writeFile, unlink, rename, mkdir, readdir, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import type { VaultFS } from "./vault-fs.js";
import type { FileInfo } from "./change-detector.js";

export interface PathFilterConfig {
  readonly include?: string[];
  readonly exclude?: string[];
}

export class NodeVaultFS implements VaultFS {
  private readonly includePatterns: string[];
  private readonly excludePatterns: string[];

  constructor(
    private readonly rootPath: string,
    pathConfig?: PathFilterConfig,
  ) {
    this.includePatterns = pathConfig?.include ?? [];
    const configExclude = pathConfig?.exclude ?? [];
    const ignorePatterns = this.loadImNobsidianIgnore();
    this.excludePatterns = [...configExclude, ...ignorePatterns];
  }

  private loadImNobsidianIgnore(): string[] {
    try {
      const ignorePath = join(this.rootPath, ".im-nobsidian-ignore");
      const content = readFileSync(ignorePath, "utf-8");
      return content
        .split("\n")
        .map((line: string) => line.trim())
        .filter((line: string) => line && !line.startsWith("#"));
    } catch {
      return [];
    }
  }

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

  private matchesPattern(relativePath: string, pattern: string): boolean {
    if (pattern.endsWith("/**")) {
      const dir = pattern.slice(0, -3);
      return relativePath.startsWith(dir + "/") || relativePath === dir;
    } else if (pattern.startsWith("*.")) {
      const ext = pattern.slice(1);
      return relativePath.endsWith(ext);
    } else if (pattern.includes("*")) {
      const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, "[^/]*") + "$");
      return regex.test(relativePath);
    } else {
      return relativePath === pattern || relativePath.startsWith(pattern + "/");
    }
  }

  private isExcluded(relativePath: string): boolean {
    if (this.includePatterns.length > 0) {
      const included = this.includePatterns.some((p) => this.matchesPattern(relativePath, p));
      if (!included) return true;
    }

    return this.excludePatterns.some((p) => this.matchesPattern(relativePath, p));
  }

  private async walkDir(dir: string, result: FileInfo[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.name.startsWith(".")) continue;

      const relativePath = relative(this.rootPath, fullPath);

      if (this.isExcluded(relativePath)) continue;

      if (entry.isDirectory()) {
        await this.walkDir(fullPath, result);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
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
