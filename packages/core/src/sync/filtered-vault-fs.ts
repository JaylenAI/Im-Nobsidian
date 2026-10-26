import type { FileInfo } from "./change-detector.js";
import type { FileStatInfo, NonMdFileInfo, VaultFS } from "./vault-fs.js";
import type { PathFilter } from "../utils/path-filter.js";

/**
 * 경로 패턴(`paths.include` · `paths.exclude` · `.im-nobsidian-ignore`)을 목록에 대는 VaultFS.
 *
 * CLI 는 볼트를 걸을 때 패턴을 대지만({@link NodeVaultFS}) 플러그인은 Obsidian 이 아는 파일 목록을 그대로 쓴다 —
 * 그래서 예전 플러그인은 패턴을 무시했다. 이 감싸개가 목록에서 뺀 파일을 지우고 `excludesPath` 를 답한다.
 * 뺀 노트는 목록에 없어도 「볼트에서 지움」 으로 보지 않는다 — 감지 · pull 이 `excludesPath` 로 가른다.
 *
 * 패턴은 감싼 VaultFS 의 경로(연결 폴더 기준)에 댄다 — CLI 가 연결 폴더에서 돌 때와 같다.
 */
export class FilteredVaultFS implements VaultFS {
  readonly ownsPath?: (path: string) => boolean;
  readonly holdsOtherConnection?: (folder: string) => boolean;

  constructor(
    private readonly inner: VaultFS,
    private readonly filter: PathFilter,
  ) {
    // 있을 때만 둔다 — 없으면 「전부 맡는다」 로 읽는 쪽이 있다(`assertConnectionScope`).
    if (inner.ownsPath) this.ownsPath = (path) => inner.ownsPath!(path);
    if (inner.holdsOtherConnection) {
      this.holdsOtherConnection = (folder) => inner.holdsOtherConnection!(folder);
    }
  }

  excludesPath(path: string, kind: "file" | "folder" = "file"): boolean {
    const excluded =
      kind === "folder" ? this.filter.excludesFolder(path) : this.filter.excludesFile(path);
    return excluded || (this.inner.excludesPath?.(path, kind) ?? false);
  }

  async listMarkdownFiles(): Promise<FileInfo[]> {
    return (await this.inner.listMarkdownFiles()).filter((f) => !this.filter.excludesFile(f.path));
  }

  async listMarkdownFileStats(): Promise<FileStatInfo[]> {
    return (await this.inner.listMarkdownFileStats()).filter(
      (f) => !this.filter.excludesFile(f.path),
    );
  }

  async listNonMarkdownFiles(): Promise<NonMdFileInfo[]> {
    return (await this.inner.listNonMarkdownFiles()).filter(
      (f) => !this.filter.excludesFile(f.path),
    );
  }

  readFile(path: string): Promise<string> {
    return this.inner.readFile(path);
  }

  readBinary(path: string): Promise<Buffer> {
    return this.inner.readBinary(path);
  }

  writeFile(path: string, content: string): Promise<void> {
    return this.inner.writeFile(path, content);
  }

  writeBinary(path: string, data: Buffer): Promise<void> {
    return this.inner.writeBinary(path, data);
  }

  deleteFile(path: string): Promise<void> {
    return this.inner.deleteFile(path);
  }

  moveFile(from: string, to: string): Promise<void> {
    return this.inner.moveFile(from, to);
  }

  exists(path: string): Promise<boolean> {
    return this.inner.exists(path);
  }

  ensureFolder(path: string): Promise<void> {
    return this.inner.ensureFolder(path);
  }

  getFileStat(path: string): Promise<FileStatInfo | null> {
    return this.inner.getFileStat(path);
  }
}
