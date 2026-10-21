import type { SyncDirection } from "@im-nobsidian/core";

/** 동기화 방향이 막는 동작의 까닭 — 막지 않으면 null. */
export interface DirectionBlocks {
  readonly push: string | null;
  readonly pull: string | null;
}

/**
 * 동기화 방향이 막는 동작이면 그 까닭. 엔진은 막힌 방향을 조용히 0건으로 끝낸다 — 단추를 눌러도 아무 일이
 * 없었고 까닭도 보이지 않았다. 명령은 이 까닭을 알림으로, 변경 패널은 단추를 끄고 설명으로 보인다.
 */
export function directionBlock(direction: SyncDirection, action: "push" | "pull"): string | null {
  if (direction === "both" || direction === action) return null;
  const only = direction === "push" ? "Push만" : "Pull만";
  return `동기화 방향이 «${only}» 이라 ${action === "push" ? "Push" : "Pull"} 하지 않습니다 — 설정에서 바꿀 수 있습니다.`;
}

export function directionBlocks(direction: SyncDirection): DirectionBlocks {
  return { push: directionBlock(direction, "push"), pull: directionBlock(direction, "pull") };
}
