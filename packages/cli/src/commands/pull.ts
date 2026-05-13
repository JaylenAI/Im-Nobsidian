import { Command } from "commander";
import {
  ConfigManager,
  StateDB,
  NotionClient,
  SyncOrchestrator,
  NodeVaultFS,
} from "@im-nobsidian/core";
import ora from "ora";

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
      const client = new NotionClient({
        token: config.notion.token,
        concurrency: config.advanced.concurrency,
        timeoutMs: config.advanced.timeoutMs,
      });
      const vaultFs = new NodeVaultFS(cwd, config.paths);
      const orchestrator = new SyncOrchestrator(config, stateDb, client, vaultFs);

      const spinner = ora("Pull 중...").start();
      const result = await orchestrator.pull({
        dryRun: options.dryRun,
        paths: options.path,
        onProgress: (current, total, _pageId) => {
          spinner.text = `Pull 중... [${current}/${total}]`;
        },
      });
      spinner.stop();

      console.log(`\n✓ Pull 완료 (${(result.duration / 1000).toFixed(1)}s)`);
      console.log(`  생성: ${result.created}`);
      console.log(`  수정: ${result.updated}`);
      console.log(`  삭제: ${result.deleted}`);

      if (result.conflicts.length > 0) {
        console.log(`  충돌: ${result.conflicts.length}`);
        console.log('  "nobsi resolve"로 충돌을 해결하세요.');
      }

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
