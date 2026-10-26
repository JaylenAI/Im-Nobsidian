import type { IStateDB } from "../state/state-db-interface.js";
import type { RemoteMove } from "../types/sync.js";
import { computeHash } from "../utils/hash.js";
import { rewriteLinks } from "../utils/link-rewrite.js";
import { getLogger } from "../utils/logger.js";
import type { VaultFS } from "./vault-fs.js";

/**
 * 동기화가 옮기거나 이름을 바꾼 노트 · 폴더를 가리키던 다른 노트의 링크를 고친다({@link rewriteLinks}).
 *
 * Obsidian 의 「링크 자동 갱신」 은 사용자가 옮길 때만 돈다 — 동기화는 `vault.rename`(플러그인) · 파일 시스템(CLI)으로
 * 옮기므로 그대로 두면 `[[옛 이름]]` 과 경로로 적은 링크가 끊긴다. 이 연결이 보는 노트만 고친다 — 경로 패턴이 뺀 노트 ·
 * 다른 연결 폴더의 노트는 두지 않는다.
 *
 * 동기화된 노트(지난 사본 그대로)는 고친 글을 사본으로 적는다 — Notion 의 링크는 페이지를 가리켜 그대로이므로, 다음
 * push 가 링크만 고친 노트를 다시 올리지 않게 한다. 올리지 않은 편집이 있는 노트는 그 편집과 함께 올라간다.
 */
export class LinkUpdater {
  constructor(
    private readonly stateDb: IStateDB,
    private readonly vaultFs: VaultFS,
  ) {}

  /**
   * @param moves 옮긴 차례 그대로의 이동 — 노트 하나거나 폴더 하나.
   * @returns 링크를 고친 노트.
   */
  async apply(moves: readonly RemoteMove[]): Promise<string[]> {
    if (moves.length === 0) return [];
    const notes = await this.vaultFs.listMarkdownFiles();
    const others = await this.vaultFs.listNonMarkdownFiles();
    const after = new Set([...notes, ...others].map((file) => file.path));
    const renames = new Map<string, string>();
    for (const path of after) {
      const before = undo(path, moves);
      if (before !== path) renames.set(before, path);
    }
    if (renames.size === 0) return [];
    const before = new Set([...after].map((path) => undo(path, moves)));
    const context = { before, after, renames };

    const relinked: string[] = [];
    for (const note of notes) {
      const source = { from: undo(note.path, moves), to: note.path };
      const next = rewriteLinks(note.content, source, context);
      if (next === note.content) continue;
      try {
        await this.vaultFs.writeFile(note.path, next);
      } catch (error) {
        getLogger().warn(
          `[Im-Nobsidian] 옮긴 노트를 가리키던 링크를 고치지 못함 (${note.path}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        continue;
      }
      const record = this.stateDb.getByPath(note.path);
      if (record && record.contentHash === computeHash(note.content)) {
        this.stateDb.updateHash(record.id, computeHash(next), Buffer.from(next, "utf-8"));
        const stat = await this.vaultFs.getFileStat(note.path);
        if (stat) this.stateDb.updateStatCache(record.id, stat.mtime, stat.size);
      }
      relinked.push(note.path);
    }
    if (relinked.length > 0) {
      getLogger().info(`[Im-Nobsidian] 옮긴 노트를 가리키던 링크를 고침: 노트 ${relinked.length}`);
    }
    return relinked;
  }
}

/** 지금 경로 → 옮기기 전 경로 — 옮긴 차례를 거꾸로 되짚는다. */
function undo(path: string, moves: readonly RemoteMove[]): string {
  let current = path;
  for (let i = moves.length - 1; i >= 0; i--) {
    const move = moves[i]!;
    if (current === move.to || current.startsWith(`${move.to}/`)) {
      current = move.from + current.slice(move.to.length);
    }
  }
  return current;
}
