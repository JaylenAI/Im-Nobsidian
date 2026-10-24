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
 * Obsidian 설정 폴더까지의 상대 경로 — 연결 폴더가 볼트 안쪽이면 위로 올라가 찾는다. 못 찾으면 `.obsidian`
 * (없으면 속성 타입을 값으로 정한다).
 */
export function obsidianConfigDir(cwd: string): string {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, OBSIDIAN_CONFIG_DIR))) {
      return relative(cwd, join(dir, OBSIDIAN_CONFIG_DIR)).split("\\").join("/");
    }
    if (dirname(dir) === dir) return OBSIDIAN_CONFIG_DIR;
  }
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
