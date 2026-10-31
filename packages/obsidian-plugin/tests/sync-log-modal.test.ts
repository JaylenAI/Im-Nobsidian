/**
 * 동기화 기록 창(P8) — 알림은 사라지고 자동 동기화는 알리지 않아, 처리하지 못한 노트의 까닭을 다시 볼 곳이 없었다.
 */
import { describe, it, expect, vi } from "vitest";
import { SyncLogModal, syncLogItems } from "../src/sync-log-modal.js";
import type { SyncLogEntry } from "../src/sync/sync-controller.js";

function entry(at: string, label: string, overrides: Partial<SyncLogEntry> = {}): SyncLogEntry {
  return { at, label, summary: `${label} 완료`, details: [], failed: [], ...overrides };
}

describe("syncLogItems", () => {
  it("연결들의 기록을 최근 것부터 한 목록으로 — 연결이 둘 이상이면 연결 이름을 붙인다", () => {
    const items = syncLogItems([
      { label: "볼트", entries: [entry("2026-10-31T08:00:02Z", "Pull")] },
      {
        label: "업무",
        entries: [
          entry("2026-10-31T08:00:03Z", "자동 동기화"),
          entry("2026-10-31T08:00:01Z", "Push"),
        ],
      },
    ]);
    expect(items.map((item) => item.heading.split(" · ").slice(1).join(" · "))).toEqual([
      "업무 · 자동 동기화",
      "볼트 · Pull",
      "업무 · Push",
    ]);
  });

  it("연결이 하나면 이름을 붙이지 않는다", () => {
    const [item] = syncLogItems([
      { label: "볼트", entries: [entry("2026-10-31T08:00:00Z", "Sync")] },
    ]);
    expect(item!.heading.split(" · ").slice(1)).toEqual(["Sync"]);
  });

  it("사정과 처리하지 못한 것을 줄이지 않고 보이고, 실패가 있으면 표시한다", () => {
    const failed = ["a", "b", "c", "d"].map((name) => ({
      path: `${name}.md`,
      operation: "update" as const,
      error: "Notion 400",
    }));
    const [item] = syncLogItems([
      {
        label: "볼트",
        entries: [entry("2026-10-31T08:00:00Z", "Pull", { details: ["범위 밖 — x.md"], failed })],
      },
    ]);
    expect(item!.failed).toBe(true);
    expect(item!.lines).toEqual([
      "범위 밖 — x.md",
      "처리하지 못함 — a.md: Notion 400",
      "처리하지 못함 — b.md: Notion 400",
      "처리하지 못함 — c.md: Notion 400",
      "처리하지 못함 — d.md: Notion 400",
    ]);
  });
});

describe("SyncLogModal", () => {
  function opened(logs: Parameters<typeof syncLogItems>[0]) {
    const modal = new SyncLogModal({} as never, logs);
    const createEl = vi.spyOn(modal.contentEl as { createEl: () => unknown }, "createEl");
    const createDiv = vi.spyOn(modal.contentEl as { createDiv: () => unknown }, "createDiv");
    modal.onOpen();
    return {
      texts: createEl.mock.calls.map(([, options]) => (options as { text?: string }).text),
      entries: createDiv.mock.calls.map(([options]) => (options as { cls: string }).cls),
    };
  }

  it("기록이 없으면 비었다고 말한다 — 「없습니다」 와 「읽지 못했다」 를 섞지 않는다", () => {
    const { texts, entries } = opened([{ label: "볼트", entries: [] }]);
    expect(texts[0]).toBe("동기화 기록");
    expect(texts[1]).toContain("이 세션에서 끝난 동기화가 아직 없습니다");
    expect(entries).toEqual([]);
  });

  it("기록마다 칸을 두고, 처리하지 못한 것이 있는 기록은 오류로 표시한다", () => {
    const { entries } = opened([
      {
        label: "볼트",
        entries: [
          entry("2026-10-31T08:00:01Z", "Push", {
            failed: [{ path: "a.md", operation: "update", error: "429" }],
          }),
          entry("2026-10-31T08:00:00Z", "Pull"),
        ],
      },
    ]);
    expect(entries).toEqual([
      "im-nobsidian-sync-log-entry mod-failed",
      "im-nobsidian-sync-log-entry",
    ]);
  });
});
