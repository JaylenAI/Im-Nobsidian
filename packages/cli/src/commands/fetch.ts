import { Command } from "commander";
import {
  ConfigManager,
  StateDB,
  NotionClient,
  SyncOrchestrator,
  NodeVaultFS,
} from "@im-nobsidian/core";
import chalk from "chalk";
import { header, separator, dimText } from "../utils/format.js";

export const fetchCommand = new Command("fetch")
  .description("Notion 리모트 상태 스캔 (삭제 감지 포함)")
  .action(async () => {
    const cwd = process.cwd();
    const configManager = new ConfigManager(cwd);
    const config = await configManager.load();
    const stateDb = StateDB.open(configManager.dbPath);

    try {
      const client = NotionClient.fromConfig(config);
      const vaultFs = new NodeVaultFS(cwd, config.paths);
      const orchestrator = new SyncOrchestrator(config, stateDb, client, vaultFs);

      console.log(dimText("  Scanning remote pages..."));

      const result = await orchestrator.fetch();

      console.log(`\n${header("  Remote Scan")}`);
      console.log(`  ${separator(40)}`);

      if (result.newPages > 0) {
        console.log(`  ${chalk.cyan("+")} New pages:      ${result.newPages}`);
      }
      if (result.modifiedPages > 0) {
        console.log(`  ${chalk.yellow("~")} Modified pages: ${result.modifiedPages}`);
      }
      if (result.deletedPages > 0) {
        console.log(`  ${chalk.red("-")} Deleted pages:  ${result.deletedPages}`);
      }

      const total = result.newPages + result.modifiedPages + result.deletedPages;
      if (total === 0) {
        console.log(`  ${chalk.green("Remote is up to date")} ✓`);
      } else {
        console.log(
          `\n  ${dimText("Run")} ${chalk.cyan("nobsi pull")} ${dimText("to apply remote changes")}`,
        );
      }

      console.log(dimText(`\n  Completed in ${(result.duration / 1000).toFixed(1)}s`));
    } finally {
      stateDb.close();
    }
  });
