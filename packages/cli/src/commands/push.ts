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
  operationIcon,
  operationLabel,
  progress,
  summary,
  duration,
  failedItem,
  dimText,
} from "../utils/format.js";

export const pushCommand = new Command("push")
  .description("로컬 변경사항을 Notion에 반영")
  .option("--dry-run", "실제 반영 없이 변경사항만 표시")
  .option("-p, --path <paths...>", "특정 경로만 push")
  .action(async (options) => {
    const cwd = process.cwd();
    const configManager = new ConfigManager(cwd);
    const config = await configManager.load();
    const stateDb = StateDB.open(configManager.dbPath);

    try {
      const client = NotionClient.fromConfig(config);
      const vaultFs = new NodeVaultFS(cwd, config.paths);
      const orchestrator = new SyncOrchestrator(config, stateDb, client, vaultFs);

      console.log(`\n${header("  Pushing to Notion...")}`);
      if (options.dryRun) console.log(dimText("  (dry-run mode)"));
      console.log("");

      const result = await orchestrator.push({
        dryRun: options.dryRun,
        paths: options.path,
        onProgress: (current, total, item) => {
          const icon = operationIcon(item.operation);
          const label = operationLabel(item.operation);
          const prog = progress(current, total);
          console.log(`  ${icon} ${item.path} ${prog} ${label}`);
        },
      });

      console.log(`\n  ${header(chalk.green("Push complete"))}`);
      console.log(
        `  ${summary(result.created, result.updated, result.deleted)}  ${dimText(`${result.failed.length} failed`)}`,
      );
      console.log(`  ${duration(result.duration)}`);

      if (result.failed.length > 0) {
        console.log("");
        for (const f of result.failed) {
          failedItem(f.path, f.error);
        }
      }
    } finally {
      stateDb.close();
    }
  });
