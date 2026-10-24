/**
 * 볼트 하나에 연결 여럿 (ADR-038) — 연결마다 볼트 안의 폴더 하나를 맡는다.
 *
 * 연결 폴더는 자기 `.im-nobsidian/`(설정 · 상태 DB · 보기 설정)를 둔다. 엔진은 그 폴더를 볼트처럼 다루고
 * ({@link ScopedVaultFS}), 바깥 연결은 안쪽 연결 폴더를 읽어 올리지도 쓰지도 않는다. 볼트 맨 위의 연결은
 * 폴더 `""` 이다 — 예전부터 쓰던 단일 연결이 그대로 그것이다.
 */
import type { FileInfo } from "./change-detector.js";
import type { FileStatInfo, NonMdFileInfo, VaultFS } from "./vault-fs.js";
import { isInternalPath } from "../constants/paths.js";
import { matchesPathScope } from "../utils/path-scope.js";

/** 이 연결이 맡지 않은 곳에 쓰려 했다 — 폴더 밖이거나 다른 연결 폴더 안이다. */
export class ConnectionBoundaryError extends Error {
  /**
   * @param folder 막은 연결 폴더 — `inside` 면 안쪽의 다른 연결, `outside` 면 이 연결.
   */
  constructor(
    readonly path: string,
    readonly folder: string,
    readonly where: "inside" | "outside",
  ) {
    super(
      where === "inside"
        ? `「${path}」 는 다른 연결 폴더(${folder}) 안이라 이 연결이 쓰지 않습니다`
        : `「${path}」 는 이 연결 폴더(${folder}) 밖이라 쓰지 않습니다`,
    );
    this.name = "ConnectionBoundaryError";
  }
}

/**
 * 이 연결의 상태 DB 가 다른 연결 폴더 안의 노트를 추적하고 있다 — 이미 동기화하던 폴더를 따로 연결했다.
 *
 * 그대로 돌리면 바깥 연결은 그 노트들을 「볼트에서 지움」 으로 보고(목록에 없으므로) Notion 페이지를 지우거나,
 * 되살리려고 그 폴더에 쓰려 한다. 둘 다 사용자가 바란 것이 아니므로 아무것도 하지 않고 멈춘다.
 */
export class ConnectionScopeError extends Error {
  constructor(readonly paths: readonly string[]) {
    super(
      `이 연결이 추적하던 노트 ${paths.length}개(${paths.slice(0, 3).join(", ")}${
        paths.length > 3 ? " …" : ""
      })가 이제 다른 연결 폴더 안에 있어 동기화를 멈췄습니다. 이미 동기화하던 폴더는 따로 연결할 수 없습니다 — ` +
        "그 폴더의 .im-nobsidian 폴더를 지워 연결을 되돌리세요",
    );
    this.name = "ConnectionScopeError";
  }
}

/** 앞뒤 `/` 를 떼고 `.` · `..` 를 푼 POSIX 경로. 볼트 맨 위를 벗어나면 null. */
export function normalizeVaultPath(path: string): string | null {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

/** `path` 를 맡은 연결 폴더 — 가장 깊은 것. 어느 것도 아니면 null(`""` 연결이 있으면 그것). */
export function connectionFolderOf(path: string, folders: readonly string[]): string | null {
  let best: string | null = null;
  for (const folder of folders) {
    if (!matchesPathScope(path, folder)) continue;
    if (best === null || folder.length > best.length) best = folder;
  }
  return best;
}

/** 한 연결 폴더에서 Obsidian 설정 폴더까지의 상대 경로 — `Work/Team` 이면 `../../.obsidian`. */
export function configDirFrom(folder: string, configDir: string): string {
  const depth = folder === "" ? 0 : folder.split("/").length;
  return `${"../".repeat(depth)}${configDir}`;
}

/**
 * 볼트의 한 연결 폴더를 볼트처럼 보이는 VaultFS. 경로는 그 폴더 기준이다.
 *
 * - 목록은 폴더 안 · 안쪽 연결 폴더 밖의 파일만, 이 연결의 내부 폴더(`.im-nobsidian/`)는 빼고 낸다
 * - 쓰기(쓰기 · 지우기 · 옮기기 · 폴더 만들기)는 폴더를 벗어나거나 안쪽 연결 폴더에 닿으면
 *   {@link ConnectionBoundaryError} 로 거절한다 — pull 이 다른 연결의 노트를 덮어쓰지 않는다
 * - 읽기는 볼트 안이면 폴더 밖도 된다(`../.obsidian/types.json` — Obsidian 설정은 볼트 맨 위에 하나다)
 */
export class ScopedVaultFS implements VaultFS {
  private readonly folder: string;
  private readonly nested: readonly string[];

  /**
   * @param folder 이 연결의 폴더(볼트 상대). `""` 이면 볼트 맨 위.
   * @param connections 볼트의 연결 폴더 전부 — 이 폴더 안쪽 것만 골라 비켜 간다.
   */
  constructor(
    private readonly base: VaultFS,
    folder: string,
    connections: readonly string[],
  ) {
    this.folder = normalizeVaultPath(folder) ?? "";
    this.nested = connections
      .map((c) => normalizeVaultPath(c) ?? "")
      .filter((c) => c !== this.folder && matchesPathScope(c, this.folder) && c !== "");
  }

  ownsPath(path: string): boolean {
    const joined = normalizeVaultPath(this.folder === "" ? path : `${this.folder}/${path}`);
    return (
      joined !== null &&
      matchesPathScope(joined, this.folder) &&
      connectionFolderOf(joined, this.nested) === null
    );
  }

  /** 이 연결의 경로 → 볼트 경로. */
  private toBase(path: string, write: boolean): string {
    const joined = normalizeVaultPath(this.folder === "" ? path : `${this.folder}/${path}`);
    if (joined === null) throw new Error(`볼트 밖 경로: ${path}`);
    if (write) {
      if (!matchesPathScope(joined, this.folder)) {
        throw new ConnectionBoundaryError(path, this.folder, "outside");
      }
      const owner = connectionFolderOf(joined, this.nested);
      if (owner !== null) throw new ConnectionBoundaryError(path, owner, "inside");
    }
    return joined;
  }

  /** 볼트 경로 → 이 연결의 경로. 이 연결이 맡지 않으면 null. */
  private fromBase(path: string): string | null {
    if (!matchesPathScope(path, this.folder) || path === this.folder) return null;
    if (connectionFolderOf(path, this.nested) !== null) return null;
    const local = this.folder === "" ? path : path.slice(this.folder.length + 1);
    return isInternalPath(local) ? null : local;
  }

  async readFile(path: string): Promise<string> {
    return await this.base.readFile(this.toBase(path, false));
  }

  async readBinary(path: string): Promise<Buffer> {
    return await this.base.readBinary(this.toBase(path, false));
  }

  async writeFile(path: string, content: string): Promise<void> {
    return await this.base.writeFile(this.toBase(path, true), content);
  }

  async writeBinary(path: string, data: Buffer): Promise<void> {
    return await this.base.writeBinary(this.toBase(path, true), data);
  }

  async deleteFile(path: string): Promise<void> {
    return await this.base.deleteFile(this.toBase(path, true));
  }

  async moveFile(from: string, to: string): Promise<void> {
    return await this.base.moveFile(this.toBase(from, true), this.toBase(to, true));
  }

  async exists(path: string): Promise<boolean> {
    return await this.base.exists(this.toBase(path, false));
  }

  async ensureFolder(path: string): Promise<void> {
    return await this.base.ensureFolder(this.toBase(path, true));
  }

  /** 맡은 노트만 읽는다 — 볼트 전체의 본문을 읽지 않는다. */
  async listMarkdownFiles(): Promise<FileInfo[]> {
    const stats = await this.listMarkdownFileStats();
    const files: FileInfo[] = [];
    for (const stat of stats) {
      files.push({ path: stat.path, content: await this.readFile(stat.path), mtime: stat.mtime });
    }
    return files;
  }

  async listMarkdownFileStats(): Promise<FileStatInfo[]> {
    return this.rebase(await this.base.listMarkdownFileStats());
  }

  async listNonMarkdownFiles(): Promise<NonMdFileInfo[]> {
    return this.rebase(await this.base.listNonMarkdownFiles());
  }

  async getFileStat(path: string): Promise<FileStatInfo | null> {
    const stat = await this.base.getFileStat(this.toBase(path, false));
    return stat ? { ...stat, path } : null;
  }

  private rebase<T extends { readonly path: string }>(items: readonly T[]): T[] {
    const out: T[] = [];
    for (const item of items) {
      const local = this.fromBase(item.path);
      if (local !== null) out.push({ ...item, path: local });
    }
    return out;
  }
}
