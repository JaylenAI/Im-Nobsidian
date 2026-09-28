import { setLogger } from "@im-nobsidian/core";
import type { FailedOperation, PullResult, PushResult } from "@im-nobsidian/core";

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
  readonly failed: readonly FailedOperation[];
  readonly durationMs: number;
}

export interface PullJson {
  readonly created: number;
  readonly updated: number;
  readonly deleted: number;
  readonly restored: number;
  /** 볼트에 실제로 쓴 항목 수 — 복원도 쓰기다. 멱등 판정의 기준값. */
  readonly churn: number;
  readonly conflicts: number;
  readonly failed: readonly FailedOperation[];
  readonly writtenPaths: number;
  readonly images: number;
  readonly files: number;
  readonly links: number;
  readonly durationMs: number;
}

export function pushJson(result: PushResult): PushJson {
  return {
    created: result.created,
    updated: result.updated,
    deleted: result.deleted,
    moved: result.moved,
    churn: result.created + result.updated + result.deleted + result.moved,
    failed: result.failed,
    durationMs: result.duration,
  };
}

export function pullJson(result: PullResult): PullJson {
  return {
    created: result.created,
    updated: result.updated,
    deleted: result.deleted,
    restored: result.restored,
    churn: result.created + result.updated + result.deleted + result.restored,
    conflicts: result.conflicts.length,
    failed: result.failed,
    writtenPaths: result.writtenPaths.length,
    images: result.imageCount,
    files: result.fileCount,
    links: result.linkCount,
    durationMs: result.duration,
  };
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
