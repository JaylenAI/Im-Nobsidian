import type { ChangeDiff, LocalChange, RemoteChange } from "@im-nobsidian/core";

/** 변경 하나의 두 글을 불러오는 곳 — 플러그인에서는 `SyncController`. */
export interface ChangeDiffer {
  localChangeDiff(change: LocalChange): Promise<ChangeDiff>;
  remoteChangeDiff(change: RemoteChange): Promise<ChangeDiff>;
}

/** 줄 비교 창에 보일 것 — 무엇을 무엇과 견주는지와 두 글을 불러오는 법. */
export interface ChangeDiffSource {
  /** 창 제목 — 노트 이름. */
  readonly title: string;
  /** 어떤 변경인지 한 줄 — 옮긴 노트는 옛 자리와 새 자리. */
  readonly caption: string;
  readonly oldLabel: string;
  readonly newLabel: string;
  /** 두 글이 같을 때 보일 말. */
  readonly emptyText: string;
  readonly load: () => Promise<ChangeDiff>;
}

const SYNCED_LABEL = "지난 동기화";
const SAME_TEXT = "지난 동기화 때와 내용이 같습니다";

function noteName(path: string): string {
  return path.split("/").pop()?.replace(/\.md$/, "") ?? path;
}

/** 로컬 변경 — 지난 동기화 때의 글과 지금 볼트의 글. */
export function localDiffSource(change: LocalChange, differ: ChangeDiffer): ChangeDiffSource {
  return {
    title: noteName(change.path),
    caption: localCaption(change),
    oldLabel: SYNCED_LABEL,
    newLabel: "지금 볼트",
    emptyText: change.type === "moved" ? "내용은 그대로입니다 — 자리만 옮겼습니다" : SAME_TEXT,
    load: () => differ.localChangeDiff(change),
  };
}

function localCaption(change: LocalChange): string {
  switch (change.type) {
    case "created":
      return `새 노트 — ${change.path}`;
    case "modified":
      return `고친 노트 — ${change.path}`;
    case "deleted":
      return `지운 노트 — ${change.path}`;
    case "moved":
      return `옮긴 노트 — ${change.movedFrom ?? "?"} → ${change.path}`;
  }
}

/**
 * 원격 변경 — 지난 동기화 때의 글과 Notion 의 지금 글. 볼트 경로가 있는(받은 적 있는) 노트만 견줄 수 있다.
 * 아직 받지 않은 새 페이지는 null.
 */
export function remoteDiffSource(
  change: RemoteChange,
  differ: ChangeDiffer,
): ChangeDiffSource | null {
  if (!change.path) return null;
  return {
    title: noteName(change.path),
    caption: `${REMOTE_CAPTION[change.type]} — ${change.path}`,
    oldLabel: SYNCED_LABEL,
    newLabel: "Notion 지금",
    emptyText: SAME_TEXT,
    load: () => differ.remoteChangeDiff(change),
  };
}

const REMOTE_CAPTION: Record<RemoteChange["type"], string> = {
  created: "Notion 에서 만든 노트",
  modified: "Notion 에서 고친 노트",
  deleted: "Notion 에서 지운 노트",
  moved: "Notion 에서 옮긴 노트",
};
