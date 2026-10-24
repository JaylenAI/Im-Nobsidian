import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { INTERNAL_DIR } from "../constants/paths.js";

/**
 * 볼트의 연결 폴더(ADR-038) — 자기 `.im-nobsidian/` 를 둔 폴더. 볼트 맨 위(`""`)는 그 폴더가 있으면 든다.
 * 점으로 시작하는 폴더(`.obsidian` · `.git` · `.trash` 등)는 들여다보지 않는다 — 노트 목록도 그렇게 걷는다.
 */
export async function findConnectionFolders(vaultRoot: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some((e) => e.isDirectory() && e.name === INTERNAL_DIR)) found.push(rel);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      await walk(join(dir, entry.name), rel === "" ? entry.name : `${rel}/${entry.name}`);
    }
  };
  await walk(vaultRoot, "");
  return found;
}
