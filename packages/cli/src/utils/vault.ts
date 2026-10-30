import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  ConfigManager,
  NodeVaultFS,
  StateDB,
  matchesPathScope,
  ScopedVaultFS,
  findConnectionFolders,
  OBSIDIAN_CONFIG_DIR,
  IGNORE_FILE,
  type OutsideVault,
  type PathFilterConfig,
  type VaultFS,
} from "@im-nobsidian/core";

/** 이 폴더 안쪽의 다른 연결 폴더(ADR-038) — 이 폴더의 동기화가 비켜 간다. */
export async function nestedConnections(cwd: string): Promise<string[]> {
  return (await findConnectionFolders(cwd)).filter((folder) => folder !== "");
}

/**
 * 현재 폴더를 볼트로 다루는 VaultFS. 안쪽에 다른 연결 폴더가 있으면 그 폴더는 올리지도 덮어쓰지도 않는다 —
 * 그 폴더는 자기 설정 · Notion 으로 따로 동기화한다(`cd <폴더> && nobsi sync`).
 */
export async function openVaultFs(cwd: string, paths: PathFilterConfig): Promise<VaultFS> {
  const base = new NodeVaultFS(cwd, paths);
  const nested = await nestedConnections(cwd);
  return nested.length === 0 ? base : new ScopedVaultFS(base, "", ["", ...nested]);
}

/**
 * 볼트 전체 — 이 연결이 보지 않는 노트(바깥 · 안쪽 연결 폴더, 경로 패턴 · 제외 파일이 뺀 노트)에서도 동기화가 옮긴 노트로
 * 가는 링크를 고친다. 이 폴더가 볼트 전체를 그대로 보면 없다 — 고칠 노트가 없다. 볼트(`.obsidian`)를 못 찾아도 없다.
 */
export async function outsideVault(
  cwd: string,
  paths: PathFilterConfig,
): Promise<OutsideVault | undefined> {
  const root = vaultRoot(cwd);
  if (root === null) return undefined;
  const folder = relative(root, cwd).split("\\").join("/");
  const whole =
    folder === "" &&
    (paths.include ?? []).length === 0 &&
    (paths.exclude ?? []).length === 0 &&
    !existsSync(join(cwd, IGNORE_FILE)) &&
    (await nestedConnections(cwd)).length === 0;
  return whole ? undefined : { fs: new NodeVaultFS(root, {}, false), folder };
}

/** `.obsidian` 을 둔 볼트 맨 위 — 위로 올라가 찾는다. 없으면 null. */
function vaultRoot(cwd: string): string | null {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, OBSIDIAN_CONFIG_DIR))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

/**
 * 명령줄에 받은 볼트 경로 → 볼트 경로(`/`). Windows 에서는 `00 Me\a.md` 처럼 `\` 로 쳐도 같은 노트다(이슈 #8) —
 * 예전에는 `-p "00 Me\"` 가 어느 노트에도 맞지 않아 「변경 없음」 이었다. 다른 OS 에서 `\` 는 이름의 글자다.
 */
export function vaultArgPath(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? path.replace(/\\/g, "/") : path;
}

/**
 * Obsidian 설정 폴더까지의 상대 경로 — 연결 폴더가 볼트 안쪽이면 위로 올라가 찾는다. 못 찾으면 `.obsidian`
 * (없으면 속성 타입을 값으로 정한다).
 */
export function obsidianConfigDir(cwd: string): string {
  const root = vaultRoot(cwd);
  return root === null
    ? OBSIDIAN_CONFIG_DIR
    : relative(cwd, join(root, OBSIDIAN_CONFIG_DIR)).split("\\").join("/");
}

/**
 * 이 폴더를 이미 동기화하는 바깥 연결 — 그 연결 폴더와 이 폴더 안에서 추적하는 노트 수. 없으면 null.
 *
 * 이미 동기화하던 폴더를 따로 연결하면 바깥 연결이 멈춘다(ConnectionScopeError) — init 이 먼저 막는다.
 */
export function outerConnectionTracking(cwd: string): { folder: string; notes: number } | null {
  for (let dir = dirname(cwd); ; dir = dirname(dir)) {
    const manager = new ConfigManager(dir);
    if (existsSync(manager.dbPath)) {
      const scope = relative(dir, cwd).split("\\").join("/");
      const db = StateDB.open(manager.dbPath);
      try {
        // 폴더 자신의 레코드(폴더 페이지)는 빼고 그 안의 것만 센다.
        const notes = db
          .getAll()
          .filter(
            (r) => r.obsidianPath !== scope && matchesPathScope(r.obsidianPath, scope),
          ).length;
        return notes > 0 ? { folder: dir, notes } : null;
      } finally {
        db.close();
      }
    }
    if (dirname(dir) === dir) return null;
  }
}
