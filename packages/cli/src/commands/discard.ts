import { Command } from "commander";
import {
  ConfigManager,
  StateDB,
  NotionClient,
  SyncOrchestrator,
  NodeVaultFS,
} from "@im-nobsidian/core";
import { icons, failedItem } from "../utils/format.js";

// 변경 목록(status)에서 고른 노트를 지난 동기화 때의 글로 되돌린다 — Git 의 `restore` 와 같다.
// 플러그인 변경 패널의 ↺ 와 같은 동작(orchestrator.discardLocalChange)이고 Notion 은 건드리지 않는다.
// 하나를 되돌리지 못해도 나머지는 되돌린다 — 무엇이 왜 안 됐는지 경로마다 알리고 종료 코드로 남긴다.
export const discardCommand = new Command("discard")
  .description("로컬 변경을 지난 동기화 때의 글로 되돌리기 (Notion 은 그대로)")
  .argument("<paths...>", "되돌릴 노트 경로 — status 가 보인 볼트 기준 경로")
  .action(async (paths: string[]) => {
    const cwd = process.cwd();
    const configManager = new ConfigManager(cwd);
    const config = await configManager.load();
    const stateDb = StateDB.open(configManager.dbPath);

    try {
      const client = NotionClient.fromConfig(config);
      const vaultFs = new NodeVaultFS(cwd, config.paths);
      const orchestrator = new SyncOrchestrator(config, stateDb, client, vaultFs);

      let failed = 0;
      for (const path of paths) {
        try {
          await orchestrator.discardLocalChange(path);
          console.log(`  ${icons.success} ${path}`);
        } catch (error) {
          failed++;
          failedItem(path, error instanceof Error ? error.message : String(error));
        }
      }
      if (failed > 0) process.exitCode = 1;
    } finally {
      stateDb.close();
    }
  });
