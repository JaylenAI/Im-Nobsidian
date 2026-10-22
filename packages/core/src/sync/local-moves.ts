import { parentFolderOf } from "./folder-container.js";

/**
 * 로컬에서 옮기거나 이름을 바꾼 노트를 추적 레코드와 다시 짝짓는 규칙(S-11).
 *
 * 볼트에서 이름을 바꾸면 변경 감지에는 «추적 경로에 파일이 없음» 과 «추적하지 않는 새 파일»
 * 두 가지만 보인다. 둘을 짝지어야 Notion 페이지를 지우고 새로 만드는 대신 제목과 부모만 바꾼다.
 * 예전에는 내용 해시가 같을 때만 짝을 지었고, 짝지은 것도 push 가 아무것도 하지 않았다.
 *
 * 짝을 짓는 근거는 셋이다 — 앞의 것이 이긴다.
 *
 * 1. **이름 변경 힌트** — 플러그인이 볼트의 rename 이벤트를 받아 적어 둔 «지금 경로 → 옛 경로».
 *    이름과 내용을 함께 바꿔도 짝을 찾는다. CLI 는 이벤트를 받지 못해 힌트가 없다.
 * 2. **입양해 둔 이동의 옛 자리** — 이동을 상태 DB 에 옮겨 적고 Notion 에 아직 반영하지 못한
 *    레코드가 원래 자리로 돌아온 경우.
 * 3. **같은 내용** — 같은 파일 이름을 먼저, 그다음 경로 순으로 정해 결과가 매번 같다.
 */

/** 이름 변경 힌트를 두는 상태 메타 키. */
export const RENAME_HINTS_META_KEY = "local_rename_hints";

/** 이름 변경 힌트 — 지금 경로 → 마지막 동기화 때 알던 경로. */
export interface RenameHints {
  readonly files: Readonly<Record<string, string>>;
  readonly folders: Readonly<Record<string, string>>;
}

export const EMPTY_RENAME_HINTS: RenameHints = { files: {}, folders: {} };

export type RenameKind = "file" | "folder";

/** 상태 메타의 힌트. 없거나 깨졌으면 빈 힌트 — 힌트는 짝짓기를 돕는 것일 뿐이다. */
export function parseRenameHints(raw: string | null): RenameHints {
  if (!raw) return EMPTY_RENAME_HINTS;
  try {
    const parsed = JSON.parse(raw) as { files?: unknown; folders?: unknown };
    return { files: stringRecord(parsed.files), folders: stringRecord(parsed.folders) };
  } catch {
    return EMPTY_RENAME_HINTS;
  }
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, origin] of Object.entries(value)) {
    if (typeof origin === "string") out[key] = origin;
  }
  return out;
}

export function isEmptyRenameHints(hints: RenameHints): boolean {
  return Object.keys(hints.files).length === 0 && Object.keys(hints.folders).length === 0;
}

function isAtOrUnder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/** 폴더 힌트로 옛 경로를 되짚는다 — 가장 깊은 힌트 폴더 기준. 해당 힌트가 없으면 null. */
function throughFolderHints(
  folders: Readonly<Record<string, string>>,
  path: string,
): string | null {
  let best: string | null = null;
  for (const folder of Object.keys(folders)) {
    if (path.startsWith(`${folder}/`) && (best === null || folder.length > best.length)) {
      best = folder;
    }
  }
  return best === null ? null : folders[best]! + path.slice(best.length);
}

/** 파일의 옛 경로 — 파일 힌트, 없으면 폴더 힌트. 힌트가 모르는 파일이면 null. */
export function hintedOrigin(hints: RenameHints, path: string): string | null {
  return hints.files[path] ?? throughFolderHints(hints.folders, path);
}

/** `from` 아래의 키를 `to` 아래로 옮긴다. 옛 경로로 돌아온 항목은 지운다. */
function rekey(
  map: Readonly<Record<string, string>>,
  from: string,
  to: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, origin] of Object.entries(map)) {
    const moved = isAtOrUnder(key, from) ? to + key.slice(from.length) : key;
    if (moved !== origin) out[moved] = origin;
  }
  return out;
}

/**
 * rename 이벤트 한 건을 힌트에 적는다.
 *
 * - 연달아 바꾸면 처음 경로를 남긴다(a → b → c 는 c ← a). 되돌리면 힌트를 지운다.
 * - 폴더를 바꾸면 그 아래 힌트도 새 폴더 아래로 옮긴다.
 * - 폴더를 바꿀 때 Obsidian 이 하위 파일마다 이벤트를 또 보내도(순서 무관) 한 번 적은 것과 같다.
 */
export function recordRenameHint(
  hints: RenameHints,
  from: string,
  to: string,
  kind: RenameKind,
): RenameHints {
  if (from === to) return hints;

  if (kind === "file") {
    // 폴더 이름 변경이 이미 새 자리로 옮겨 둔 하위 파일 — 같은 이동을 두 번 적지 않는다.
    if (!(from in hints.files) && to in hints.files) return hints;
    const origin = hintedOrigin(hints, from) ?? from;
    const files = { ...hints.files };
    delete files[from];
    if (origin === to) delete files[to];
    else files[to] = origin;
    return { files, folders: { ...hints.folders } };
  }

  // 하위 폴더도 같은 이유로 이벤트가 또 온다.
  if (!(from in hints.folders) && to in hints.folders) return hints;
  const origin = hints.folders[from] ?? throughFolderHints(hints.folders, from) ?? from;
  const files = rekey(hints.files, from, to);
  const folders = rekey(hints.folders, from, to);
  if (!(from in hints.folders) && origin !== to) folders[to] = origin;
  return { files, folders };
}

/** 지운 파일 · 폴더의 힌트를 버린다 — 같은 자리에 새로 생긴 파일을 옛 노트로 짝짓지 않게. */
export function forgetRenameHint(hints: RenameHints, path: string): RenameHints {
  const keep = (map: Readonly<Record<string, string>>): Record<string, string> =>
    Object.fromEntries(Object.entries(map).filter(([key]) => !isAtOrUnder(key, path)));
  return { files: keep(hints.files), folders: keep(hints.folders) };
}

/**
 * 이번 실행이 쓴 힌트를 지운다 — 시작할 때 읽은 것 중 그 뒤로 바뀌지 않은 항목만. 실행 중에
 * 새로 적힌 이름 변경은 다음 실행이 쓴다.
 */
export function pruneRenameHints(current: RenameHints, consumed: RenameHints): RenameHints {
  const drop = (
    map: Readonly<Record<string, string>>,
    used: Readonly<Record<string, string>>,
  ): Record<string, string> =>
    Object.fromEntries(Object.entries(map).filter(([key, origin]) => used[key] !== origin));
  return {
    files: drop(current.files, consumed.files),
    folders: drop(current.folders, consumed.folders),
  };
}

/** 추적 경로에 파일이 없는 레코드. */
export interface MissingNote {
  /** 상태 DB 가 적고 있는 경로. */
  readonly path: string;
  readonly hash: string;
  /** 이동을 입양만 하고 Notion 에 반영하지 못했으면 마지막으로 반영한 경로. */
  readonly origin?: string;
}

/** 추적하지 않는 파일. */
export interface UntrackedNote {
  readonly path: string;
  readonly hash: string;
}

/** 짝 — 레코드가 적고 있는 경로(`from`)의 노트가 지금 `to` 에 있다. */
export interface LocalMovePair {
  readonly from: string;
  readonly to: string;
}

function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function byPath<T extends { readonly path: string }>(a: T, b: T): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** 없어진 추적 노트와 추적하지 않는 파일을 짝짓는다. 한 노트는 한 파일과만 짝이 된다. */
export function pairLocalMoves(
  missing: readonly MissingNote[],
  untracked: readonly UntrackedNote[],
  hints: RenameHints,
): LocalMovePair[] {
  const missingAt = new Map(missing.map((note) => [note.path, note]));
  const missingByOrigin = new Map<string, MissingNote>();
  for (const note of missing) {
    if (note.origin !== undefined && !missingByOrigin.has(note.origin)) {
      missingByOrigin.set(note.origin, note);
    }
  }

  const pairs: LocalMovePair[] = [];
  const paired = new Set<string>();
  const unmatched: UntrackedNote[] = [];

  for (const file of [...untracked].sort(byPath)) {
    const origin = hintedOrigin(hints, file.path);
    const note =
      (origin !== null ? (missingAt.get(origin) ?? missingByOrigin.get(origin)) : undefined) ??
      missingByOrigin.get(file.path);
    if (note && !paired.has(note.path)) {
      paired.add(note.path);
      pairs.push({ from: note.path, to: file.path });
    } else {
      unmatched.push(file);
    }
  }

  const sameContent = new Map<string, UntrackedNote[]>();
  for (const file of unmatched) {
    const bucket = sameContent.get(file.hash);
    if (bucket) bucket.push(file);
    else sameContent.set(file.hash, [file]);
  }
  for (const note of missing.filter((m) => !paired.has(m.path)).sort(byPath)) {
    const candidates = sameContent.get(note.hash);
    if (!candidates || candidates.length === 0) continue;
    const name = fileNameOf(note.path);
    const index = Math.max(
      0,
      candidates.findIndex((file) => fileNameOf(file.path) === name),
    );
    const [file] = candidates.splice(index, 1);
    paired.add(note.path);
    pairs.push({ from: note.path, to: file!.path });
  }

  return pairs;
}

/** 폴더 이동 — 상태 DB 가 적고 있는 폴더(`from`)가 지금 `to` 에 있다. */
export interface FolderMove {
  readonly from: string;
  readonly to: string;
}

/** 폴더 힌트가 가리키는 폴더의 새 자리. 힌트가 없거나 둘 이상이 같은 옛 폴더를 가리키면 null. */
export function hintedFolderTarget(hints: RenameHints, folder: string): string | null {
  let best: { to: string; origin: string } | null = null;
  let ambiguous = false;
  for (const [to, origin] of Object.entries(hints.folders)) {
    if (!isAtOrUnder(folder, origin)) continue;
    if (best === null || origin.length > best.origin.length) {
      best = { to, origin };
      ambiguous = false;
    } else if (origin.length === best.origin.length) {
      ambiguous = true;
    }
  }
  if (best === null || ambiguous) return null;
  return best.to + folder.slice(best.origin.length);
}

/**
 * 추적 중인 폴더(push 가 만든 폴더 페이지 · DB 폴더) 가운데 옮겨진 것과 그 새 자리.
 *
 * 폴더는 파일 목록에서 사라졌을 때만 옮긴 것으로 본다. 새 자리는 폴더 힌트가, 없으면 그 폴더에
 * 있던 노트들의 짝이 정한다 — 모든 짝이 같은 상대 경로로 한 폴더를 가리킬 때만. 새 자리가 볼트에
 * 없거나, 두 폴더가 한 자리로 가면 옮기지 않는다.
 *
 * @param liveFolders 지금 노트가 든 폴더(모든 조상 포함).
 */
export function deriveFolderMoves(
  folders: readonly string[],
  liveFolders: ReadonlySet<string>,
  pairs: readonly LocalMovePair[],
  hints: RenameHints,
): FolderMove[] {
  const moves = new Map<string, string>();
  for (const folder of [...new Set(folders)].sort()) {
    if (!folder || liveFolders.has(folder)) continue;
    let target = hintedFolderTarget(hints, folder);
    if (target === null) {
      const implied = new Set<string>();
      for (const { from, to } of pairs) {
        if (!from.startsWith(`${folder}/`)) continue;
        const rest = from.slice(folder.length);
        if (to.endsWith(rest) && to.length > rest.length) {
          implied.add(to.slice(0, to.length - rest.length));
        }
      }
      if (implied.size === 1) target = [...implied][0]!;
    }
    if (target !== null && target !== folder && liveFolders.has(target)) moves.set(folder, target);
  }

  const claims = new Map<string, number>();
  for (const to of moves.values()) claims.set(to, (claims.get(to) ?? 0) + 1);
  return [...moves].filter(([, to]) => claims.get(to) === 1).map(([from, to]) => ({ from, to }));
}

/** 노트 경로들이 든 폴더 — 모든 조상 포함. */
export function foldersOf(paths: Iterable<string>): Set<string> {
  const folders = new Set<string>();
  for (const path of paths) {
    for (let folder = parentFolderOf(path); folder && !folders.has(folder);) {
      folders.add(folder);
      folder = parentFolderOf(folder);
    }
  }
  return folders;
}

/** 이동 WAL 의 payload — 마지막으로 Notion 에 반영한 경로. */
export function movePayload(from: string): string {
  return JSON.stringify({ from });
}

/** 이동 WAL 의 옛 경로. 읽지 못하면 null. */
export function moveOrigin(payload: string | null): string | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as { from?: unknown };
    return typeof parsed.from === "string" && parsed.from ? parsed.from : null;
  } catch {
    return null;
  }
}

/** 미완료 WAL 한 건 — 이동 WAL 을 고르는 데 필요한 것만. */
interface PendingOp {
  readonly syncStateId: string;
  readonly operation: string;
  readonly direction: string;
  readonly payload: string | null;
}

/** 입양만 하고 Notion 에 반영하지 못한 이동 — 레코드 id → 마지막으로 반영한 경로. */
export function pendingMoveOrigins(ops: readonly PendingOp[]): Map<string, string> {
  const origins = new Map<string, string>();
  for (const op of ops) {
    if (op.direction !== "push" || op.operation !== "move") continue;
    const from = moveOrigin(op.payload);
    if (from !== null) origins.set(op.syncStateId, from);
  }
  return origins;
}
