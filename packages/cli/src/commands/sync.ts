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
  separator,
  operationIcon,
  operationLabel,
  summary,
  duration,
  icons,
  dimText,
  completionHeader,
  failedItem,
} from "../utils/format.js";
import { enableJsonMode, printJson, pullJson, pushJson } from "../utils/json-output.js";

export const syncCommand = new Command("sync")
  .description("양방향 동기화 (Pull → Push)")
  .option("--dry-run", "실제 반영 없이 변경사항만 표시")
  .option("--json", "결과를 JSON 한 줄로 출력 (자동화용 — 로그는 stderr)")
  .action(async (options) => {
    const json = options.json === true;
    if (json) enableJsonMode();
    // 진행 로그는 사람용이다 — JSON 모드에서는 stdout 계약(JSON 한 줄)을 지키려고 끈다.
    const log = json ? () => {} : (line: string) => console.log(line);
    const cwd = process.cwd();
    const configManager = new ConfigManager(cwd);
    const config = await configManager.load();
    const stateDb = StateDB.open(configManager.dbPath);

    try {
      const client = NotionClient.fromConfig(config);
      const vaultFs = new NodeVaultFS(cwd, config.paths);
      const orchestrator = new SyncOrchestrator(config, stateDb, client, vaultFs);

      log(`\n${header("  Bidirectional Sync")}`);
      log(`  ${separator()}`);
      if (options.dryRun) log(dimText("  (dry-run mode)"));

      // Pull phase
      log(`\n  ${header(chalk.blue("▼ Pull"))} ${dimText("(Notion → Obsidian)")}`);

      const pullResult = await orchestrator.pull({
        dryRun: options.dryRun,
        onProgress: (_current, _total, item) => {
          const icon = operationIcon(item.operation);
          const label = operationLabel(item.operation);
          log(`    ${icon} ${item.path} ${label}`);
        },
      });

      if (pullResult.imageCount > 0) {
        log(`    ${icons.success} ${pullResult.imageCount} images downloaded`);
      }
      if (pullResult.linkCount > 0) {
        log(`    ${icons.success} ${pullResult.linkCount} links resolved`);
      }

      // Push phase
      log(`\n  ${header(chalk.magenta("▲ Push"))} ${dimText("(Obsidian → Notion)")}`);

      const pushResult = await orchestrator.push({
        dryRun: options.dryRun,
        onProgress: (_current, _total, item) => {
          const icon = operationIcon(item.operation);
          const label = operationLabel(item.operation);
          log(`    ${icon} ${item.path} ${label}`);
        },
      });

      if (json) {
        const pull = pullJson(pullResult);
        const push = pushJson(pushResult);
        printJson({
          pull,
          push,
          churn: pull.churn + push.churn,
          conflicts: pull.conflicts,
          durationMs: pullResult.duration + pushResult.duration,
        });
        if (pullResult.failed.length + pushResult.failed.length > 0) process.exitCode = 1;
        return;
      }

      // Summary
      // 예전엔 양쪽 failed 를 아예 찍지 않아, 전 건 실패한 sync 도 화면 끝은 초록 "complete"
      // 였다 — 실패를 헤더와 목록 양쪽에 드러낸다.
      const totalDuration = pullResult.duration + pushResult.duration;
      const pullFailed = pullResult.failed.length;
      const pushFailed = pushResult.failed.length;
      console.log(`\n  ${completionHeader("Sync", pullFailed + pushFailed)}`);
      console.log(
        `  ${chalk.blue("Pull:")} ${summary(pullResult.created, pullResult.updated, pullResult.deleted)}` +
          // 사라졌던 파일이 되살아난 경우에만 덧붙인다 — 평상시 요약을 어지럽히지 않는다.
          (pullResult.restored > 0 ? `  ${chalk.yellow(`${pullResult.restored} restored`)}` : "") +
          (pullFailed > 0 ? `  ${chalk.red(`${pullFailed} failed`)}` : ""),
      );
      console.log(
        `  ${chalk.magenta("Push:")} ${summary(pushResult.created, pushResult.updated, pushResult.deleted)}` +
          (pushFailed > 0 ? `  ${chalk.red(`${pushFailed} failed`)}` : ""),
      );
      console.log(`  ${duration(totalDuration)}`);

      if (pullResult.conflicts.length > 0) {
        console.log(
          `\n  ${icons.conflict} ${chalk.magenta(`${pullResult.conflicts.length} conflicts`)} — run ${chalk.cyan("nobsi resolve")}`,
        );
      }

      if (pullFailed + pushFailed > 0) {
        console.log("");
        for (const f of pullResult.failed) failedItem(f.path, f.error, "▼");
        for (const f of pushResult.failed) failedItem(f.path, f.error, "▲");
        process.exitCode = 1;
      }
    } finally {
      stateDb.close();
    }
  });
