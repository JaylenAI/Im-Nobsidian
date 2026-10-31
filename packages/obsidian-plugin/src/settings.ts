import type { App } from "obsidian";
import { PluginSettingTab, SecretComponent, Setting } from "obsidian";
import {
  DEFAULT_WATCH_DEBOUNCE_MS,
  IGNORE_FILE,
  notionIdFromInput,
  parseIgnorePatterns,
  systemTimeZone,
} from "@im-nobsidian/core";
import { AUTO_SYNC_INTERVAL_MINUTES } from "./constants.js";
import type ImNobsidianPlugin from "./main.js";
import type { FolderConnectionSettings, ImNobsidianSettings } from "./main.js";

type Direction = ImNobsidianSettings["syncDirection"];

/** 동기화 방향 — 고를 때 보이는 이름과, 막는 동작을 함께 적는다. 엔진은 막힌 방향을 조용히 건너뛴다. */
const DIRECTIONS: readonly { value: Direction; label: string }[] = [
  { value: "both", label: "양방향" },
  { value: "push", label: "Push만 (Obsidian → Notion)" },
  { value: "pull", label: "Pull만 (Notion → Obsidian)" },
];

/** 간격(초)을 사람이 읽는 말로 — 목록에 없는 예전 값(예: 45초)도 그대로 보인다. */
function intervalLabel(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60}분` : `${seconds}초`;
}

/**
 * 설정 화면 (U-03).
 *
 * 연결에 닿는 설정(토큰 · 루트 페이지 · 방향 · 시간대)은 창을 닫을 때 «한 번» 다시 연결한다 — 예전에는
 * 글자를 칠 때마다 상태 DB 를 닫고 다시 열었다. 자동 동기화 켜기 · 간격은 바로 걸린다 — 예전에는 다음
 * 실행까지 걸리지 않았다.
 */
export class ImNobsidianSettingTab extends PluginSettingTab {
  /** 연결 설정을 바꿨나 — 닫을 때 다시 연결한다. */
  private connectionChanged = false;

  constructor(
    app: App,
    private readonly plugin: ImNobsidianPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const { settings } = this.plugin;

    new Setting(containerEl).setName("연결").setHeading();

    new Setting(containerEl)
      .setName("Notion 토큰")
      .setDesc(
        "Notion 통합(Integration)의 토큰. Obsidian 키체인에 두어 이 기기에만 저장됩니다 — 볼트 설정 파일에는 " +
          "이름만 적힙니다. 다른 기기에서는 같은 이름으로 토큰을 한 번 더 넣으세요.",
      )
      .addComponent((el) =>
        new SecretComponent(this.app, el).setValue(settings.tokenSecret).onChange(async (value) => {
          settings.tokenSecret = value;
          await this.changeConnection();
        }),
      );

    const rootRow = new Setting(containerEl).setName("루트 페이지 ID");
    const showRoot = (value: string) => {
      const id = notionIdFromInput(value);
      rootRow.setDesc(
        id !== null
          ? `동기화할 Notion 루트 페이지 — ID ${id} 로 씁니다.`
          : value === ""
            ? "동기화할 Notion 루트 페이지 — 페이지 주소를 붙여 넣거나 주소 끝의 32자리 ID 를 넣으세요."
            : "주소나 ID 에서 Notion 페이지 ID(32자리)를 찾지 못했습니다 — 페이지 주소를 그대로 붙여 넣으세요.",
      );
      rootRow.descEl.toggleClass("mod-warning", id === null && value !== "");
    };
    showRoot(settings.rootPageId);
    rootRow.addText((text) =>
      text
        .setPlaceholder("https://www.notion.so/… 또는 페이지 ID")
        .setValue(settings.rootPageId)
        .onChange(async (value) => {
          // 주소를 붙여 넣으면 그 안의 ID 만 적는다. 알아볼 수 없는 값도 적어 두되 연결하지 않는다 — 고칠 때까지
          // 연결 상태가 그 까닭을 보인다.
          const trimmed = value.trim();
          settings.rootPageId = notionIdFromInput(trimmed) ?? trimmed;
          showRoot(trimmed);
          await this.changeConnection();
        }),
    );

    this.connectionRow(containerEl);
    this.folderConnections(containerEl);

    new Setting(containerEl).setName("동기화").setHeading();

    new Setting(containerEl)
      .setName("동기화 방향")
      .setDesc(
        "Push만이면 변경 패널의 Pull 단추가 꺼지고 명령은 까닭을 알립니다 — Pull만이면 Push 가 그렇습니다. " +
          "Sync 와 자동 동기화도 이 방향을 따릅니다.",
      )
      .addDropdown((dropdown) => {
        for (const { value, label } of DIRECTIONS) dropdown.addOption(value, label);
        dropdown.setValue(settings.syncDirection).onChange(async (value) => {
          settings.syncDirection = value as Direction;
          await this.changeConnection();
        });
      });

    new Setting(containerEl)
      .setName("Notion 에서 바꾼 제목으로 이름 바꾸기")
      .setDesc(
        "Notion 에서 페이지 제목을 바꾸면 노트 파일 이름도 바꾸고, 그 노트를 가리키던 다른 노트의 링크를 고칩니다. " +
          "끄면 파일 이름은 두고 새 제목을 frontmatter 의 title 에 적습니다.",
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.renameOnTitleChange ?? false).onChange(async (value) => {
          settings.renameOnTitleChange = value;
          await this.changeConnection();
        }),
      );

    new Setting(containerEl)
      .setName("다른 줄을 고친 충돌은 합치기")
      .setDesc(
        "노트와 Notion 이 둘 다 바뀌었어도 서로 다른 줄을 고쳤으면 두 변경을 합쳐 양쪽에 씁니다. 같은 줄을 다르게 " +
          "고쳤으면 예전처럼 충돌로 남겨 사이드바에서 고르게 합니다. 끄면 둘 다 바뀐 노트는 모두 충돌로 남습니다.",
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.conflictStrategy === "merge").onChange(async (value) => {
          settings.conflictStrategy = value ? "merge" : "manual";
          await this.changeConnection();
        }),
      );

    new Setting(containerEl)
      .setName("자동 동기화")
      .setDesc(
        `노트를 고치면 ${DEFAULT_WATCH_DEBOUNCE_MS / 1000}초 뒤에, 그리고 아래 간격마다 동기화합니다(동기화 방향을 따름). ` +
          "끄면 사이드바 단추와 명령으로만 동기화합니다.",
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.autoSync).onChange(async (value) => {
          settings.autoSync = value;
          await this.plugin.saveSettings();
          if (value) this.plugin.startAutoSync();
          else this.plugin.stopAutoSync();
        }),
      );

    new Setting(containerEl)
      .setName("자동 동기화 간격")
      .setDesc("Notion 의 변경을 이 간격마다 확인합니다. 바꾸면 바로 걸립니다.")
      .addDropdown((dropdown) => {
        const choices = AUTO_SYNC_INTERVAL_MINUTES.map((minutes) => minutes * 60);
        // 예전 설정은 아무 초나 적을 수 있었다 — 목록에 없어도 지금 값을 보인다.
        if (!choices.includes(settings.autoSyncInterval)) choices.push(settings.autoSyncInterval);
        for (const seconds of choices.sort((a, b) => a - b)) {
          dropdown.addOption(String(seconds), intervalLabel(seconds));
        }
        dropdown.setValue(String(settings.autoSyncInterval)).onChange(async (value) => {
          settings.autoSyncInterval = Number(value);
          await this.plugin.saveSettings();
          this.plugin.startAutoSync();
        });
      });

    new Setting(containerEl).setName("동기화 범위").setHeading();
    this.pathPatterns(containerEl, "", settings);

    new Setting(containerEl).setName("변환").setHeading();

    new Setting(containerEl)
      .setName("날짜시각 시간대")
      .setDesc(
        "Notion 날짜시각 속성을 노트에 적고 보낼 때 쓰는 시간대. 바꿔도 이미 적힌 시각은 고치지 않고, " +
          "고치지 않은 날짜는 다시 보내지 않습니다 — 새로 받거나 고친 날짜부터 이 시간대를 씁니다.",
      )
      .addDropdown((dropdown) => {
        dropdown.addOption("", `이 컴퓨터의 시간대 (${systemTimeZone()})`);
        const zones = Intl.supportedValuesOf("timeZone");
        if (settings.timeZone && !zones.includes(settings.timeZone))
          zones.unshift(settings.timeZone);
        for (const zone of zones) dropdown.addOption(zone, zone);
        dropdown.setValue(settings.timeZone).onChange(async (value) => {
          settings.timeZone = value;
          await this.changeConnection();
        });
      });
  }

  /** 닫을 때 — 연결 설정이 바뀌었으면 한 번 다시 연결한다. */
  hide(): void {
    if (!this.connectionChanged) return;
    this.connectionChanged = false;
    void this.plugin.initOrchestrator();
  }

  private async changeConnection(): Promise<void> {
    this.connectionChanged = true;
    this.refreshConnection();
    await this.plugin.saveSettings();
  }

  /** 연결 상태 — 동기화가 막히는 까닭을 여기서도 보인다. 다시 연결은 바꾼 설정을 바로 건다. */
  private connectionRow(containerEl: HTMLElement): void {
    const row = new Setting(containerEl).setName("연결 상태");
    const show = () => {
      const { ready, message } = this.plugin.connectionStatus();
      row.setDesc(
        this.connectionChanged ? "바꾼 설정은 이 창을 닫거나 다시 연결하면 걸립니다." : message,
      );
      row.descEl.toggleClass("mod-warning", !ready && !this.connectionChanged);
    };
    show();
    row.addButton((button) =>
      button.setButtonText("다시 연결").onClick(async () => {
        button.setDisabled(true);
        this.connectionChanged = false;
        await this.plugin.initOrchestrator();
        button.setDisabled(false);
        show();
      }),
    );
    this.refreshConnection = show;
  }

  /** 연결 상태 줄을 다시 그린다 — 연결 설정을 바꾸면 「닫으면 걸립니다」 로 바뀐다. */
  private refreshConnection: () => void = () => {};

  /**
   * 볼트 안 폴더 연결(ADR-038) — 폴더마다 다른 Notion 워크스페이스(토큰 · 루트 페이지)로 동기화한다. 폴더는
   * 볼트의 폴더에서 고른다. 다른 연결이 이미 노트를 동기화하는 폴더는 고를 수 없다 — 따로 연결하면 그 연결이
   * 그 노트들을 지운 것으로 본다.
   */
  private folderConnections(containerEl: HTMLElement): void {
    const { settings } = this.plugin;
    const connections = (settings.connections ??= []);

    new Setting(containerEl)
      .setName("폴더 연결")
      .setDesc(
        "볼트 안 폴더 하나를 다른 Notion 워크스페이스와 따로 동기화합니다 — 회사 · 개인 워크스페이스를 한 볼트에 " +
          "둘 때. 그 폴더는 볼트 연결이 비켜 갑니다. 연결 사이의 위키링크는 Notion 링크가 되지 않습니다.",
      )
      .setHeading();

    connections.forEach((connection, index) =>
      this.folderConnection(containerEl, connection, index),
    );

    const configured = new Set(connections.map((c) => c.folder));
    const cliOnly = this.plugin.knownConnectionFolders.filter(
      (f) => f !== "" && !configured.has(f),
    );
    if (cliOnly.length > 0) {
      new Setting(containerEl)
        .setName("CLI 로 만든 연결")
        .setDesc(
          `${cliOnly.join(", ")} — 플러그인은 동기화하지 않고 비켜 갑니다. 여기에 같은 폴더를 추가하면 플러그인도 ` +
            "그 연결(같은 상태 DB)로 동기화합니다.",
        );
    }

    const choices = this.folderChoices(null);
    const add = new Setting(containerEl)
      .setName("폴더 연결 추가")
      .setDesc(
        choices.length > 0
          ? "추가한 뒤 그 폴더의 Notion 토큰과 루트 페이지를 넣으세요."
          : "고를 수 있는 폴더가 없습니다 — 아직 동기화하지 않은 폴더를 먼저 만드세요.",
      );
    add.addButton((button) =>
      button
        .setButtonText("추가")
        .setDisabled(choices.length === 0)
        .onClick(async () => {
          connections.push({ folder: choices[0]!, tokenSecret: "", rootPageId: "" });
          await this.changeConnection();
          this.display();
        }),
    );
  }

  /** 폴더 연결 하나 — 폴더 · 토큰 · 루트 페이지 · 상태 · 지우기. */
  private folderConnection(
    containerEl: HTMLElement,
    connection: FolderConnectionSettings,
    index: number,
  ): void {
    const connections = this.plugin.settings.connections!;
    const tracked = this.plugin.trackedNotesUnder(connection.folder);
    const folderRow = new Setting(containerEl).setName(`폴더 연결 ${index + 1}`);
    const status = () => {
      if (tracked !== null && tracked > 0) {
        return (
          `이 폴더를 맡은 연결이 노트 ${tracked}개를 이미 동기화하고 있어 따로 연결하지 않습니다 — 다른 폴더를 ` +
          "고르세요."
        );
      }
      if (this.connectionChanged) return "바꾼 설정은 이 창을 닫거나 다시 연결하면 걸립니다.";
      return this.plugin.folderConnectionStatus(connection.folder).message;
    };
    const ready = () => this.plugin.folderConnectionStatus(connection.folder).ready;
    folderRow.setDesc(status());
    folderRow.descEl.toggleClass("mod-warning", !this.connectionChanged && !ready());
    folderRow.addDropdown((dropdown) => {
      for (const folder of this.folderChoices(connection.folder))
        dropdown.addOption(folder, folder);
      dropdown.setValue(connection.folder).onChange(async (value) => {
        connection.folder = value;
        await this.changeConnection();
        this.display();
      });
    });
    folderRow.addButton((button) =>
      button
        .setButtonText("지우기")
        .setWarning()
        .onClick(async () => {
          connections.splice(index, 1);
          await this.changeConnection();
          this.display();
        }),
    );

    new Setting(containerEl)
      .setName(`폴더 연결 ${index + 1} — Notion 토큰`)
      .setDesc("이 폴더를 동기화할 워크스페이스의 통합 토큰 — 키체인에 둡니다.")
      .addComponent((el) =>
        new SecretComponent(this.app, el)
          .setValue(connection.tokenSecret)
          .onChange(async (value) => {
            connection.tokenSecret = value;
            await this.changeConnection();
          }),
      );

    new Setting(containerEl)
      .setName(`폴더 연결 ${index + 1} — 루트 페이지 ID`)
      .setDesc("이 폴더의 노트를 둘 Notion 페이지 — 주소를 붙여 넣어도 됩니다.")
      .addText((text) =>
        text
          .setPlaceholder("https://www.notion.so/… 또는 페이지 ID")
          .setValue(connection.rootPageId)
          .onChange(async (value) => {
            const trimmed = value.trim();
            connection.rootPageId = notionIdFromInput(trimmed) ?? trimmed;
            await this.changeConnection();
          }),
      );

    this.pathPatterns(containerEl, `폴더 연결 ${index + 1} — `, connection);
  }

  /**
   * 동기화할 경로의 포함 · 제외 패턴 — CLI 의 `paths.include` · `paths.exclude` 와 같은 규칙이다. 한 줄에 하나,
   * `#` 로 시작하는 줄은 주석. 연결 폴더 기준 경로이고, 그 폴더의 `.im-nobsidian-ignore` 도 함께 뺀다.
   */
  private pathPatterns(
    containerEl: HTMLElement,
    prefix: string,
    target: { includePaths?: string[]; excludePaths?: string[] },
  ): void {
    const area = (
      name: string,
      desc: string,
      placeholder: string,
      key: "includePaths" | "excludePaths",
    ) =>
      new Setting(containerEl)
        .setName(`${prefix}${name}`)
        .setDesc(desc)
        .addTextArea((text) =>
          text
            .setPlaceholder(placeholder)
            .setValue((target[key] ?? []).join("\n"))
            .onChange(async (value) => {
              target[key] = parseIgnorePatterns(value);
              await this.changeConnection();
            }),
        );
    area(
      "포함 패턴",
      "이 패턴에 맞는 노트 · 첨부만 동기화합니다 — 한 줄에 하나. 비우면 전부. 예: `Work/**/*.md` 는 Work 아래 노트만.",
      "Work/**/*.md",
      "includePaths",
    );
    area(
      "제외 패턴",
      `이 패턴에 맞는 노트 · 폴더는 동기화하지 않습니다 — 한 줄에 하나. 폴더의 ${IGNORE_FILE} 에 적은 것도 뺍니다. ` +
        "이미 동기화한 노트를 빼도 Notion 페이지는 지우지 않습니다.",
      "Private\ntemplates/\n*.pdf",
      "excludePaths",
    );
  }

  /**
   * 폴더 연결이 고를 수 있는 폴더 — 볼트의 폴더 중 점 폴더 · 다른 폴더 연결 · 다른 연결이 노트를 동기화하는
   * 폴더를 뺀 것. `current` 는 지금 고른 값이라 빼지 않는다(밖에서 고쳐 넣은 값도 보인다).
   */
  private folderChoices(current: string | null): string[] {
    const taken = new Set(
      (this.plugin.settings.connections ?? []).map((c) => c.folder).filter((f) => f !== current),
    );
    const folders = this.app.vault
      .getAllFolders(false)
      .map((folder) => folder.path)
      .filter(
        (path) =>
          path === current ||
          (!path.split("/").some((part) => part.startsWith(".")) &&
            !taken.has(path) &&
            !this.plugin.trackedNotesUnder(path)),
      )
      .sort((a, b) => a.localeCompare(b));
    return current !== null && !folders.includes(current) ? [current, ...folders] : folders;
  }
}
