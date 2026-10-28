import { Command, Option } from "commander";
import {
  ConfigManager,
  StateDB,
  NotionClient,
  SyncOrchestrator,
  IGNORE_FILE,
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
  restoredLines,
  LISTED_ITEMS,
} from "../utils/format.js";
import { enableJsonMode, printJson, pullJson } from "../utils/json-output.js";
import { openVaultFs, vaultArgPath } from "../utils/vault.js";

export const pullCommand = new Command("pull")
  .description("Notion 변경사항을 로컬에 반영")
  .option("--dry-run", "실제 반영 없이 변경사항만 표시")
  .option("-p, --path <paths...>", "특정 경로만 pull")
  .option(
    "--force",
    "증분 감지를 건너뛰고 전체 스캔 (search 인덱싱 지연으로 누락된 신규 페이지·DB 복구)",
  )
  // 다시 그려 봐야 바뀌는지 안다 — 미리 보기로는 보일 것이 없다(B14).
  .addOption(
    new Option(
      "--rerender",
      "Notion 에서 바뀌지 않은 받아 둔 노트도 지금 변환기로 다시 그림 (볼트에서 고친 노트는 그대로)",
    ).conflicts("dryRun"),
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
      const vaultFs = await openVaultFs(cwd, config.paths);
      const orchestrator = new SyncOrchestrator(config, stateDb, client, vaultFs);

      if (!json) {
        console.log(`\n${header("  Pulling from Notion...")}`);
        if (options.dryRun) console.log(dimText("  (dry-run mode)"));
        console.log("");
      }

      const result = await orchestrator.pull({
        dryRun: options.dryRun,
        paths: options.path?.map((path: string) => vaultArgPath(path)),
        force: options.force,
        rerender: options.rerender,
        onProgress: json
          ? undefined
          : (current, total, item) => {
              // 받아 봤지만 바뀌지 않은 노트 — 다시 그리기는 받아 둔 노트를 모두 받아 본다(B14).
              if (item.unchanged) return;
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
          `\n  ${icons.success} ${result.imageCount} images → ${dimText(`${config.paths.attachments}/`)}`,
        );
      }
      if (result.fileCount > 0) {
        console.log(
          `  ${icons.success} ${result.fileCount} files → ${dimText(`${config.paths.attachments}/`)}`,
        );
      }
      if (result.linkCount > 0) {
        console.log(`  ${icons.success} ${result.linkCount} links resolved`);
      }

      const failedCount = result.failed.length;
      console.log(`\n  ${completionHeader("Pull", failedCount)}`);
      console.log(
        `  ${summary(result.created, result.updated, result.deleted, result.moved?.length)}  ${failedCountText(failedCount)}`,
      );
      // 복원은 별도 줄로 알린다 — 볼트에서 파일이 사라졌었다는 사실은 조용히 넘길 일이 아니다.
      if (result.restored > 0) {
        console.log(`  ${icons.success} ${chalk.yellow(`${result.restored} restored`)}`);
      }
      for (const line of restoredLines(result.restoredPaths, options.dryRun)) {
        console.log(`  ${line}`);
      }
      // Notion 에서 옮긴 페이지 · 바꾼 제목 — 볼트의 노트가 어디로 갔는지 경로로 알린다(ADR-039 · ADR-040).
      for (const move of result.moved ?? []) {
        const verb = move.renamed ? "rename" : "move";
        console.log(
          `  ${icons.move} ${move.from} → ${move.to} ${dimText(options.dryRun ? `(would ${verb})` : `(${verb}d)`)}`,
        );
      }
      const excluded = result.excluded ?? [];
      if (excluded.length > 0) {
        console.log(
          `  ${icons.conflict} ${dimText(`${excluded.length} new in Notion ${options.dryRun ? "would not be" : "not"} pulled — excluded by paths / ${IGNORE_FILE}:`)}`,
        );
        for (const path of excluded.slice(0, LISTED_ITEMS))
          console.log(`    ${dimText(`· ${path}`)}`);
        if (excluded.length > LISTED_ITEMS)
          console.log(dimText(`    ... and ${excluded.length - LISTED_ITEMS} more`));
      }
      if ((result.relinked?.length ?? 0) > 0) {
        console.log(
          `  ${icons.success} ${dimText(`links updated in ${result.relinked!.length} notes`)}`,
        );
      }
      for (const skip of result.moveSkipped ?? []) {
        console.log(`  ${icons.conflict} ${skip.path} ${dimText(`(not moved: ${skip.reason})`)}`);
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
