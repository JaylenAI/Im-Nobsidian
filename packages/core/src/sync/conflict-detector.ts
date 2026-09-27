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
  /**
   * 디스크에 파일이 실제로 존재하는지. 생략하면 존재하는 것으로 본다(하위호환).
   * `false` 는 "빈 파일"이 아니라 "파일 없음"을 뜻한다 — 둘을 구분해야 복원과
   * 내용 비교를 섞지 않는다.
   */
  readonly localExists?: boolean;
  /** Notion에서 가져와 변환한 리모트 내용. */
  readonly remoteContent: string;
  /**
   * 원격이 지난 동기화 사본 그대로임을 호출측이 확인했다 — 본문 지문과 본문 밖(제목 · 속성)으로
   * (N-05). 렌더한 글이 지난 사본과 글자로는 달라도(자식 페이지 링크 · 왕복한 본문) 원격은 바뀌지
   * 않았다. 생략하면 렌더한 글로만 가른다.
   */
  readonly remoteUnchanged?: boolean;
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
  /**
   * 원격 내용이 지난 동기화 사본과 같다 — 원격은 그 뒤로 바뀌지 않았다. `skip` 과 함께 오며,
   * 호출측은 원격을 본 기록만 새로 적는다(N-05).
   */
  readonly remoteUnchanged?: boolean;
}

/**
 * 두 노트의 글이 같은가 — 파일 끝 개행만 다르면 같다.
 *
 * pull 이 렌더한 글은 파일 끝 개행이 로컬과 다를 수 있다 — frontmatter 가 없는 노트는 끝 개행
 * 없이 나온다. 편집기가 끝에 개행을 둔 노트는 왕복하면 그 개행만 사라진다. 그것만 다른 노트를
 * 다시 쓰거나 충돌로 올리지 않는다.
 */
export function sameNoteContent(a: string, b: string): boolean {
  return a === b || a.replace(/\n+$/, "") === b.replace(/\n+$/, "");
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

  // 로컬 파일이 사라진 경우는 충돌이 아니라 '복원'이다. localContent 가 "" 라 해시가
  // 어긋나 '로컬 수정'으로 오판되고, manual 은 충돌·local-first 는 skip 으로 빠져 삭제가
  // 영구히 굳었다. 없어진 파일에는 지켜야 할 로컬 편집이 존재할 수 없으므로 리모트가
  // 유일한 생존본 — 무조건 덮어쓴다. 의도적 삭제를 원격에 전파하려면 deleteSync 가
  // 지정된 경로다. (일반 페이지·db-row 양쪽이 이 함수를 공유하므로 한 곳에서 마감된다.)
  if (input.localExists === false) {
    return { action: "write", localHash };
  }

  const localModified = localHash !== record.contentHash;

  // 로컬이 마지막 동기화 이후 변경되지 않았다면 충돌 없이 덮어쓰기 안전.
  if (!localModified) {
    return { action: "write", localHash };
  }

  // --- 로컬이 수정됨. 전략을 고르기 전에 원격이 실제로 바뀌었는지부터 본다 ---
  // 전략은 «양쪽이 모두 바뀌었을 때» 무엇이 이기는지다. 예전에는 remote-first 가 이 확인보다
  // 먼저 와서, 원격이 그대로인데도(같은 분 편집을 확인하러 다시 읽은 페이지 · 수정 시각만
  // 바뀐 페이지) 로컬 편집을 지난 사본으로 덮었다(N-05).

  // 양쪽 내용이 이미 동일하면 충돌이 아니다(동일 편집으로 수렴). 덮어써도 무손실이고
  // 상태를 synced 로 정리하므로 write 로 처리한다.
  if (sameNoteContent(localContent, remoteContent)) {
    return { action: "write", localHash };
  }

  // 리모트 내용이 base(마지막 동기화 스냅샷)와 같으면 리모트는 실제로 변하지 않은 것이다.
  // (notion last_edited 만 갱신된 가짜 변경.) 로컬만 바뀌었으므로 로컬을 보존(skip)한다.
  // 이때 write 로 덮어쓰면 로컬의 새 편집이 옛 내용으로 사라진다 — 반드시 skip.
  // 호출측이 지문으로 확인한 경우도 같다. 이 도구가 만든 자식 페이지는 부모 렌더에 링크를
  // 더하지만 부모의 본문은 그대로다 — 글로만 가르면 거짓 충돌이었다.
  const baseContent = record.baseSnapshot?.toString("utf-8") ?? null;
  if (
    input.remoteUnchanged === true ||
    (baseContent !== null && sameNoteContent(remoteContent, baseContent))
  ) {
    return { action: "skip", localHash, remoteUnchanged: true };
  }

  // 양쪽이 모두 바뀌었다 → 전략에 따라 분기.
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
    baseContent,
    localContent,
    remoteContent,
  };

  return { action: "conflict", conflict, localHash };
}
