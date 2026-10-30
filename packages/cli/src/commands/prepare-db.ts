import { Command } from "commander";
import { ConfigManager, StateDB, NotionClient, SyncOrchestrator } from "@im-nobsidian/core";
import chalk from "chalk";
import { icons, failedItem } from "../utils/format.js";
import { obsidianConfigDir, openVaultFs, vaultArgPath } from "../utils/vault.js";

// 볼트에서 만든 노트 폴더를 Notion DB 로 올릴 준비(#75) — frontmatter · `.base` 로 사이드카를 써 둔다.
// Notion 에는 쓰지 않는다. 사이드카는 JSON 이라 push 전에 고칠 수 있다 — 무엇을 왜 그렇게 정했는지 보인다.
export const prepareDbCommand = new Command("prepare-db")
  .description("볼트의 노트 폴더를 다음 push 에서 Notion DB 로 만들도록 준비 (Notion 은 그대로)")
  .argument("<folder>", "DB 로 만들 폴더 — 볼트 기준 경로. 바로 아래 노트가 행이 된다")
  .action(async (folder: string) => {
    const cwd = process.cwd();
    const configManager = new ConfigManager(cwd);
    const config = await configManager.load();
    const stateDb = StateDB.open(configManager.dbPath);

    try {
      const client = NotionClient.fromConfig(config);
      const vaultFs = await openVaultFs(cwd, config.paths);
      const orchestrator = new SyncOrchestrator(config, stateDb, client, vaultFs);
      const report = await orchestrator.prepareFolderDatabase(
        vaultArgPath(folder),
        obsidianConfigDir(cwd),
      );

      console.log(`  ${icons.success} ${report.sidecarPath} — 행 ${report.rows}개`);
      if (report.pagesToRows > 0) {
        console.log(
          `    이미 올린 노트 ${report.pagesToRows}개는 push 가 같은 페이지째 이 DB 의 행으로 옮깁니다`,
        );
      }
      for (const property of report.properties) {
        console.log(`    ${property.name}: ${property.type} ${chalk.dim(`(${property.reason})`)}`);
      }
      if (report.views.length > 0) console.log(`    보기: ${report.views.join(", ")}`);
      for (const skip of report.skipped) {
        console.log(chalk.dim(`    옮기지 않음 — ${skip.what}: ${skip.reason}`));
      }
      console.log(chalk.dim("  타입을 바꾸려면 사이드카를 고친 뒤 push 하세요."));
    } catch (error) {
      failedItem(folder, error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } finally {
      stateDb.close();
    }
  });
