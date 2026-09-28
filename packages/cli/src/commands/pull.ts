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
  completionHeader,
  failedCountText,
  remoteScanLines,
} from "../utils/format.js";
import { enableJsonMode, printJson, pullJson } from "../utils/json-output.js";

export const pullCommand = new Command("pull")
  .description("Notion 변경사항을 로컬에 반영")
  .option("--dry-run", "실제 반영 없이 변경사항만 표시")
  .option("-p, --path <paths...>", "특정 경로만 pull")
  .option(
    "--force",
    "증분 감지를 건너뛰고 전체 스캔 (search 인덱싱 지연으로 누락된 신규 페이지·DB 복구)",
  )
  .option("--json", "결과를 JSON 한 줄로 출력 (자동화용 — 로그는 stderr)")
  .action(async (options) => {
    const json = options.json === true;
    if (json) enableJsonMode();
    const cwd = process.cwd();
    const configManager = new ConfigManager(cwd);
    const config = await configManager.load();
    const stateDb = StateDB.open(configManager.dbPath);

    try {
      const client = NotionClient.fromConfig(config);
      const vaultFs = new NodeVaultFS(cwd, config.paths);
      const orchestrator = new SyncOrchestrator(config, stateDb, client, vaultFs);

      if (!json) {
        console.log(`\n${header("  Pulling from Notion...")}`);
        if (options.dryRun) console.log(dimText("  (dry-run mode)"));
        console.log("");
      }

      const result = await orchestrator.pull({
        dryRun: options.dryRun,
        paths: options.path,
        force: options.force,
        onProgress: json
          ? undefined
          : (current, total, item) => {
              const icon = operationIcon(item.operation);
              const label = operationLabel(item.operation);
              const prog = progress(current, total);
              console.log(`  ${icon} ${item.path} ${prog} ${label}`);
            },
      });

      if (json) {
        printJson(pullJson(result));
        if (result.failed.length > 0) process.exitCode = 1;
        return;
      }

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

      const failedCount = result.failed.length;
      console.log(`\n  ${completionHeader("Pull", failedCount)}`);
      console.log(
        `  ${summary(result.created, result.updated, result.deleted)}  ${failedCountText(failedCount)}`,
      );
      // 복원은 별도 줄로 알린다 — 볼트에서 파일이 사라졌었다는 사실은 조용히 넘길 일이 아니다.
      if (result.restored > 0) {
        console.log(`  ${icons.success} ${chalk.yellow(`${result.restored} restored`)}`);
      }
      console.log(`  ${duration(result.duration)}`);
      if (result.remoteScan) {
        for (const line of remoteScanLines(result.remoteScan)) console.log(`  ${line}`);
      }

      if (result.conflicts.length > 0) {
        console.log(
          `\n  ${icons.conflict} ${chalk.magenta(`${result.conflicts.length} conflicts`)} — run ${chalk.cyan("nobsi resolve")}`,
        );
      }

      if (failedCount > 0) {
        console.log("");
        for (const f of result.failed) {
          failedItem(f.path, f.error);
        }
        // 종료 코드까지 실패로 남긴다 — 자동화가 pull 실패를 성공으로 집계하면 안 된다.
        process.exitCode = 1;
      }
    } finally {
      stateDb.close();
    }
  });
