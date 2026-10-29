import { setLogger } from "@im-nobsidian/core";
import type {
  FailedOperation,
  PullResult,
  PushResult,
  ReadOnlySkip,
  RemoteScanInfo,
  SchemaFollowed,
  PropertyRename,
  SchemaEdit,
  ViewEdit,
} from "@im-nobsidian/core";

/**
 * `--json` 모드 — 자동화(E2E 하니스 · CI)가 사람용 문구를 grep 하지 않고 결과를 읽게 한다.
 *
 * 문구 grep 은 조용히 틀렸다. sync 로그에 Pull 쪽 "no changes" 가 한 줄만 있어도 Push 쪽
 * 변경과 무관하게 churn 0 으로 판정했고, restored · deleted 는 아예 세지 않았다.
 *
 * 계약: stdout 에는 JSON 한 줄만 쓴다. 코어 로그는 전부 stderr 로 돌린다.
 */
export function enableJsonMode(): void {
  const toStderr = (message: string, ...args: unknown[]): void => console.error(message, ...args);
  setLogger({ warn: toStderr, error: toStderr, info: toStderr, debug: () => {} });
}

export interface PushJson {
  readonly created: number;
  readonly updated: number;
  readonly deleted: number;
  /** 옮김을 반영한 노트 · 폴더 수 — updated 와 겹치지 않는다. */
  readonly moved: number;
  /** 원격에 실제로 쓴(또는 dry-run 이면 쓸) 항목 수. 멱등 판정의 기준값. */
  readonly churn: number;
  /** 사이드카로 만든(dry-run 은 만들) Notion DB 수 — churn 에도 든다. */
  readonly createdDatabases: number;
  readonly failed: readonly FailedOperation[];
  /** 볼트에서 고쳤지만 올리지 않은 읽기 전용 속성 — 다음 pull 이 Notion 값으로 되돌린다. churn 에 들지 않는다. */
  readonly readOnlySkipped: readonly ReadOnlySkip[];
  /** 볼트에서 지웠지만 Notion 에서 지우지 않은 노트(deleteSync 꺼짐) — 다음 pull 이 되살린다. churn 에 들지 않는다. */
  readonly unsentDeletions: readonly string[];
  /** 볼트에서 바꾼 DB 속성 이름을 Notion 열 이름으로 바꾼 것(ADR-045) — churn 에 든다. */
  readonly renamedProperties: readonly PropertyRename[];
  /** 고친 사이드카의 속성을 Notion DB 에 올린 것(ADR-045) — churn 에 든다. */
  readonly schemaEdits: readonly SchemaEdit[];
  /** 고친 `.base` 의 보기를 Notion 보기에 올린 것(ADR-046) — churn 에 든다. */
  readonly viewEdits: readonly ViewEdit[];
  readonly durationMs: number;
}

export interface PullJson {
  readonly created: number;
  readonly updated: number;
  readonly deleted: number;
  readonly restored: number;
  /** 되살린(dry-run 은 되살릴) 노트 · 행의 경로 — `restored` 의 목록. */
  readonly restoredPaths: readonly string[];
  /** Notion 에서 바뀐 속성을 행 노트에 옮긴 DB 마다(ADR-045). */
  readonly schemaFollowed: readonly SchemaFollowed[];
  /** 볼트에서 고쳐 덮어쓰지 않은 사이드카(ADR-045). */
  readonly heldSidecars: readonly string[];
  /** 볼트에서 보기를 고쳐 덮어쓰지 않은 `.base`(ADR-046). */
  readonly heldBases: readonly string[];
  /** Notion 에서 옮긴 페이지를 볼트에서 옮긴 수(ADR-039) · 옮기지 않고 둔 수. */
  readonly moved: number;
  readonly moveSkipped: number;
  /** 그중 Notion 에서 바꾼 제목으로 이름을 바꾼 수(ADR-040) · 옮긴 노트를 가리키던 링크를 고친 노트 수. */
  readonly renamed: number;
  readonly relinked: number;
  /** Notion 에 새로 생겼지만 뺀 자리(paths · .im-nobsidian-ignore)에 놓일 것이라 받지 않은 페이지 수. */
  readonly excluded: number;
  /** 볼트에 실제로 쓴 항목 수 — 복원 · 옮기기도 쓰기다. 멱등 판정의 기준값. */
  readonly churn: number;
  readonly conflicts: number;
  readonly failed: readonly FailedOperation[];
  readonly writtenPaths: number;
  readonly images: number;
  readonly files: number;
  readonly links: number;
  readonly durationMs: number;
  /** 원격을 얼마나 훑었나 — 바뀐 것만 찾았으면 Notion 에서 지운 것은 다음 전체 대조가 반영한다. */
  readonly remoteScan: RemoteScanInfo | null;
}

/**
 * 노트가 아니라 Notion DB 에 올린 것 — 만든 DB · 바꾼 열 이름 · 사이드카 속성 · `.base` 보기. 보기만 고친 push 가
 * 요약 줄에 「no changes」 로 나왔다(2026-10-29 실측) — 노트 수만 셌다.
 */
export function pushDbChangeCount(result: PushResult): number {
  return (
    (result.createdDatabases ?? 0) +
    (result.renamedProperties?.length ?? 0) +
    (result.schemaEdits?.length ?? 0) +
    (result.viewEdits?.length ?? 0)
  );
}

export function pushJson(result: PushResult): PushJson {
  return {
    created: result.created,
    updated: result.updated,
    deleted: result.deleted,
    moved: result.moved,
    churn:
      result.created + result.updated + result.deleted + result.moved + pushDbChangeCount(result),
    createdDatabases: result.createdDatabases ?? 0,
    failed: result.failed,
    readOnlySkipped: result.readOnlySkipped ?? [],
    unsentDeletions: result.unsentDeletions ?? [],
    renamedProperties: result.renamedProperties ?? [],
    schemaEdits: result.schemaEdits ?? [],
    viewEdits: result.viewEdits ?? [],
    durationMs: result.duration,
  };
}

export function pullJson(result: PullResult): PullJson {
  return {
    created: result.created,
    updated: result.updated,
    deleted: result.deleted,
    restored: result.restored,
    restoredPaths: result.restoredPaths ?? [],
    schemaFollowed: result.schemaFollowed ?? [],
    heldSidecars: result.heldSidecars ?? [],
    heldBases: result.heldBases ?? [],
    moved: result.moved?.length ?? 0,
    moveSkipped: result.moveSkipped?.length ?? 0,
    renamed: result.moved?.filter((move) => move.renamed).length ?? 0,
    relinked: result.relinked?.length ?? 0,
    excluded: result.excluded?.length ?? 0,
    churn:
      result.created +
      result.updated +
      result.deleted +
      result.restored +
      (result.moved?.length ?? 0) +
      (result.relinked?.length ?? 0),
    conflicts: result.conflicts.length,
    failed: result.failed,
    writtenPaths: result.writtenPaths.length,
    images: result.imageCount,
    files: result.fileCount,
    links: result.linkCount,
    durationMs: result.duration,
    remoteScan: result.remoteScan ?? null,
  };
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
