import { Command } from "commander";
import {
  ConfigManager,
  StateDB,
  NotionClient,
  SyncOrchestrator,
  NodeVaultFS,
} from "@im-nobsidian/core";
import type { CompletenessReport } from "@im-nobsidian/core";
import chalk from "chalk";
import { header, separator, icons, dimText } from "../utils/format.js";

/** 화면에 늘어놓을 id 최대 개수 — 나머지는 건수로 접는다. */
const SAMPLE_LIMIT = 10;

function printIdSample(label: string, ids: readonly string[], color: (s: string) => string): void {
  console.log(`      ${color(label)} ${ids.length}`);
  for (const id of ids.slice(0, SAMPLE_LIMIT)) {
    console.log(`        ${dimText(id)}`);
  }
  if (ids.length > SAMPLE_LIMIT) {
    console.log(dimText(`        ... and ${ids.length - SAMPLE_LIMIT} more`));
  }
}

function printReport(report: CompletenessReport): void {
  console.log(`\n${header("  DB Completeness")}`);
  console.log(`  ${separator(50)}`);
  console.log(`  ${dimText("Databases:")}  ${report.databases.length}`);
  console.log(`  ${dimText("Remote rows:")} ${report.remoteTotal}`);
  console.log(`  ${dimText("Vault rows:")}  ${report.localTotal}`);

  const broken = report.databases.filter((d) => d.missingIds.length > 0 || d.extraIds.length > 0);

  if (broken.length > 0) {
    console.log(`\n  ${header(chalk.red(`Incomplete databases: ${broken.length}`))}`);
    for (const db of broken) {
      console.log(
        `    ${icons.fail} ${db.databaseId}  ${dimText(`remote ${db.remoteRows} / vault ${db.localRows}`)}`,
      );
      if (db.missingIds.length > 0) printIdSample("missing", db.missingIds, chalk.red);
      if (db.extraIds.length > 0) printIdSample("extra", db.extraIds, chalk.yellow);
    }
  }

  if (report.failures.length > 0) {
    console.log(`\n  ${header(chalk.yellow(`Query failures: ${report.failures.length}`))}`);
    for (const failure of report.failures) {
      console.log(`    ${icons.fail} ${failure.databaseId}  ${dimText(failure.error)}`);
    }
  }

  if (report.complete) {
    console.log(`\n  ${chalk.green("All database rows present in vault")} ${icons.success}`);
  } else {
    console.log(
      `\n  ${dimText("Run")} ${chalk.cyan("nobsi pull")} ${dimText("to fetch the missing rows")}`,
    );
  }
}

export const verifyCommand = new Command("verify")
  .description("DB 완결성 검증 — 원격 행이 볼트에 빠짐없이 있는지 대조 (API 호출)")
  .option("--json", "결과를 JSON 으로 출력")
  .action(async (opts: { json?: boolean }) => {
    const cwd = process.cwd();
    const configManager = new ConfigManager(cwd);
    const config = await configManager.load();
    const stateDb = StateDB.open(configManager.dbPath);

    try {
      const client = NotionClient.fromConfig(config);
      const vaultFs = new NodeVaultFS(cwd, config.paths);
      const orchestrator = new SyncOrchestrator(config, stateDb, client, vaultFs);

      const report = await orchestrator.verifyCompleteness();

      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printReport(report);
      }

      // 미발견·잔재·조회 실패가 있으면 실패 종료한다 — CI·E2E 하니스가 이 코드로 판정한다.
      if (!report.complete) process.exitCode = 1;
    } finally {
      stateDb.close();
    }
  });
