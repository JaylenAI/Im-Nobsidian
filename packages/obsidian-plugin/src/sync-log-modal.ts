import { Modal } from "obsidian";
import type { App } from "obsidian";
import type { SyncLogEntry } from "./sync/sync-controller.js";
import type { WarningLogEntry } from "./sync/warning-log.js";

/** 연결 하나의 기록 — 연결이 둘 이상이면 어느 연결의 것인지 함께 보인다. */
export interface ConnectionSyncLog {
  readonly label: string;
  readonly entries: readonly SyncLogEntry[];
}

/** 창에 그리는 기록 한 건. */
export interface SyncLogItem {
  /** 「17:42:05 · 볼트 · Pull」 */
  readonly heading: string;
  readonly summary: string;
  /** 경고 · 사정과 처리하지 못한 것(「경로 — 까닭」) — 줄이지 않는다. */
  readonly lines: readonly string[];
  /** 처리하지 못한 것이 있다 — 오류색으로 보인다. */
  readonly failed: boolean;
}

/** 연결들의 기록을 최근 것부터 한 목록으로. 연결이 하나면 연결 이름을 붙이지 않는다. */
export function syncLogItems(logs: readonly ConnectionSyncLog[]): SyncLogItem[] {
  const named = logs.length > 1;
  return logs
    .flatMap(({ label, entries }) => entries.map((entry) => ({ label, entry })))
    .sort((a, b) => b.entry.at.localeCompare(a.entry.at))
    .map(({ label, entry }) => ({
      heading: [
        new Date(entry.at).toLocaleTimeString(),
        ...(named ? [label] : []),
        entry.label,
      ].join(" · "),
      summary: entry.summary,
      lines: [
        ...entry.details,
        ...entry.failed.map((failure) => `처리하지 못함 — ${failure.path}: ${failure.error}`),
      ],
      failed: entry.failed.length > 0,
    }));
}

/**
 * 이 세션의 동기화 기록 — 알림은 몇 초 뒤 사라지고 자동 동기화는 알림을 띄우지 않는다. 처리하지 못한 노트의 까닭 · 받지 않은
 * 페이지 · 미룬 삭제를 여기서 다시 본다(P8). Obsidian 을 다시 열면 비어 있다.
 */
export class SyncLogModal extends Modal {
  /**
   * @param warnings 엔진이 낸 경고 · 오류 로그(최근 것이 앞) — 결과에 싣지 않는 사정(올리지 못한 첨부 · 접근할 수 없는 DB …)을
   *   CLI 는 터미널에 보이지만 플러그인은 여기서만 보인다.
   */
  constructor(
    app: App,
    private readonly logs: readonly ConnectionSyncLog[],
    private readonly warnings: readonly WarningLogEntry[] = [],
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("im-nobsidian-sync-log-modal");
    contentEl.createEl("h2", { text: "동기화 기록" });

    const items = syncLogItems(this.logs);
    if (items.length === 0) {
      contentEl.createEl("p", {
        text: "이 세션에서 끝난 동기화가 아직 없습니다. Obsidian 을 다시 열면 기록이 비워집니다.",
      });
    }
    for (const item of items) {
      const entry = contentEl.createDiv({
        cls: item.failed ? "im-nobsidian-sync-log-entry mod-failed" : "im-nobsidian-sync-log-entry",
      });
      entry.createEl("h4", { text: item.heading });
      entry.createEl("p", { text: item.summary });
      if (item.lines.length > 0) {
        const list = entry.createEl("ul");
        for (const line of item.lines) list.createEl("li", { text: line });
      }
    }
    if (this.warnings.length > 0) this.warningSection(contentEl);
  }

  /** 엔진 경고 — 동기화 결과에 싣지 않는 사정. 어느 연결 · 작업의 것인지는 시각으로 맞춘다. */
  private warningSection(contentEl: HTMLElement): void {
    const section = contentEl.createDiv({ cls: "im-nobsidian-sync-log-warnings" });
    section.createEl("h4", { text: `엔진 경고 (${this.warnings.length})` });
    const list = section.createEl("ul");
    for (const warning of this.warnings) {
      const time = new Date(warning.at).toLocaleTimeString();
      list.createEl("li", {
        text: `${time} · ${warning.level === "error" ? "오류 — " : ""}${warning.message}`,
      });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
