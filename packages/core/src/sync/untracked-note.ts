import type { IStateDB } from "../state/state-db-interface.js";
import type { Conflict, ConflictStrategy, SyncRecord } from "../types/sync.js";
import { computeHash } from "../utils/hash.js";
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
 * 상태 기록에 없던 노트를 받은 글과 견줘 어떻게 다시 잇나(P7) — 페이지 받기 · 행 받기 · dry-run 이 같은 규칙을 쓴다.
 *
 * - 글이 같으면 잇기만 한다(`relink`).
 * - 다르면 이 페이지 id 를 단 이름(지난번 이 페이지를 받은 이름)은 충돌 전략을 따른다 — local-first 는 로컬을 두고 잇고(`relink`,
 *   다음 push 가 올린다) · remote-first 는 원격으로 덮고(`overwrite`) · 그 밖은 충돌로 남긴다(`conflict` — 지난 사본이 없어 merge 도
 *   합칠 수 없다).
 * - 자연 이름에 있는 다른 글은 이은 노트가 하나도 없는 볼트에서만 잇고 전략과 상관없이 충돌로 남긴다 — 다른 노트일 수 있어 덮거나
 *   올리면 잃는다. 이은 노트가 있는 볼트에서는 잇지 않는다(null — id 를 단 새 이름으로 받는다).
 */
export function relinkOutcome(
  existing: UntrackedNote["existing"],
  same: boolean,
  unlinkedVault: boolean,
  strategy: ConflictStrategy,
): RelinkOutcome | null {
  if (same) return "relink";
  if (existing === "name" && !unlinkedVault) return null;
  const chosen = existing === "own" ? strategy : "manual";
  if (chosen === "local-first") return "relink";
  if (chosen === "remote-first") return "overwrite";
  return "conflict";
}

/** {@link relinkOutcome} — 잇기만 · 원격으로 덮기 · 충돌로 남기기. */
export type RelinkOutcome = "relink" | "overwrite" | "conflict";

/**
 * 충돌로 다시 이은 노트의 충돌 — 공통 조상을 모른다(`baseContent` null). `record` 는 이은 레코드, dry-run 은
 * {@link plannedRelinkRecord}.
 */
export function relinkConflict(input: {
  readonly record: SyncRecord;
  readonly path: string;
  readonly local: string;
  readonly remote: string;
  readonly pageId: string;
  readonly lastEdited: string;
  readonly title: string;
}): Conflict {
  return {
    syncRecord: input.record,
    localChange: {
      path: input.path,
      type: "modified",
      currentHash: computeHash(input.local),
      previousHash: input.record.contentHash,
    },
    remoteChange: {
      pageId: input.pageId,
      type: "modified",
      lastEdited: input.lastEdited,
      previousEdited: null,
      path: input.path,
      title: input.title,
    },
    baseContent: null,
    localContent: input.local,
    remoteContent: input.remote,
  };
}

/** dry-run 이 충돌로 남을 것으로 알릴 노트의 레코드 — 상태 DB 에 적지 않는다. 실제 pull 이 적을 값으로 채운다. */
export function plannedRelinkRecord(input: {
  readonly path: string;
  readonly pageId: string;
  readonly parentId: string | null;
  readonly remote: string;
  readonly lastEdited: string;
  readonly fileType: SyncRecord["fileType"];
}): SyncRecord {
  const now = new Date().toISOString();
  return {
    id: `planned:${input.pageId}`,
    obsidianPath: input.path,
    notionPageId: input.pageId,
    notionParentId: input.parentId,
    contentHash: computeHash(input.remote),
    notionLastEdited: input.lastEdited,
    notionLastEditedBy: null,
    notionSeenAt: null,
    notionBodyFingerprint: null,
    localLastModified: now,
    syncDirection: "both",
    fileType: input.fileType,
    status: "conflict",
    baseSnapshot: null,
    localMtime: null,
    localFileSize: null,
    version: 0,
    createdAt: now,
    updatedAt: now,
  };
}
