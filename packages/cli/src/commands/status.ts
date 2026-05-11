import { Command } from "commander";
import {
  ConfigManager,
  StateDB,
  NotionClient,
  SyncOrchestrator,
  NodeVaultFS,
} from "@obsinotion/core";

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

      const status = await orchestrator.status();

      if (status.lastSyncAt) {
        console.log(`마지막 동기화: ${status.lastSyncAt}`);
      } else {
        console.log("아직 동기화된 적 없음");
      }

      console.log("");

      if (status.localChanges.length === 0) {
        console.log("변경사항 없음 (clean)");
      } else {
        console.log(`로컬 변경사항 (${status.localChanges.length}건):`);
        for (const change of status.localChanges) {
          const prefix = change.type === "created" ? "+" : change.type === "deleted" ? "-" : "~";
          console.log(`  ${prefix} ${change.path}`);
        }
      }

      if (status.conflictRecords.length > 0) {
        console.log(`\n충돌 (${status.conflictRecords.length}건):`);
        for (const record of status.conflictRecords) {
          console.log(`  ⚠ ${record.obsidianPath}`);
        }
      }
    } finally {
      stateDb.close();
    }
  });
