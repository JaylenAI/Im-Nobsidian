import type { IStateDB } from "../state/state-db-interface.js";
import { pagePathCandidates } from "../utils/db-row-path.js";
import { foldedOwnerOf, pathKey } from "../utils/path-key.js";
import type { VaultFS } from "./vault-fs.js";

/** 상태 기록에 없이 볼트에 있는 노트 — 이 페이지 id 를 단 이름(`own`, 지난번 이 페이지를 받은 이름)인가 · 자연 이름(`name`)인가. */
export interface UntrackedNote {
  readonly path: string;
  readonly existing: "own" | "name";
}

/**
 * 상태 기록에 없는 노트가 이 페이지 · 행이 놓일 자리에 이미 있나(P7) — 이 페이지 id 를 단 이름이 먼저, 그 다음 자연 이름. 페이지
 * 받기 · 행 받기 · dry-run 이 같은 규칙으로 찾는다. 기록이 있는 자리 · 대소문자만 다른 남의 이름 · `taken`(이번 실행이 이미 고른
 * 자리, {@link pathKey})은 건너뛴다. 고르지 않는다 — 호출측이 장부에 적는다.
 */
export async function findUntrackedNote(
  stateDb: Pick<IStateDB, "getByPath" | "getByPathKey">,
  vaultFs: Pick<VaultFS, "exists">,
  dir: string,
  safeName: string,
  pageId: string,
  taken: (key: string) => boolean,
): Promise<UntrackedNote | null> {
  const [natural, ...suffixed] = pagePathCandidates(dir, safeName, pageId);
  const order: UntrackedNote[] = [
    ...suffixed.map((path) => ({ path, existing: "own" as const })),
    { path: natural!, existing: "name" },
  ];
  for (const candidate of order) {
    if (taken(pathKey(candidate.path)) || stateDb.getByPath(candidate.path)) continue;
    if (foldedOwnerOf(stateDb, candidate.path, pageId)) continue;
    if (await vaultFs.exists(candidate.path)) return candidate;
  }
  return null;
}

/**
 * 받지 않고 미리 볼 때(dry-run) 실제 pull 이 이 노트를 다시 잇는가. 이 페이지 id 를 단 이름은 언제나 잇는다(글이 다르면 전략 ·
 * 충돌). 자연 이름은 이은 노트가 없는 볼트에서만 확실히 잇는다 — 이은 노트가 있는 볼트는 글이 같아야 잇는데, 미리 보기는 글을
 * 받아 견주지 않아 알 수 없다(새로 받는 것으로 센다).
 */
export function relinksWithoutContent(note: UntrackedNote, unlinkedVault: boolean): boolean {
  return note.existing === "own" || unlinkedVault;
}
