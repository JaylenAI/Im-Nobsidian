import { Modal, type App } from "obsidian";
import { notionPageUrl, type VaultCompletenessReport } from "@im-nobsidian/core";

/** 한 묶음에 적는 id · 경로 수 — 넘으면 「외 N개」 로 줄인다. 다 받으면 수가 아니라 Pull 이 고친다. */
export const LISTED_IDS = 10;

/** 확인 결과 한 묶음. */
export interface VerifySection {
  readonly heading: string;
  readonly lines: readonly string[];
  /** 고쳐야 할 것 — 오류색. 알아 둘 것(볼트에만 있는 페이지 · 두 겹 폴더)은 false. */
  readonly problem: boolean;
}

/** 연결 하나의 확인 결과. */
export interface ConnectionVerify {
  readonly label: string;
  readonly report: VaultCompletenessReport;
  /** Notion id 를 볼트 경로로 — 상태 기록에 없으면 null. */
  readonly pathOf: (notionId: string) => string | null;
}

function listed(ids: readonly string[], line: (id: string) => string): string[] {
  const shown = ids.slice(0, LISTED_IDS).map(line);
  return ids.length > LISTED_IDS ? [...shown, `외 ${ids.length - LISTED_IDS}개`] : shown;
}

/** 볼트 쪽 것은 경로로, 경로를 모르면 Notion 주소로 — id 만으로는 무엇인지 알 수 없다. */
function where(id: string, pathOf: ConnectionVerify["pathOf"]): string {
  return pathOf(id) ?? notionPageUrl(id);
}

/**
 * CLI `verify` 의 결과를 사람이 읽는 묶음으로 — Notion 의 DB 행 · 페이지 가운데 볼트에 없는 것, 볼트에만 남은 행, 읽지 못한 DB.
 * 「읽지 못했다」 를 「없다」 로 접지 않는다 — 읽지 못한 DB · 페이지 목록은 따로 문제로 보인다.
 */
export function verifySections({ report, pathOf }: ConnectionVerify): VerifySection[] {
  const sections: VerifySection[] = [];
  const { databases, pages, nestedFolderPages } = report;

  if (databases.databases.length > 0 || databases.failures.length > 0) {
    const lines = [
      `DB ${databases.databases.length}개 · Notion 행 ${databases.remoteTotal} · 볼트 행 ${databases.localTotal}`,
    ];
    for (const database of databases.databases) {
      if (database.missingIds.length > 0) {
        lines.push(
          `볼트에 없는 행 ${database.missingIds.length}개 — DB ${notionPageUrl(database.databaseId)}`,
        );
        lines.push(...listed(database.missingIds, (id) => `  ${notionPageUrl(id)}`));
      }
      if (database.extraIds.length > 0) {
        lines.push(
          `Notion 에 없는 행 ${database.extraIds.length}개 — Notion 에서 지웠거나 다른 곳으로 옮긴 행이 볼트에 남았습니다`,
        );
        lines.push(...listed(database.extraIds, (id) => `  ${where(id, pathOf)}`));
      }
    }
    for (const failure of databases.failures) {
      lines.push(`읽지 못한 DB — ${notionPageUrl(failure.databaseId)}: ${failure.error}`);
    }
    sections.push({ heading: "Notion DB 행", lines, problem: !databases.complete });
  }

  if (!pages) {
    sections.push({
      heading: "Notion 페이지",
      lines: ["DB 모드라 페이지는 견주지 않습니다."],
      problem: false,
    });
  } else if (pages.error) {
    sections.push({
      heading: "Notion 페이지",
      lines: [`Notion 페이지 목록을 읽지 못했습니다 — ${pages.error}`],
      problem: true,
    });
  } else {
    const lines = [`Notion 페이지 ${pages.remotePages} · 볼트 페이지 ${pages.vaultPages}`];
    if (pages.missingIds.length > 0) {
      lines.push(`볼트에 없는 페이지 ${pages.missingIds.length}개`);
      lines.push(...listed(pages.missingIds, (id) => `  ${notionPageUrl(id)}`));
    }
    sections.push({ heading: "Notion 페이지", lines, problem: !pages.complete });
    if (pages.localOnlyIds.length > 0) {
      sections.push({
        heading: `볼트에만 있는 페이지 ${pages.localOnlyIds.length}개`,
        lines: [
          "문제가 아닐 수 있습니다 — 아직 Push 하지 않은 노트 · 루트 페이지 자신 · Notion 검색이 아직 따라오지 못한 새 페이지도 여기 듭니다.",
          ...listed(pages.localOnlyIds, (id) => `  ${where(id, pathOf)}`),
        ],
        problem: false,
      });
    }
  }

  if (nestedFolderPages.length > 0) {
    sections.push({
      heading: `같은 이름으로 두 겹인 폴더 페이지 ${nestedFolderPages.length}개`,
      lines: [
        "예전 버전이 만들었을 수 있습니다. 의도한 구조가 아니면 Notion 에서 안쪽 페이지의 내용을 바깥으로 옮기고 안쪽을 지운 뒤 Pull 하세요.",
        ...nestedFolderPages
          .slice(0, LISTED_IDS)
          .map((pair) => `  ${pair.folder} — 바깥 ${pair.outer.path} · 안쪽 ${pair.inner.path}`),
      ],
      problem: false,
    });
  }
  return sections;
}

/** 빠짐없이 받았는지 — 연결마다 결과를 보인다(CLI `verify`). */
export class VerifyModal extends Modal {
  constructor(
    app: App,
    private readonly results: readonly ConnectionVerify[],
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.modalEl.addClass("im-nobsidian-sync-log-modal");
    contentEl.createEl("h2", { text: "빠짐없이 받았는지 확인" });
    const named = this.results.length > 1;
    for (const result of this.results) {
      if (named) contentEl.createEl("h3", { text: result.label });
      contentEl.createEl("p", {
        text: result.report.complete
          ? "Notion 의 DB 행 · 페이지를 볼트에 모두 받았습니다."
          : "볼트에 없거나 읽지 못한 것이 있습니다 — 「Pull from Notion (전체 확인)」 이 Notion 전체를 다시 보고 받습니다.",
      });
      for (const section of verifySections(result)) {
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
