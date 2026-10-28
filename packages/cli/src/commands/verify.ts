import { Command } from "commander";
import { ConfigManager, StateDB, NotionClient, SyncOrchestrator } from "@im-nobsidian/core";
import type {
  CompletenessReport,
  NestedFolderPage,
  PageCompletenessReport,
  VaultCompletenessReport,
} from "@im-nobsidian/core";
import chalk from "chalk";
import { header, separator, icons, dimText } from "../utils/format.js";
import { openVaultFs } from "../utils/vault.js";

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

function printDatabaseSection(report: CompletenessReport): void {
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
  }
}

/**
 * 페이지 대조 출력 (R12-C).
 *
 * `local-only` 는 실패가 아니라 정보다 — 아직 push 하지 않은 로컬 노트·root 페이지 자신·
 * search 색인 지연이 전부 여기에 정상적으로 들어온다. 색을 달리 줘서 "고쳐야 할 것"과
 * "그냥 알아 둘 것"이 화면에서 섞이지 않게 한다.
 */
function printPageSection(report: PageCompletenessReport): void {
  console.log(`\n${header("  Page Completeness")}`);
  console.log(`  ${separator(50)}`);
  console.log(`  ${dimText("Remote pages:")} ${report.remotePages}`);
  console.log(`  ${dimText("Vault pages:")}  ${report.vaultPages}`);

  if (report.error) {
    console.log(`\n  ${icons.fail} ${chalk.yellow("Page enumeration failed")}`);
    console.log(`    ${dimText(report.error)}`);
    return;
  }

  if (report.missingIds.length > 0) {
    console.log(
      `\n  ${header(chalk.red(`Pages missing from vault: ${report.missingIds.length}`))}`,
    );
    printIdSample("missing", report.missingIds, chalk.red);
  }

  if (report.localOnlyIds.length > 0) {
    console.log(
      `\n  ${dimText(`local-only pages: ${report.localOnlyIds.length} (informational)`)}`,
    );
    printIdSample("local-only", report.localOnlyIds, dimText);
  }

  if (report.complete) {
    console.log(`\n  ${chalk.green("All remote pages present in vault")} ${icons.success}`);
  }
}

/**
 * 같은 이름의 두 겹 폴더 페이지 — 예전 빌드가 남긴 것(ADR-012). 어느 쪽을 지울지는 사람이 정하므로 알리고
 * 정리법만 보인다. 실패로 치지 않는다.
 */
function printNestedFolderPages(nested: readonly NestedFolderPage[]): void {
  if (nested.length === 0) return;
  console.log(`\n  ${header(chalk.yellow(`Nested same-name folder pages: ${nested.length}`))}`);
  console.log(
    dimText(
      "    같은 폴더를 나타내는 페이지가 Notion 에 두 겹입니다 — 예전 버전이 만들었을 수 있습니다.",
    ),
  );
  console.log(
    dimText(
      "    의도한 구조가 아니면 Notion 에서 안쪽 페이지의 내용을 바깥으로 옮기고 안쪽을 지운 뒤 pull 하세요.",
    ),
  );
  for (const pair of nested.slice(0, SAMPLE_LIMIT)) {
    console.log(`    ${chalk.yellow("⚠")} ${pair.folder}`);
    console.log(`        ${dimText(`outer ${pair.outer.path}  ${pair.outer.notionPageId}`)}`);
    console.log(`        ${dimText(`inner ${pair.inner.path}  ${pair.inner.notionPageId}`)}`);
  }
  if (nested.length > SAMPLE_LIMIT) {
    console.log(dimText(`    ... and ${nested.length - SAMPLE_LIMIT} more`));
  }
}

function printReport(report: VaultCompletenessReport): void {
  printDatabaseSection(report.databases);

  if (report.pages) {
    printPageSection(report.pages);
  } else {
    // DB 모드에는 root 서브트리가 없어 대조할 페이지 자체가 없다 — 생략을 명시한다.
    console.log(`\n  ${dimText("Page completeness: skipped (database mode)")}`);
  }

  printNestedFolderPages(report.nestedFolderPages);

  if (!report.complete) {
    console.log(
      `\n  ${dimText("Run")} ${chalk.cyan("nobsi pull")} ${dimText("to fetch what is missing")}`,
    );
  }
}

export const verifyCommand = new Command("verify")
  .description("완결성 검증 — 원격 DB 행·페이지가 볼트에 빠짐없이 있는지 대조 (API 호출)")
  .option("--json", "결과를 JSON 으로 출력")
  .action(async (opts: { json?: boolean }) => {
    const cwd = process.cwd();
    const configManager = new ConfigManager(cwd);
    const config = await configManager.load();
    const stateDb = StateDB.open(configManager.dbPath);

    try {
      const client = NotionClient.fromConfig(config);
      const vaultFs = await openVaultFs(cwd, config.paths);
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
