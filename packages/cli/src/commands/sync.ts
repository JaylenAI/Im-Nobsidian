import { Command } from "commander";
import {
  ConfigManager,
  StateDB,
  NotionClient,
  SyncOrchestrator,
  NodeVaultFS,
} from "@obsinotion/core";
import ora from "ora";

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
      const vaultFs = new NodeVaultFS(cwd);
      const orchestrator = new SyncOrchestrator(config, stateDb, client, vaultFs);

      const spinner = ora("동기화 중...").start();
      const result = await orchestrator.sync({ dryRun: options.dryRun });
      spinner.stop();

      console.log(`\n✓ 동기화 완료 (${(result.duration / 1000).toFixed(1)}s)`);
      console.log(
        `  Pull: +${result.pull.created} ~${result.pull.updated} -${result.pull.deleted}`,
      );
      console.log(
        `  Push: +${result.push.created} ~${result.push.updated} -${result.push.deleted}`,
      );

      if (result.conflicts.length > 0) {
        console.log(`\n  ⚠ 충돌 ${result.conflicts.length}건`);
      }
    } finally {
      stateDb.close();
    }
  });
