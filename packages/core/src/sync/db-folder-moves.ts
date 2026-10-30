import { BASE_SUFFIX } from "../constants/paths.js";
import type { IStateDB } from "../state/state-db-interface.js";
import { computeHash } from "../utils/hash.js";
import { getLogger } from "../utils/logger.js";
import { isMarkdownPath } from "../utils/markdown-path.js";
import { IN_FOLDER_FILTER_RE, inFolderFilter } from "../view/base-file-generator.js";
import { DB_BASE_FILES_META_KEY } from "./db-base-files.js";
import { CREATED_DBS_META_KEY } from "./database-creator.js";
import { DISCOVERED_DBS_META_KEY, parseDiscoveredDbs } from "./discovered-databases.js";
import { isGeneratedDbArtifact } from "./stale-db-artifacts.js";
import type { VaultFS } from "./vault-fs.js";

/** 옮긴 것 하나 — 노트(`.md`)거나 폴더. */
export interface PathMove {
  readonly from: string;
  readonly to: string;
}

/**
 * DB 가 든 폴더를 옮긴 뒤 DB 쪽 기록을 새 자리로 적는다(ADR-041) — 볼트에서 옮겼든(push) Notion 에서 옮겼든(pull).
 *
 * 발견한 DB 의 폴더(`discovered_dbs`)를 고쳐야 pull 이 행을 새 폴더에 쓰고, 기록한 `.base` 경로(`db_base_files`)를
 * 고쳐야 인라인 DB 자리를 옛 경로로 임베드하지 않는다. 바뀐 DB 만 조회하므로(ADR-027) 그대로인 DB 는 다시 받지 않는다 —
 * 받을 때 고쳐지기를 기다리면 그때까지 틀린 채로 남는다. 상태 DB 트랜잭션 안에서 부른다.
 */
export function rewriteDatabaseFolders(
  stateDb: Pick<IStateDB, "getMeta" | "setMeta">,
  moves: readonly PathMove[],
): void {
  const folders = moves.filter((move) => !isMarkdownPath(move.from));
  if (folders.length === 0) return;

  const databases = parseDiscoveredDbs(stateDb.getMeta(DISCOVERED_DBS_META_KEY));
  let changed = false;
  for (const db of databases) {
    const folder = db.localFolder.replace(/\/+$/, "");
    const to = finalPath(folder, folders);
    if (to === folder) continue;
    db.localFolder = to;
    changed = true;
  }
  if (changed) stateDb.setMeta(DISCOVERED_DBS_META_KEY, JSON.stringify(databases));

  rewriteCreatedDatabaseFolders(stateDb, folders);

  const raw = stateDb.getMeta(DB_BASE_FILES_META_KEY);
  if (!raw) return;
  let entries: Record<string, { basePath?: unknown } | null>;
  try {
    entries = JSON.parse(raw) as Record<string, { basePath?: unknown } | null>;
  } catch {
    return; // 깨진 메타 — 다음 DB 받기가 새로 적는다.
  }
  if (!entries || typeof entries !== "object") return;
  let moved = false;
  for (const entry of Object.values(entries)) {
    if (typeof entry?.basePath !== "string") continue;
    const to = finalPath(entry.basePath, folders);
    if (to === entry.basePath) continue;
    entry.basePath = to;
    moved = true;
  }
  if (moved) stateDb.setMeta(DB_BASE_FILES_META_KEY, JSON.stringify(entries));
}

/**
 * push 가 만든 DB 의 폴더(`created_dbs`)도 새 자리로 — 속성 · 보기를 다 붙이기 전에 옮겼으면 다음 push 가 그 폴더의
 * 사이드카를 읽어 마저 붙인다. 옛 폴더로 찾으면 사이드카가 없어 다 붙인 것으로 적는다.
 */
function rewriteCreatedDatabaseFolders(
  stateDb: Pick<IStateDB, "getMeta" | "setMeta">,
  folders: readonly PathMove[],
): void {
  const raw = stateDb.getMeta(CREATED_DBS_META_KEY);
  if (!raw) return;
  let entries: Record<string, { folder?: unknown } | null>;
  try {
    entries = JSON.parse(raw) as Record<string, { folder?: unknown } | null>;
  } catch {
    return;
  }
  if (!entries || typeof entries !== "object") return;
  let changed = false;
  for (const entry of Object.values(entries)) {
    if (typeof entry?.folder !== "string") continue;
    const to = finalPath(entry.folder, folders);
    if (to === entry.folder) continue;
    entry.folder = to;
    changed = true;
  }
  if (changed) stateDb.setMeta(CREATED_DBS_META_KEY, JSON.stringify(entries));
}

/**
 * 동기화가 만든 `.base` 의 폴더 필터를 새 자리로 고친다 — 보기는 `file.inFolder("폴더")` 로 행을 고른다. 옮긴 폴더 밖의
 * `.base`(원본 DB 를 가리키는 연결 보기)도 본다. 사용자가 만든 `.base` 는 둔다. 고치지 못해도 옮긴 것을 무르지 않는다 —
 * 그 DB 를 다음에 받을 때 다시 쓴다.
 *
 * pull 이 쓴 그대로였던 파일은 기록한 해시(`db_base_files`)도 고쳐 쓴 내용으로 바꾼다 — 그대로 두면 pull 이 그 파일을
 * «볼트에서 고친 보기» 로 보아 덮어쓰지 않고, DB 제목이 바뀌었으면 옛 이름 파일을 지우지 않는다. 기록을 옮겨 적은
 * ({@link rewriteDatabaseFolders}) 뒤에 부른다.
 */
export async function retargetBaseFiles(
  vaultFs: Pick<VaultFS, "listNonMarkdownFiles" | "readFile" | "writeFile">,
  moves: readonly PathMove[],
  stateDb?: Pick<IStateDB, "getMeta" | "setMeta">,
): Promise<void> {
  const folders = moves.filter((move) => !isMarkdownPath(move.from));
  if (folders.length === 0) return;
  const rehashed = new Map<string, { readonly before: string; readonly after: string }>();
  try {
    for (const file of await vaultFs.listNonMarkdownFiles()) {
      if (!file.path.endsWith(BASE_SUFFIX)) continue;
      const content = await vaultFs.readFile(file.path);
      if (!isGeneratedDbArtifact(file.path, content)) continue;
      const next = content.replace(IN_FOLDER_FILTER_RE, (whole, folder: string) => {
        const to = finalPath(folder, folders);
        return to === folder ? whole : inFolderFilter(to);
      });
      if (next === content) continue;
      await vaultFs.writeFile(file.path, next);
      rehashed.set(file.path, { before: computeHash(content), after: computeHash(next) });
    }
  } catch (error) {
    getLogger().warn(
      `[Im-Nobsidian] 옮긴 폴더를 가리키던 .base 보기를 고치지 못함: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (stateDb && rehashed.size > 0) rehashBaseFiles(stateDb, rehashed);
}

/** 고쳐 쓴 `.base` 가운데 pull 이 쓴 그대로였던 것의 기록 해시를 새 내용으로 바꾼다. */
function rehashBaseFiles(
  stateDb: Pick<IStateDB, "getMeta" | "setMeta">,
  rehashed: ReadonlyMap<string, { readonly before: string; readonly after: string }>,
): void {
  const raw = stateDb.getMeta(DB_BASE_FILES_META_KEY);
  if (!raw) return;
  let entries: Record<string, { basePath?: unknown; hash?: unknown } | null>;
  try {
    entries = JSON.parse(raw) as Record<string, { basePath?: unknown; hash?: unknown } | null>;
  } catch {
    return;
  }
  if (!entries || typeof entries !== "object") return;
  let changed = false;
  for (const entry of Object.values(entries)) {
    if (typeof entry?.basePath !== "string") continue;
    const hashes = rehashed.get(entry.basePath);
    // 기록과 다르던 파일은 볼트에서 고친 것이다 — 계속 «고친 것» 으로 둔다.
    if (!hashes || entry.hash !== hashes.before) continue;
    entry.hash = hashes.after;
    changed = true;
  }
  if (changed) stateDb.setMeta(DB_BASE_FILES_META_KEY, JSON.stringify(entries));
}

/** 차례로 옮긴 뒤 `path` 가 놓이는 자리. */
function finalPath(path: string, moves: readonly PathMove[]): string {
  let current = path;
  for (const move of moves) {
    if (current === move.from || current.startsWith(`${move.from}/`)) {
      current = move.to + current.slice(move.from.length);
    }
  }
  return current;
}
