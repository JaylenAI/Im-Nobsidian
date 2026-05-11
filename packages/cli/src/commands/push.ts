import { Command } from "commander";
import {
  ConfigManager,
  StateDB,
  NotionClient,
  SyncOrchestrator,
  NodeVaultFS,
} from "@obsinotion/core";
import ora from "ora";

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
      const client = new NotionClient({
        token: config.notion.token,
        concurrency: config.advanced.concurrency,
        timeoutMs: config.advanced.timeoutMs,
      });
      const vaultFs = new NodeVaultFS(cwd);
      const orchestrator = new SyncOrchestrator(config, stateDb, client, vaultFs);

      const spinner = ora("Push 중...").start();
      const result = await orchestrator.push({
        dryRun: options.dryRun,
        paths: options.path,
        onProgress: (current, total, path) => {
          const name = path.split("/").pop() ?? path;
          spinner.text = `Push 중... [${current}/${total}] ${name}`;
        },
      });
      spinner.stop();

      console.log(`\n✓ Push 완료 (${(result.duration / 1000).toFixed(1)}s)`);
      console.log(`  생성: ${result.created}`);
      console.log(`  수정: ${result.updated}`);
      console.log(`  삭제: ${result.deleted}`);

      if (result.failed.length > 0) {
        console.log(`  실패: ${result.failed.length}`);
        for (const f of result.failed) {
          console.log(`    ✕ ${f.path}: ${f.error}`);
        }
      }
    } finally {
      stateDb.close();
    }
  });
