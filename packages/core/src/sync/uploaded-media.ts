import type { IStateDB } from "../state/state-db-interface.js";
import { compactNotionId } from "../utils/id.js";
import { getLogger } from "../utils/logger.js";

/**
 * push 가 노트 임베드를 올려 만든 미디어 블록 하나 — Notion 에 저장된 파일과 노트의 임베드를
 * 잇는다(S-05).
 *
 * 예전(R1)에는 올린 블록의 캡션에 임베드 대상을 그대로 적고, pull 이 그 캡션으로 임베드를
 * 되찾았다. 그래서 Notion 에서 보는 캡션이 `assets/사진.png|300` 같은 경로 · 크기 · 파일
 * 이름이었다. 이제 캡션에는 사람이 적은 설명만 싣고, 어느 임베드였는지는 여기 적어 둔다.
 *
 * 파일 id 로 잇는 이유: Notion 에서 같은 이름의 다른 파일로 바꾸면 id 가 바뀐다. 이름으로 이으면
 * 바뀐 파일을 옛 로컬 파일로 되돌려 Notion 의 편집을 잃는다.
 */
export interface UploadedMedia {
  /** Notion 이 그 파일을 저장한 id(`notionFileIdOf`) — 블록 id · file_upload id 와 다르다. */
  readonly fileId: string;
  /** 노트에 적혀 있던 임베드 대상 그대로 — `경로|별칭`. */
  readonly target: string;
  /** 올린 볼트 파일(해석한 경로) — pull 이 아직 있는지 보고 되살린다. */
  readonly localPath: string;
  /**
   * 올린 · 받은 파일의 전체 sha256. 볼트의 그 파일이 아직 이 바이트면 본문 push 가 다시 올리지 않고
   * Notion 의 그 블록을 둔다(`ImageHandler.keepUploadedMedia`). 이 값을 적기 전에 적은 기록에는
   * 없다 — 그 미디어는 한 번 더 올리고 그때 적는다.
   */
  readonly fileHash?: string;
}

/**
 * sync_metadata 의 키 — 페이지마다 한 줄. 보존 마커(`preserve_markers:<경로>`)와 같은 방식이라
 * 두 상태 DB 구현(better-sqlite3 · sql.js)에 스키마를 바꾸지 않고 같은 코드로 쓴다.
 */
function keyOf(pageId: string): string {
  return `uploaded_media:${compactNotionId(pageId)}`;
}

/**
 * 페이지에 올린 미디어를 적는다 — 그 페이지에 적어 둔 것을 통째로 바꾼다.
 *
 * 본문 push 뒤 페이지의 미디어 블록은 그대로 둔 것과 새로 올린 것뿐이다 — 호출측이 둘을 함께
 * 넘긴다. 본문에서 빠진 미디어는 교체가 지웠으므로 남길 까닭이 없다.
 */
export function rememberUploadedMedia(
  stateDb: IStateDB,
  pageId: string,
  media: readonly UploadedMedia[],
): void {
  const key = keyOf(pageId);
  if (media.length === 0 && stateDb.getMeta(key) === null) return;
  stateDb.setMeta(key, JSON.stringify(media.map(rowOf)));
}

/**
 * 페이지에서 받은 미디어를 더 적는다 — 적어 둔 것은 두고, 같은 파일이면 새로 받은 것으로 바꾼다.
 *
 * pull 이 받은 미디어도 적어 두어야 그 노트를 고쳐 push 할 때 Notion 의 원래 블록을 둔다. 적지
 * 않으면 push 가 받은 파일을 다시 올려 원래 블록을 지우고, 캡션 · 이름이 볼트의 것으로 바뀐다.
 */
export function rememberReceivedMedia(
  stateDb: IStateDB,
  pageId: string,
  media: readonly UploadedMedia[],
): void {
  if (media.length === 0) return;
  const merged = recallUploadedMedia(stateDb, pageId);
  for (const item of media) merged.set(item.fileId, item);
  stateDb.setMeta(keyOf(pageId), JSON.stringify([...merged.values()].map(rowOf)));
}

/** 적을 한 줄 — 지문이 없으면 키를 싣지 않는다. */
function rowOf({ fileId, target, localPath, fileHash }: UploadedMedia): UploadedMedia {
  return fileHash === undefined
    ? { fileId, target, localPath }
    : { fileId, target, localPath, fileHash };
}

/**
 * 페이지에 올려 둔 미디어 — 파일 id 로 찾는다.
 *
 * 적어 둔 것이 없으면 비어 있다(이 기능 이전에 올린 페이지 · Notion 에서 만든 페이지). 적어 둔
 * 것을 읽지 못해도 비어 있는 것으로 다룬다 — 호출측은 예전 방식(캡션)으로 되찾거나 사본을
 * 받으므로 잃는 것이 없다. 그래도 조용히 넘기지 않고 경고를 남긴다.
 */
export function recallUploadedMedia(
  stateDb: IStateDB | undefined,
  pageId: string,
): Map<string, UploadedMedia> {
  const known = new Map<string, UploadedMedia>();
  const value = stateDb?.getMeta(keyOf(pageId));
  if (!value) return known;
  try {
    for (const row of JSON.parse(value) as unknown[]) {
      if (isUploadedMedia(row)) known.set(row.fileId, row);
    }
  } catch (error) {
    getLogger().warn(
      `[Im-Nobsidian] 올린 미디어 기록을 읽지 못함 (${pageId}) — 캡션으로 되찾는다: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
  return known;
}

function isUploadedMedia(value: unknown): value is UploadedMedia {
  const row = value as Partial<Record<keyof UploadedMedia, unknown>> | null;
  return (
    typeof row?.fileId === "string" &&
    typeof row.target === "string" &&
    typeof row.localPath === "string" &&
    (row.fileHash === undefined || typeof row.fileHash === "string")
  );
}
