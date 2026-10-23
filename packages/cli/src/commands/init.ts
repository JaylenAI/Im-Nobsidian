import { Command } from "commander";
import {
  ConfigManager,
  NOTION_TOKEN_PREFIX,
  NotionClient,
  notionIdFromInput,
} from "@im-nobsidian/core";
import { input, confirm } from "@inquirer/prompts";
import ora from "ora";
import chalk from "chalk";
import { header, separator, icons, dimText } from "../utils/format.js";
import { outerConnectionTracking } from "../utils/vault.js";

/** 루트 페이지에서 ID 를 못 찾았을 때 — 주소를 그대로 붙여 넣어도 된다고 말한다. */
const ROOT_PAGE_UNREADABLE =
  "루트 페이지에서 Notion 페이지 ID(32자리)를 찾지 못했습니다 — 페이지 주소나 ID 를 넣으세요.";

export const initCommand = new Command("init")
  .description("Im-Nobsidian 초기 설정")
  .option("--token <token>", "Notion Integration Token")
  .option("--root-page-id <id>", "루트 페이지 ID 또는 페이지 주소")
  .option("--non-interactive", "비대화형 모드")
  .action(async (options: { token?: string; rootPageId?: string; nonInteractive?: boolean }) => {
    const cwd = process.cwd();
    const configManager = new ConfigManager(cwd);

    console.log(`\n${header(chalk.cyan("  Im-Nobsidian Setup"))}`);
    console.log(`  ${separator()}`);

    // 바깥 연결이 이미 이 폴더를 동기화하면 따로 연결하지 않는다(ADR-038) — 바깥 연결이 멈춘다.
    const outer = outerConnectionTracking(cwd);
    if (outer) {
      console.error(
        `이 폴더는 이미 ${outer.folder} 의 연결이 노트 ${outer.notes}개를 동기화하고 있어 따로 연결할 수 없습니다.`,
      );
      process.exitCode = 1;
      return;
    }

    if (options.nonInteractive) {
      if (!options.token || !options.rootPageId) {
        console.error("비대화형 모드에서는 --token과 --root-page-id가 필수입니다.");
        process.exitCode = 1;
        return;
      }

      if (!options.token.startsWith(NOTION_TOKEN_PREFIX)) {
        console.error(`토큰은 ${NOTION_TOKEN_PREFIX}으로 시작해야 합니다.`);
        process.exitCode = 1;
        return;
      }

      const rootPageId = notionIdFromInput(options.rootPageId);
      if (rootPageId === null) {
        console.error(ROOT_PAGE_UNREADABLE);
        process.exitCode = 1;
        return;
      }

      const spinner = ora("Notion 연결 확인 중...").start();
      try {
        const client = new NotionClient({ token: options.token });
        await client.search({ pageSize: 1, filter: { property: "object", value: "page" } });
        spinner.stop();
        console.log(`  ${icons.success} Token validated`);

        await configManager.init({ token: options.token, rootPageId });
        console.log(`\n  ${icons.success} Config saved to ${dimText(configManager.configPath)}`);
        console.log(
          `\n  ${header(chalk.green("Ready!"))} Run ${chalk.cyan("nobsi sync")} to start syncing.`,
        );
      } catch (error) {
        spinner.fail("Notion 연결 실패");
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      }
      return;
    }

    const isInit = await configManager.isInitialized();
    if (isInit) {
      const overwrite = await confirm({
        message: "이미 초기화되어 있습니다. 다시 설정할까요?",
        default: false,
      });
      if (!overwrite) return;
    }

    const token = await input({
      message: "Notion Integration Token:",
      validate: (v) =>
        v.startsWith(NOTION_TOKEN_PREFIX) ||
        `${NOTION_TOKEN_PREFIX}으로 시작하는 토큰을 입력하세요`,
    });

    const spinner = ora("Notion 연결 확인 중...").start();

    try {
      const client = new NotionClient({ token });
      const result = await client.search({
        pageSize: 10,
        filter: { property: "object", value: "page" },
      });
      spinner.stop();
      console.log(`  ${icons.success} Token validated`);

      if (result.results.length === 0) {
        console.log(
          `\n  ${chalk.yellow("⚠")} 접근 가능한 페이지가 없습니다. Integration에 페이지를 공유해주세요.`,
        );
        return;
      }

      console.log(`\n  Select root page:`);
      for (const [i, page] of result.results.entries()) {
        const title = extractPageTitle(page);
        console.log(`    ${dimText(`${i + 1}.`)} ${title}`);
      }

      const rootPageInput = await input({
        message: "루트 페이지 ID 또는 주소 (위에서 선택하거나 직접 입력):",
        default: result.results[0]?.id,
        validate: (value) => notionIdFromInput(value) !== null || ROOT_PAGE_UNREADABLE,
      });
      const rootPageId = notionIdFromInput(rootPageInput)!;

      await configManager.init({ token, rootPageId });
      console.log(`\n  ${icons.success} Config saved to ${dimText(configManager.configPath)}`);
      console.log(
        `\n  ${header(chalk.green("Ready!"))} Run ${chalk.cyan("nobsi sync")} to start syncing.`,
      );
    } catch (error) {
      spinner.fail("Notion 연결 실패");
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  });

function extractPageTitle(page: Record<string, unknown>): string {
  const properties = page["properties"] as Record<string, unknown> | undefined;
  if (!properties) return "(제목 없음)";

  for (const prop of Object.values(properties)) {
    const p = prop as { type?: string; title?: Array<{ plain_text?: string }> };
    if (p.type === "title" && p.title?.[0]?.plain_text) {
      return p.title[0].plain_text;
    }
  }
  return "(제목 없음)";
}
