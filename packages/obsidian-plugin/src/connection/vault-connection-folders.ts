/**
 * 볼트의 연결 폴더(ADR-038)를 볼트 어댑터로 찾는다 — 모바일(Node 없음, P11). 데스크톱은 core `findConnectionFolders`
 * (Node `fs`)와 같은 규칙: 자기 `.im-nobsidian/` 를 둔 폴더, 점으로 시작하는 폴더는 들여다보지 않는다.
 */
import type { DataAdapter } from "obsidian";
import { INTERNAL_DIR } from "@im-nobsidian/core";

/** 어댑터가 돌려준 경로의 마지막 이름. */
const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

export async function findConnectionFoldersInVault(
  adapter: Pick<DataAdapter, "list">,
): Promise<string[]> {
  const found: string[] = [];
  const walk = async (folder: string): Promise<void> => {
    const listed = await adapter.list(folder === "" ? "/" : folder);
    // 맨 위를 물으면 `/` 로 시작하는 경로를 주는 어댑터가 있다 — 볼트 경로로 맞춘다
    const folders = listed.folders.map((path) => path.replace(/^\/+/, ""));
    if (folders.some((path) => nameOf(path) === INTERNAL_DIR)) found.push(folder);
    for (const path of folders) {
      if (!nameOf(path).startsWith(".")) await walk(path);
    }
  };
  await walk("");
  return found;
}
