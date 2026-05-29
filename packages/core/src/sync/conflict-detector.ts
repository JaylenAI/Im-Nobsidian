import type { Conflict, ConflictStrategy, RemoteChange, SyncRecord } from "../types/sync.js";
import { computeHash } from "../utils/hash.js";

/**
 * Pull 충돌 해소 시 취할 동작.
 * - `write`: 로컬을 리모트 내용으로 덮어쓴다 (로컬 미수정 또는 remote-first).
 * - `skip`: 로컬을 보존하고 리모트 내용을 버린다 (local-first).
 * - `conflict`: 양쪽 모두 수정됨 → 사용자 해소 대기 (manual/duplicate).
 */
export type PullConflictAction = "write" | "skip" | "conflict";

export interface PullConflictInput {
  /** 동기화 상태 레코드 (마지막 동기화 시점 해시·스냅샷 포함). */
  readonly record: SyncRecord;
  /** 디스크의 현재 로컬 내용 (파일 없으면 ""). */
  readonly localContent: string;
  /** Notion에서 가져와 변환한 리모트 내용. */
  readonly remoteContent: string;
  /** 충돌 객체 구성용 리모트 변경 메타. */
  readonly remoteChange: RemoteChange;
  /** 설정된 충돌 해소 전략. */
  readonly strategy: ConflictStrategy;
}

export interface PullConflictResult {
  readonly action: PullConflictAction;
  /** action === "conflict" 일 때만 채워진다. */
  readonly conflict?: Conflict;
  /** 호출자가 재계산하지 않도록 제공하는 로컬 내용 해시. */
  readonly localHash: string;
}

/**
 * Pull 시 로컬 수정 여부를 판정하고 충돌 전략에 따라 동작을 결정하는 순수 함수.
 *
 * 마지막 동기화 이후 로컬이 수정되었는지(`localHash !== record.contentHash`)를 기준으로,
 * 수정되지 않았으면 안전하게 덮어쓰고, 수정되었으면 전략에 따라 보존/덮어쓰기/충돌을 반환한다.
 * 이 함수는 어떤 I/O도 수행하지 않으므로 orchestrator(일반 페이지)와 database-syncer(DB 행)가
 * 동일한 충돌 판정 로직을 공유한다.
 */
export function resolvePullConflict(input: PullConflictInput): PullConflictResult {
  const { record, localContent, remoteContent, remoteChange, strategy } = input;

  const localHash = computeHash(localContent);
  const localModified = localHash !== record.contentHash;

  // 로컬이 마지막 동기화 이후 변경되지 않았다면 충돌 없이 덮어쓰기 안전.
  if (!localModified) {
    return { action: "write", localHash };
  }

  // 로컬이 수정됨 → 전략에 따라 분기.
  if (strategy === "remote-first") {
    return { action: "write", localHash };
  }
  if (strategy === "local-first") {
    return { action: "skip", localHash };
  }

  // manual / duplicate → 충돌로 보존, 사용자 해소 대기.
  const conflict: Conflict = {
    syncRecord: record,
    localChange: {
      path: record.obsidianPath,
      type: "modified",
      currentHash: localHash,
      previousHash: record.contentHash,
    },
    remoteChange,
    baseContent: record.baseSnapshot?.toString("utf-8") ?? null,
    localContent,
    remoteContent,
  };

  return { action: "conflict", conflict, localHash };
}
