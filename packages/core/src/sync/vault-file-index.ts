/**
 * 노트가 이름만(또는 경로 끝만) 적은 첨부를 볼트 어디서든 찾는다 — Obsidian 이 `![[그림.png]]` 를 찾는 방식.
 *
 * 예전에는 노트 폴더 · 볼트 맨 위 · 첨부 폴더 세 곳만 봐서, Obsidian 설정 「첨부 위치: 현재 폴더 아래 하위 폴더」
 * (`노트폴더/attachments/그림.png`)나 다른 폴더에 둔 그림 · 아이콘은 올라가지 않았다(2026-11-02 실측: 아이콘 ENOENT).
 */
import type { VaultFS } from "./vault-fs.js";

/**
 * 한 번 만든 파일 목록을 다시 쓰는 시간(ms) — 한 번의 push 에서 찾는 것들이 목록 하나를 같이 쓴다. 없는 첨부가 많은 노트가
 * 찾을 때마다 볼트를 훑지 않게. 그 사이에 생긴 파일은 다음 push 가 찾는다.
 */
const INDEX_MAX_AGE_MS = 5_000;

/** Obsidian 은 링크의 대소문자를 가리지 않는다. 한글은 NFC 로 맞춘다. */
function keyOf(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function baseNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

export class VaultFileIndex {
  private byName: Map<string, string[]> | null = null;
  private builtAt = 0;

  constructor(
    private readonly vaultFs: VaultFS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * `linkpath`(이름 또는 경로 끝)로 끝나는 볼트 파일 — 가까운 것부터: 노트 폴더 안(얕은 것 먼저) → 짧은 경로 → 가나다. 지금
   * 있는 것만 돌려준다.
   */
  async find(linkpath: string, noteFolder?: string): Promise<string[]> {
    if (this.byName === null || this.now() - this.builtAt > INDEX_MAX_AGE_MS) await this.rebuild();
    const key = keyOf(linkpath.replace(/^\/+/, ""));
    const suffix = `/${key}`;
    const matches = (this.byName?.get(keyOf(baseNameOf(key))) ?? []).filter((path) => {
      const k = keyOf(path);
      return k === key || k.endsWith(suffix);
    });
    const existing: string[] = [];
    for (const path of rank(matches, noteFolder)) {
      if (await this.vaultFs.exists(path)) existing.push(path);
    }
    return existing;
  }

  private async rebuild(): Promise<void> {
    const byName = new Map<string, string[]>();
    let files: readonly { readonly path: string }[] = [];
    try {
      files = (await this.vaultFs.listNonMarkdownFiles()) ?? [];
    } catch {
      // 목록을 못 읽으면 이름으로 찾지 못할 뿐이다 — 세 곳 사다리의 오류가 그대로 남는다
    }
    for (const file of files) {
      const key = keyOf(baseNameOf(file.path));
      const list = byName.get(key) ?? [];
      list.push(file.path);
      byName.set(key, list);
    }
    this.byName = byName;
    this.builtAt = this.now();
  }
}

/** 노트 폴더 안(얕은 것 먼저) → 짧은 경로 → 가나다. */
function rank(paths: readonly string[], noteFolder: string | undefined): string[] {
  const inside = (path: string): number => {
    if (noteFolder === undefined) return Number.POSITIVE_INFINITY;
    const folder = folderOf(path);
    if (noteFolder === "") return folder.split("/").filter(Boolean).length;
    if (folder !== noteFolder && !folder.startsWith(`${noteFolder}/`))
      return Number.POSITIVE_INFINITY;
    return folder.slice(noteFolder.length).split("/").filter(Boolean).length;
  };
  return [...paths].sort(
    (a, b) => inside(a) - inside(b) || a.length - b.length || a.localeCompare(b),
  );
}
