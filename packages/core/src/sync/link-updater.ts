import type { IStateDB } from "../state/state-db-interface.js";
import type { RemoteMove } from "../types/sync.js";
import { computeHash } from "../utils/hash.js";
import { rewriteLinks } from "../utils/link-rewrite.js";
import { getLogger } from "../utils/logger.js";
import { isMarkdownPath } from "../utils/markdown-path.js";
import type { VaultFS } from "./vault-fs.js";

/**
 * 동기화가 옮기거나 이름을 바꾼 노트 · 폴더를 가리키던 다른 노트의 링크를 고친다({@link rewriteLinks}).
 *
 * Obsidian 의 「링크 자동 갱신」 은 사용자가 옮길 때만 돈다 — 동기화는 `vault.rename`(플러그인) · 파일 시스템(CLI)으로
 * 옮기므로 그대로 두면 `[[옛 이름]]` 과 경로로 적은 링크가 끊긴다. 이 연결이 보는 노트만 고친다 — 경로 패턴이 뺀 노트 ·
 * 다른 연결 폴더의 노트는 두지 않는다.
 *
 * 동기화된 노트(지난 사본 그대로)는 노트로 가는 링크만 고쳤으면 고친 글을 사본으로 적는다 — Notion 의 링크는 페이지를
 * 가리켜 그대로이므로, 다음 push 가 링크만 고친 노트를 다시 올리지 않게 한다. 노트가 아닌 파일(`.base` · 첨부)로 가는
 * 링크를 고쳤으면 사본으로 적지 않아 다음 push 가 올린다 — Notion 은 그 경로를 글자로 들고 있어(`local-file` 마커), 올리지
 * 않으면 그 페이지를 다시 받을 때 옛 경로가 돌아와 임베드가 깨진다(2026-10-30 실측). 올리지 않은 편집이 있는 노트는 그
 * 편집과 함께 올라간다.
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
    const noteRenames = new Map([...renames].filter(([from]) => isMarkdownPath(from)));

    const relinked: string[] = [];
    for (const note of notes) {
      const source = { from: undo(note.path, moves), to: note.path };
      const next = rewriteLinks(note.content, source, context);
      if (next === note.content) continue;
      const notesOnly =
        noteRenames.size === renames.size ||
        rewriteLinks(note.content, source, { ...context, renames: noteRenames }) === next;
      if (await this.rewrite(note, next, notesOnly)) relinked.push(note.path);
    }
    if (relinked.length > 0) {
      getLogger().info(`[Im-Nobsidian] 옮긴 노트를 가리키던 링크를 고침: 노트 ${relinked.length}`);
    }
    return relinked;
  }

  /**
   * 치운 `.base` 를 넣은 줄을 뺀다 — Notion 에서 지운 링크드 뷰라 pull 이 그 `.base` 를 치웠다. Notion 의 본문에는 그
   * 블록이 이미 없다. API 로 블록을 지우면 페이지의 수정 시각이 그대로라(2026-10-30 실측) 그 페이지를 다시 받지 않아
   * 깨진 임베드가 남았다. 동기화된 노트는 고친 글을 사본으로 적는다 — Notion 의 본문과 같아졌다.
   *
   * @returns 임베드를 뺀 노트.
   */
  async dropEmbeds(basePaths: readonly string[]): Promise<string[]> {
    if (basePaths.length === 0) return [];
    const gone = new Set(basePaths);
    const dropped: string[] = [];
    for (const note of await this.vaultFs.listMarkdownFiles()) {
      const next = dropEmbedLines(note.content, gone);
      if (next !== note.content && (await this.rewrite(note, next, true))) dropped.push(note.path);
    }
    if (dropped.length > 0) {
      getLogger().info(
        `[Im-Nobsidian] Notion 에서 지운 링크드 뷰의 임베드를 뺌: 노트 ${dropped.length}`,
      );
    }
    return dropped;
  }

  /**
   * 고친 글을 쓴다. `matchesNotion` 이고 동기화된 노트(지난 사본 그대로)면 고친 글을 사본으로 적어 다음 push 가 올리지
   * 않게 한다 — Notion 의 본문은 이미 그 모양이다.
   */
  private async rewrite(
    note: { readonly path: string; readonly content: string },
    next: string,
    matchesNotion: boolean,
  ): Promise<boolean> {
    try {
      await this.vaultFs.writeFile(note.path, next);
    } catch (error) {
      getLogger().warn(
        `[Im-Nobsidian] 다른 노트를 가리키던 링크를 고치지 못함 (${note.path}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
    const record = this.stateDb.getByPath(note.path);
    if (record && record.contentHash === computeHash(note.content) && matchesNotion) {
      this.stateDb.updateHash(record.id, computeHash(next), Buffer.from(next, "utf-8"));
      const stat = await this.vaultFs.getFileStat(note.path);
      if (stat) this.stateDb.updateStatCache(record.id, stat.mtime, stat.size);
    }
    return true;
  }
}

/** 줄 하나가 통째로 임베드인 것 — 그룹 1 은 경로(별칭 뺌). */
const EMBED_LINE_RE = /^!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/;

/** `gone` 을 넣은 줄과 그 앞(맨 앞이면 뒤)의 빈 줄 하나를 뺀다 — 빈 줄 두 개가 남지 않게. */
function dropEmbedLines(content: string, gone: ReadonlySet<string>): string {
  const kept: string[] = [];
  let skipBlank = false;
  for (const line of content.split("\n")) {
    const target = EMBED_LINE_RE.exec(line.trim())?.[1];
    if (target !== undefined && gone.has(target)) {
      if (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
      else skipBlank = kept.length === 0;
      continue;
    }
    if (skipBlank && line.trim() === "") {
      skipBlank = false;
      continue;
    }
    skipBlank = false;
    kept.push(line);
  }
  return kept.join("\n");
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
