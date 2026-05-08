import type { App } from "obsidian";
import { PluginSettingTab, Setting } from "obsidian";
import type ObsiNotionPlugin from "./main.js";

export class ObsiNotionSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: ObsiNotionPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "ObsiNotion 설정" });

    new Setting(containerEl)
      .setName("Notion Integration Token")
      .setDesc("Notion Internal Integration의 토큰 (ntn_으로 시작)")
      .addText((text) =>
        text
          .setPlaceholder("ntn_...")
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            this.plugin.settings.token = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("루트 페이지 ID")
      .setDesc("동기화할 Notion 루트 페이지의 ID")
      .addText((text) =>
        text
          .setPlaceholder("페이지 ID")
          .setValue(this.plugin.settings.rootPageId)
          .onChange(async (value) => {
            this.plugin.settings.rootPageId = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("동기화 방향")
      .setDesc("기본 동기화 방향")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("both", "양방향")
          .addOption("push", "Push만 (Obsidian → Notion)")
          .addOption("pull", "Pull만 (Notion → Obsidian)")
          .setValue(this.plugin.settings.syncDirection)
          .onChange(async (value) => {
            this.plugin.settings.syncDirection = value as "push" | "pull" | "both";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("자동 동기화")
      .setDesc("파일 저장 시 자동으로 Notion에 push")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("자동 동기화 간격 (초)")
      .setDesc("자동 Pull 주기 (30~3600초)")
      .addText((text) =>
        text
          .setPlaceholder("300")
          .setValue(String(this.plugin.settings.autoSyncInterval))
          .onChange(async (value) => {
            const num = Number(value);
            if (num >= 30 && num <= 3600) {
              this.plugin.settings.autoSyncInterval = num;
              await this.plugin.saveSettings();
            }
          }),
      );
  }
}
