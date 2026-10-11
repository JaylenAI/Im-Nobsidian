import type { App } from "obsidian";
import { PluginSettingTab, SecretComponent, Setting } from "obsidian";
import { systemTimeZone } from "@im-nobsidian/core";
import { AUTO_SYNC_INTERVAL_MINUTES } from "./constants.js";
import type ImNobsidianPlugin from "./main.js";
import type { ImNobsidianSettings } from "./main.js";

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

    new Setting(containerEl)
      .setName("루트 페이지 ID")
      .setDesc("동기화할 Notion 루트 페이지의 ID — 페이지 주소 끝의 32자리입니다.")
      .addText((text) =>
        text
          .setPlaceholder("페이지 ID")
          .setValue(settings.rootPageId)
          .onChange(async (value) => {
            settings.rootPageId = value.trim();
            await this.changeConnection();
          }),
      );

    this.connectionRow(containerEl);

    new Setting(containerEl).setName("동기화").setHeading();

    new Setting(containerEl)
      .setName("동기화 방향")
      .setDesc(
        "Push만이면 Pull 단추 · 명령이 아무것도 받지 않고, Pull만이면 Push 가 아무것도 보내지 않습니다. " +
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
      .setName("자동 동기화")
      .setDesc(
        "노트를 고치면 2초 뒤에, 그리고 아래 간격마다 동기화합니다(동기화 방향을 따름). " +
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
}
