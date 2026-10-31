import type { IStateDB } from "../state/state-db-interface.js";
import type { RemoteMove } from "../types/sync.js";
import { getLogger } from "../utils/logger.js";
import type { NoteRelocator } from "./note-relocation.js";
import { within } from "./note-relocation.js";

/** 상태 기록의 경로를 NFC 로 옮겨 적은 뒤 적는 메타 — 한 번만 훑는다. */
export const NFC_PATHS_META_KEY = "paths_nfc_v1";

/**
 * 예전 CLI 가 적은 NFD 경로(macOS 에서 Finder 가 만든 한글 이름)를 NFC 로 옮겨 적는다 — 이제 볼트 경로는 NFC 다
 * (`NodeVaultFS`). 옮겨 적지 않으면 그 노트가 「볼트에서 지움」 과 「새 노트」 로 보여 Notion 페이지를 지우고 새로 만든다.
 * 파일은 옮기지 않는다 — 디스크 이름은 그대로이고 볼트가 NFC 경로로 그 파일을 연다.
 *
 * 맨 위부터 처음 NFD 인 이름(폴더면 폴더째)을 하나씩 옮겨 적는다 — 폴더를 옮겨 적어야 DB 폴더 기록도 따라간다
 * (`rewriteDatabaseFolders`). NFC 로 같은 이름이 이미 기록에 있으면(Linux 에서 두 꼴이 따로 있던 볼트) 두고 알린다.
 *
 * @returns 옮겨 적은 이름 수
 */
export function upgradeNfcPaths(
  stateDb: Pick<
    IStateDB,
    "getAll" | "getMeta" | "setMeta" | "getFilesByPageId" | "registerFile" | "deleteFileRegistry"
  >,
  relocator: Pick<NoteRelocator, "rewriteRecorded">,
): number {
  if (stateDb.getMeta(NFC_PATHS_META_KEY)) return 0;
  const kept = new Set<string>();
  let moved = 0;
  for (;;) {
    const records = stateDb.getAll();
    const move = nextMove(
      records.map((r) => r.obsidianPath),
      kept,
    );
    if (!move) break;
    if (records.some((r) => within(r.obsidianPath, move.to))) {
      kept.add(move.from);
      getLogger().warn(
        `[Im-Nobsidian] NFC 로 같은 이름이 이미 있어 옛 표기의 기록을 그대로 둠 (${move.from}) — 두 노트 가운데 하나의 이름을 바꾸세요.`,
      );
      continue;
    }
    relocator.rewriteRecorded([move]);
    moved++;
  }
  // 노트 밖의 첨부(다른 폴더의 그림 등)는 위에서 따라가지 않는다 — 안 고치면 한 번 더 올린다.
  const pages = new Set(stateDb.getAll().flatMap((r) => (r.notionPageId ? [r.notionPageId] : [])));
  for (const pageId of pages) {
    for (const file of stateDb.getFilesByPageId(pageId)) {
      const localPath = file.localPath.normalize("NFC");
      if (localPath === file.localPath) continue;
      stateDb.registerFile({
        localPath,
        notionPageId: file.notionPageId,
        fileUploadId: file.fileUploadId,
        fileType: file.fileType,
        fileHash: file.fileHash,
        fileSize: file.fileSize,
      });
      stateDb.deleteFileRegistry(file.localPath);
    }
  }
  stateDb.setMeta(NFC_PATHS_META_KEY, "1");
  return moved;
}

/** 경로들 가운데 처음 NFD 인 이름 하나 — 그 이름까지의 경로를 NFC 로. */
function nextMove(paths: readonly string[], kept: ReadonlySet<string>): RemoteMove | null {
  for (const path of paths) {
    const segments = path.split("/");
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      if (segment === segment.normalize("NFC")) continue;
      const from = segments.slice(0, i + 1).join("/");
      if (kept.has(from)) break;
      const to = [...segments.slice(0, i), segment.normalize("NFC")].join("/");
      return { from, to };
    }
  }
  return null;
}
