import { Command } from "commander";
import {
  ConfigManager,
  StateDB,
  NotionClient,
  SyncOrchestrator,
  NodeVaultFS,
} from "@im-nobsidian/core";
import {
  header,
  operationIcon,
  operationLabel,
  progress,
  summary,
  duration,
  failedItem,
  dimText,
  completionHeader,
  failedCountText,
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

      const failedCount = result.failed.length;
      console.log(`\n  ${completionHeader("Push", failedCount)}`);
      console.log(
        `  ${summary(result.created, result.updated, result.deleted)}  ${failedCountText(failedCount)}`,
      );
      console.log(`  ${duration(result.duration)}`);

      if (failedCount > 0) {
        console.log("");
        for (const f of result.failed) {
          failedItem(f.path, f.error);
        }
        // 종료 코드까지 실패로 남긴다 — push 가 반쯤 실패한 걸 자동화가 성공으로 보면 안 된다.
        process.exitCode = 1;
      }
    } finally {
      stateDb.close();
    }
  });
