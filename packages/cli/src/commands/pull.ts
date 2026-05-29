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
  icons,
  failedItem,
  dimText,
} from "../utils/format.js";

export const pullCommand = new Command("pull")
  .description("Notion 변경사항을 로컬에 반영")
  .option("--dry-run", "실제 반영 없이 변경사항만 표시")
  .option("-p, --path <paths...>", "특정 경로만 pull")
  .action(async (options) => {
    const cwd = process.cwd();
    const configManager = new ConfigManager(cwd);
    const config = await configManager.load();
    const stateDb = StateDB.open(configManager.dbPath);

    try {
      const client = NotionClient.fromConfig(config);
      const vaultFs = new NodeVaultFS(cwd, config.paths);
      const orchestrator = new SyncOrchestrator(config, stateDb, client, vaultFs);

      console.log(`\n${header("  Pulling from Notion...")}`);
      if (options.dryRun) console.log(dimText("  (dry-run mode)"));
      console.log("");

      const result = await orchestrator.pull({
        dryRun: options.dryRun,
        paths: options.path,
        onProgress: (current, total, item) => {
          const icon = operationIcon(item.operation);
          const label = operationLabel(item.operation);
          const prog = progress(current, total);
          console.log(`  ${icon} ${item.path} ${prog} ${label}`);
        },
      });

      if (result.imageCount > 0) {
        console.log(
          `\n  ${icons.success} ${result.imageCount} images → ${dimText("attachments/")}`,
        );
      }
      if (result.fileCount > 0) {
        console.log(`  ${icons.success} ${result.fileCount} files → ${dimText("attachments/")}`);
      }
      if (result.linkCount > 0) {
        console.log(`  ${icons.success} ${result.linkCount} links resolved`);
      }

      console.log(`\n  ${header(chalk.green("Pull complete"))}`);
      console.log(
        `  ${summary(result.created, result.updated, result.deleted)}  ${dimText(`${result.failed.length} failed`)}`,
      );
      console.log(`  ${duration(result.duration)}`);

      if (result.conflicts.length > 0) {
        console.log(
          `\n  ${icons.conflict} ${chalk.magenta(`${result.conflicts.length} conflicts`)} — run ${chalk.cyan("nobsi resolve")}`,
        );
      }

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
