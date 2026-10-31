import { readFile, writeFile, unlink, rename, mkdir, readdir, rmdir, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import type { VaultFS, NonMdFileInfo, FileStatInfo } from "./vault-fs.js";
import type { FileInfo } from "./change-detector.js";
import { IGNORE_FILE } from "../constants/paths.js";
import { isMarkdownPath } from "../utils/markdown-path.js";
import { PathFilter, parseIgnorePatterns, toVaultPath } from "../utils/path-filter.js";

export interface PathFilterConfig {
  readonly include?: string[];
  readonly exclude?: string[];
}

/**
 * 볼트 경로는 NFC 다 — Obsidian 이 디스크의 NFD 이름(macOS Finder 가 만든 한글 이름 등)을 NFC 로 보이는 것과 같다
 * (2026-10-31 실측: Obsidian 1.12.4 의 `TFile.path` 는 NFC, NFD · NFC 어느 경로로도 읽힘). 예전 CLI 는 디스크 이름을
 * 그대로 써서 `[[회의록]]` 이 NFD 이름의 노트를 찾지 못했고, Notion 제목도 NFD 로 올렸다.
 */
export class NodeVaultFS implements VaultFS {
  private readonly filter: PathFilter;
  /**
   * NFC 볼트 경로 → 디스크의 상대 경로 — ASCII 가 아닌 이름(파일 · 폴더)만. 걸을 때 · 처음 열 때 채운다. 새로 만드는 이름은
   * NFC 로 쓴다.
   * Linux 는 두 꼴을 다른 이름으로 보므로 NFC 경로를 그대로 열면 NFD 파일 옆에 새 파일이 생긴다.
   */
  private readonly diskPaths = new Map<string, string>();

  /**
   * @param ignoreFile 폴더의 `.im-nobsidian-ignore` 를 따른다 — 볼트 전체를 보는 쪽(다른 연결의 노트에서 링크를 고칠 때)은
   *   그 폴더를 맡은 연결의 제외 목록을 따르지 않는다.
   */
  constructor(
    private readonly rootPath: string,
    pathConfig?: PathFilterConfig,
    ignoreFile = true,
  ) {
    const configExclude = pathConfig?.exclude ?? [];
    const ignorePatterns = ignoreFile ? this.loadImNobsidianIgnore() : [];
    this.filter = new PathFilter(pathConfig?.include ?? [], [...configExclude, ...ignorePatterns]);
  }

  excludesPath(path: string, kind: "file" | "folder" = "file"): boolean {
    return kind === "folder" ? this.filter.excludesFolder(path) : this.filter.excludesFile(path);
  }

  private loadImNobsidianIgnore(): string[] {
    try {
      const ignorePath = join(this.rootPath, IGNORE_FILE);
      return parseIgnorePatterns(readFileSync(ignorePath, "utf-8"));
    } catch (error) {
      // 읽지 못한 제외 파일을 빈 목록으로 보면 제외했던 파일이 말없이 올라간다 — 없을 때만 빈 목록이다.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async readFile(path: string): Promise<string> {
    const fullPath = await this.full(path);
    return readFile(fullPath, "utf-8");
  }

  async readBinary(path: string): Promise<Buffer> {
    const fullPath = await this.full(path);
    return readFile(fullPath);
  }

  async writeFile(path: string, content: string): Promise<void> {
    const fullPath = await this.full(path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
  }

  async writeBinary(path: string, data: Buffer): Promise<void> {
    const fullPath = await this.full(path);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, data);
  }

  async deleteFile(path: string): Promise<void> {
    await unlink(await this.full(path));
    this.forget(path);
  }

  /** `rmdir` 는 비지 않은 폴더를 지우지 않는다(ENOTEMPTY) — 숨김 파일도 그대로 둔다. */
  async removeEmptyFolder(path: string): Promise<boolean> {
    try {
      await rmdir(await this.full(path));
      this.forget(path);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOENT" || code === "ENOTDIR") {
        return false;
      }
      throw error;
    }
  }

  async moveFile(from: string, to: string): Promise<void> {
    const fromDisk = await this.onDisk(from);
    const toDisk = await this.onDisk(to);
    const toPath = join(this.rootPath, toDisk);
    await mkdir(dirname(toPath), { recursive: true });
    await rename(join(this.rootPath, fromDisk), toPath);
    // 옮긴 것 안의 NFD 이름은 새 자리에서도 그 이름이다.
    for (const [path, disk] of [...this.diskPaths]) {
      if (path !== from && !path.startsWith(`${from}/`)) continue;
      this.diskPaths.delete(path);
      const movedPath = to + path.slice(from.length);
      this.diskPaths.set(movedPath, toDisk + disk.slice(fromDisk.length));
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(await this.full(path));
      return true;
    } catch {
      return false;
    }
  }

  async ensureFolder(path: string): Promise<void> {
    await mkdir(await this.full(path), { recursive: true });
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
      const fullPath = await this.full(path);
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

  /**
   * 한 폴더의 항목과 그 볼트 경로 — 숨김(`.`)은 뺀다. 경로는 `/` 로 잇고(Windows 의 `\\` 가 아니라 — 상태 DB · 패턴 ·
   * Notion 경로는 모두 `/`), NFD 이름은 NFC 로 보이며 디스크 이름을 적어 둔다.
   *
   * 같은 폴더에 NFC 꼴의 이름이 따로 있으면(Linux 에서만 둘 다 있을 수 있다) NFC 경로는 그것의 것이고 NFD 쪽은 디스크
   * 이름 그대로 — 하나로 접으면 한쪽 노트가 보이지 않고 다른 쪽 파일을 읽는다. 걷는 차례와 무관하게 같은 답이 나온다.
   */
  private async entriesOf(dir: string, parent: string) {
    const entries = (await readdir(dir, { withFileTypes: true })).filter(
      (entry) => !entry.name.startsWith("."),
    );
    const taken = new Set(
      entries.map((entry) => entry.name).filter((name) => name === name.normalize("NFC")),
    );
    return entries.map((entry) => {
      const nfc = entry.name.normalize("NFC");
      const name = nfc === entry.name || !taken.has(nfc) ? nfc : entry.name;
      taken.add(name);
      const path = parent ? `${parent}/${name}` : name;
      const fullPath = join(dir, entry.name);
      const disk = toVaultPath(relative(this.rootPath, fullPath), sep);
      if (!isAscii(path)) this.diskPaths.set(path, disk);
      return { entry, fullPath, path };
    });
  }

  private async full(path: string): Promise<string> {
    return join(this.rootPath, await this.onDisk(path));
  }

  /**
   * 볼트 경로의 디스크 이름 — 위 폴더부터 같은 규칙으로. 걸으며 본 이름이면 그것. 아니면(걷기 전에 부른 이름) 디스크에
   * 그 꼴이 없고 NFC 로 같은 다른 꼴이 있을 때 그것을 쓴다 — Linux 는 두 꼴을 다른 이름으로 보아, 그대로 쓰면 NFD 파일
   * 옆에 새 파일이 생긴다. ASCII 이름은 보지 않는다.
   */
  private async onDisk(path: string): Promise<string> {
    const known = this.diskPaths.get(path);
    if (known !== undefined) return known;
    const slash = path.lastIndexOf("/");
    const parent = slash < 0 ? "" : await this.onDisk(path.slice(0, slash));
    const name = path.slice(slash + 1);
    const disk = parent ? `${parent}/${name}` : name;
    if (isAscii(name)) return disk;
    let names: string[];
    try {
      names = await readdir(join(this.rootPath, parent));
    } catch {
      return disk; // 위 폴더가 아직 없다 — 새로 만들 이름
    }
    const found = names.includes(name)
      ? name
      : names.find((other) => other !== name && other.normalize("NFC") === name);
    if (found === undefined) return disk; // 새로 만들 이름 — 적어 두지 않는다
    const resolved = parent ? `${parent}/${found}` : found;
    this.diskPaths.set(path, resolved);
    return resolved;
  }

  /** 지운 것 아래의 디스크 이름을 잊는다. */
  private forget(path: string): void {
    for (const key of [...this.diskPaths.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.diskPaths.delete(key);
    }
  }

  private async walkDirNonMd(dir: string, result: NonMdFileInfo[], parent = ""): Promise<void> {
    for (const { entry, fullPath, path: relativePath } of await this.entriesOf(dir, parent)) {
      if (entry.isDirectory()) {
        if (this.filter.excludesFolder(relativePath)) continue;
        await this.walkDirNonMd(fullPath, result, relativePath);
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

  private async walkDirStats(dir: string, result: FileStatInfo[], parent = ""): Promise<void> {
    for (const { entry, fullPath, path: relativePath } of await this.entriesOf(dir, parent)) {
      if (entry.isDirectory()) {
        if (this.filter.excludesFolder(relativePath)) continue;
        await this.walkDirStats(fullPath, result, relativePath);
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

  private async walkDir(dir: string, result: FileInfo[], parent = ""): Promise<void> {
    for (const { entry, fullPath, path: relativePath } of await this.entriesOf(dir, parent)) {
      if (entry.isDirectory()) {
        if (this.filter.excludesFolder(relativePath)) continue;
        await this.walkDir(fullPath, result, relativePath);
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

function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) return false;
  return true;
}
