import { Command } from "commander";
import {
  ConfigManager,
  StateDB,
  NotionClient,
  SyncOrchestrator,
  NodeVaultFS,
} from "@im-nobsidian/core";
import chalk from "chalk";
import {
  header,
  separator,
  operationIcon,
  operationLabel,
  summary,
  duration,
  icons,
  dimText,
} from "../utils/format.js";

export const syncCommand = new Command("sync")
  .description("양방향 동기화 (Pull → Push)")
  .option("--dry-run", "실제 반영 없이 변경사항만 표시")
  .action(async (options) => {
    const cwd = process.cwd();
    const configManager = new ConfigManager(cwd);
    const config = await configManager.load();
    const stateDb = StateDB.open(configManager.dbPath);

    try {
      const client = new NotionClient({
        token: config.notion.token,
        concurrency: config.advanced.concurrency,
        timeoutMs: config.advanced.timeoutMs,
      });
      const vaultFs = new NodeVaultFS(cwd, config.paths);
      const orchestrator = new SyncOrchestrator(config, stateDb, client, vaultFs);

      console.log(`\n${header("  Bidirectional Sync")}`);
      console.log(`  ${separator()}`);
      if (options.dryRun) console.log(dimText("  (dry-run mode)"));

      // Pull phase
      console.log(`\n  ${header(chalk.blue("▼ Pull"))} ${dimText("(Notion → Obsidian)")}`);

      const pullResult = await orchestrator.pull({
        dryRun: options.dryRun,
        onProgress: (_current, _total, item) => {
          const icon = operationIcon(item.operation);
          const label = operationLabel(item.operation);
          console.log(`    ${icon} ${item.path} ${label}`);
        },
      });

      if (pullResult.imageCount > 0) {
        console.log(`    ${icons.success} ${pullResult.imageCount} images downloaded`);
      }
      if (pullResult.linkCount > 0) {
        console.log(`    ${icons.success} ${pullResult.linkCount} links resolved`);
      }

      // Push phase
      console.log(`\n  ${header(chalk.magenta("▲ Push"))} ${dimText("(Obsidian → Notion)")}`);

      const pushResult = await orchestrator.push({
        dryRun: options.dryRun,
        onProgress: (_current, _total, item) => {
          const icon = operationIcon(item.operation);
          const label = operationLabel(item.operation);
          console.log(`    ${icon} ${item.path} ${label}`);
        },
      });

      // Summary
      const totalDuration = pullResult.duration + pushResult.duration;
      console.log(`\n  ${header(chalk.green("Sync complete"))}`);
      console.log(
        `  ${chalk.blue("Pull:")} ${summary(pullResult.created, pullResult.updated, pullResult.deleted)}`,
      );
      console.log(
        `  ${chalk.magenta("Push:")} ${summary(pushResult.created, pushResult.updated, pushResult.deleted)}`,
      );
      console.log(`  ${duration(totalDuration)}`);

      if (pullResult.conflicts.length > 0) {
        console.log(
          `\n  ${icons.conflict} ${chalk.magenta(`${pullResult.conflicts.length} conflicts`)} — run ${chalk.cyan("nobsi resolve")}`,
        );
      }
    } finally {
      stateDb.close();
    }
  });
