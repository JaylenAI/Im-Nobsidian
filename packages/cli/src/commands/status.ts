import { Command } from "commander";
import {
  ConfigManager,
  StateDB,
  NotionClient,
  SyncOrchestrator,
  NodeVaultFS,
} from "@im-nobsidian/core";
import chalk from "chalk";
import { header, separator, icons, dimText } from "../utils/format.js";

export const statusCommand = new Command("status")
  .description("동기화 상태 확인")
  .action(async () => {
    const cwd = process.cwd();
    const configManager = new ConfigManager(cwd);
    const config = await configManager.load();
    const stateDb = StateDB.open(configManager.dbPath);

    try {
      const client = new NotionClient({
        token: config.notion.token,
        concurrency: config.advanced.concurrency,
      });
      const vaultFs = new NodeVaultFS(cwd, config.paths);
      const orchestrator = new SyncOrchestrator(config, stateDb, client, vaultFs);

      const status = await orchestrator.statusLocal();

      console.log(`\n${header("  Sync Status")}`);
      console.log(`  ${separator(50)}`);

      const rootId = config.notion.rootPageId;
      const direction = config.sync.direction === "both" ? "bidirectional" : config.sync.direction;
      console.log(`  ${dimText("Root page:")}  ${rootId.slice(0, 8)}...`);
      console.log(`  ${dimText("Direction:")}  ${direction}`);
      if (status.lastSyncAt) {
        const date = new Date(status.lastSyncAt);
        const iso =
          date.getFullYear() +
          "-" +
          String(date.getMonth() + 1).padStart(2, "0") +
          "-" +
          String(date.getDate()).padStart(2, "0") +
          " " +
          String(date.getHours()).padStart(2, "0") +
          ":" +
          String(date.getMinutes()).padStart(2, "0") +
          ":" +
          String(date.getSeconds()).padStart(2, "0");
        console.log(`  ${dimText("Last sync:")}  ${iso}`);
      } else {
        console.log(`  ${dimText("Last sync:")}  ${chalk.yellow("never")}`);
      }

      // Tracked files summary
      const allRecords = stateDb.getAll();
      const total = allRecords.length;
      const synced = allRecords.filter((r) => r.status === "synced").length;
      const conflictCount = status.conflictRecords.length;
      const createdChanges = status.localChanges.filter((c) => c.type === "created");
      const modifiedChanges = status.localChanges.filter((c) => c.type === "modified");

      console.log(`\n  ${header(`Tracked files: ${total}`)}`);
      console.log(`  ${icons.synced} ${chalk.green("synced")}     ${synced}`);
      if (modifiedChanges.length > 0) {
        console.log(`  ${icons.modified} ${chalk.yellow("modified")}   ${modifiedChanges.length}`);
      }
      if (createdChanges.length > 0) {
        console.log(`  ${icons.newFile} ${chalk.cyan("new")}        ${createdChanges.length}`);
      }
      if (conflictCount > 0) {
        console.log(`  ${icons.conflictDot} ${chalk.magenta("conflict")}   ${conflictCount}`);
      }

      // Modified files
      if (modifiedChanges.length > 0) {
        console.log(`\n  ${header("Modified files:")}`);
        for (const c of modifiedChanges.slice(0, 10)) {
          console.log(
            `    ${chalk.yellow("~")} ${c.path.padEnd(30)} ${dimText("(local changed)")}`,
          );
        }
        if (modifiedChanges.length > 10) {
          console.log(dimText(`    ... and ${modifiedChanges.length - 10} more`));
        }
      }

      // New files
      if (createdChanges.length > 0) {
        console.log(`\n  ${header("New files:")}`);
        for (const c of createdChanges.slice(0, 10)) {
          console.log(`    ${chalk.cyan("+")} ${c.path.padEnd(30)} ${dimText("(untracked)")}`);
        }
        if (createdChanges.length > 10) {
          console.log(dimText(`    ... and ${createdChanges.length - 10} more`));
        }
      }

      // Conflicts
      if (conflictCount > 0) {
        console.log(`\n  ${header(chalk.magenta("Conflicts:"))}`);
        for (const r of status.conflictRecords) {
          console.log(
            `    ${icons.conflict} ${r.obsidianPath.padEnd(30)} ${dimText("(both sides changed)")}`,
          );
        }
      }

      // Helpful commands
      if (status.localChanges.length > 0 || conflictCount > 0) {
        console.log("");
        if (conflictCount > 0) {
          console.log(
            `  ${dimText("Run")} ${chalk.cyan("nobsi resolve")} ${dimText("to resolve conflicts")}`,
          );
        }
        console.log(
          `  ${dimText("Run")} ${chalk.cyan("nobsi sync")} ${dimText("to push/pull changes")}`,
        );
      } else {
        console.log(`\n  ${chalk.green("Everything up to date")} ✓`);
      }
    } finally {
      stateDb.close();
    }
  });
