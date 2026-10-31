import { Modal, type App } from "obsidian";
import type { OperationType, ProgressItem, SyncResult } from "@im-nobsidian/core";

/** 한 묶음에 적는 노트 수 — 넘으면 「외 N개」 로 줄인다. */
export const LISTED_PATHS = 50;

/** 할 일의 이름 — 내부 코드값을 화면에 내보내지 않는다. */
const OPERATION_TEXT: Readonly<Record<OperationType, string>> = {
  create: "새로",
  update: "고침",
  delete: "지움",
  move: "옮김",
};

/** 반영하지 않고 본 Sync 한 번 — 결과와 진행으로 받은 할 일. */
export interface SyncPreview {
  readonly result: SyncResult;
  readonly items: readonly ProgressItem[];
}

/** 연결 하나의 미리 보기. */
export interface ConnectionPreview {
  readonly label: string;
  readonly preview: SyncPreview;
}

export interface PreviewSection {
  readonly heading: string;
  readonly lines: readonly string[];
  /** 그대로 두면 처리하지 못하거나 사람이 골라야 하는 것 — 오류색. */
  readonly problem: boolean;
}

function listed(lines: readonly string[]): string[] {
  return lines.length > LISTED_PATHS
    ? [...lines.slice(0, LISTED_PATHS), `외 ${lines.length - LISTED_PATHS}개`]
    : [...lines];
}

/**
 * 할 일의 줄 — 받아 보기만 하고 볼트에 쓰지 않을 노트(`unchanged`)는 뺀다. 같은 노트가 두 번 오면 한 번만 적는다(재시도).
 */
function itemLines(items: readonly ProgressItem[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const item of items) {
    if (item.unchanged) continue;
    const line = `${OPERATION_TEXT[item.operation]} — ${item.path}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

/**
 * Sync dry-run 의 결과를 묶음으로 — 받을 것 · 올릴 것 · 충돌로 남을 것 · 처리하지 못할 것, 그 밖에 바뀔 DB 구조. 할 일이 없으면
 * 빈 배열.
 */
export function previewSections({ result, items }: SyncPreview): PreviewSection[] {
  const sections: PreviewSection[] = [];
  const pulled = itemLines(items.filter((item) => item.direction === "pull"));
  const pushed = itemLines(items.filter((item) => item.direction === "push"));
  if (pulled.length > 0) {
    sections.push({
      heading: `Notion 에서 받을 것 ${pulled.length}`,
      lines: listed(pulled),
      problem: false,
    });
  }
  if (pushed.length > 0) {
    sections.push({
      heading: `Notion 에 올릴 것 ${pushed.length}`,
      lines: listed(pushed),
      problem: false,
    });
  }
  if (result.conflicts.length > 0) {
    sections.push({
      heading: `충돌로 남을 것 ${result.conflicts.length}`,
      lines: listed(
        result.conflicts.map(
          (conflict) =>
            `${conflict.syncRecord.obsidianPath} — 양쪽에서 고쳐 「충돌 해결」 로 고르게 됩니다`,
        ),
      ),
      problem: true,
    });
  }
  const failed = [...result.pull.failed, ...result.push.failed];
  if (failed.length > 0) {
    sections.push({
      heading: `처리하지 못할 것 ${failed.length}`,
      lines: listed(failed.map((failure) => `${failure.path}: ${failure.error}`)),
      problem: true,
    });
  }

  const push = result.push;
  const others = [
    push.createdDatabases ? `Notion DB ${push.createdDatabases}개를 만듭니다` : null,
    push.schemaEdits?.length
      ? `DB 속성을 고칩니다 — ${push.schemaEdits.map((edit) => edit.path).join(", ")}`
      : null,
    push.viewEdits?.length
      ? `DB 보기를 고칩니다 — ${push.viewEdits.map((edit) => edit.path).join(", ")}`
      : null,
    push.renamedProperties?.length
      ? `Notion 열 이름을 바꿉니다 — ${push.renamedProperties.map(({ from, to }) => `${from} → ${to}`).join(", ")}`
      : null,
    push.databaseMoves?.length
      ? `DB 폴더 ${push.databaseMoves.length}개를 Notion 에서 옮깁니다`
      : null,
    push.unsentDeletions?.length
      ? `볼트에서 지운 노트 ${push.unsentDeletions.length}개는 Notion 에서 지우지 않습니다(삭제 동기화 꺼짐)`
      : null,
    result.pull.excluded?.length
      ? `동기화 범위 밖이라 받지 않는 Notion 페이지 ${result.pull.excluded.length}개`
      : null,
  ].filter((line): line is string => line !== null);
  if (others.length > 0) sections.push({ heading: "그 밖에", lines: others, problem: false });
  return sections;
}

/** Sync 미리 보기 — 연결마다 반영하지 않고 무엇을 할지 보인다. */
export class PreviewModal extends Modal {
  constructor(
    app: App,
    private readonly previews: readonly ConnectionPreview[],
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("im-nobsidian-sync-log-modal");
    contentEl.createEl("h2", { text: "Sync 미리 보기" });
    contentEl.createEl("p", {
      text: "아무것도 반영하지 않았습니다. 실제 Sync 는 그 사이 바뀐 것까지 함께 반영합니다.",
    });
    const named = this.previews.length > 1;
    for (const { label, preview } of this.previews) {
      if (named) contentEl.createEl("h3", { text: label });
      const sections = previewSections(preview);
      if (sections.length === 0) {
        contentEl.createEl("p", {
          text: "할 일이 없습니다 — 마지막으로 확인한 뒤 바뀐 것이 없습니다.",
        });
        continue;
      }
      for (const section of sections) {
        const entry = contentEl.createDiv({
          cls: section.problem
            ? "im-nobsidian-sync-log-entry mod-failed"
            : "im-nobsidian-sync-log-entry",
        });
        entry.createEl("h4", { text: section.heading });
        const list = entry.createEl("ul");
        for (const line of section.lines) list.createEl("li", { text: line });
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
