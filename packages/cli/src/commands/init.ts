import { Command } from "commander";
import { ConfigManager, NotionClient } from "@im-nobsidian/core";
import { input, confirm } from "@inquirer/prompts";
import ora from "ora";

export const initCommand = new Command("init")
  .description("Im-Nobsidian 초기 설정")
  .option("--token <token>", "Notion Integration Token")
  .option("--root-page-id <id>", "루트 페이지 ID")
  .option("--non-interactive", "비대화형 모드")
  .action(async (options: { token?: string; rootPageId?: string; nonInteractive?: boolean }) => {
    const cwd = process.cwd();
    const configManager = new ConfigManager(cwd);

    if (options.nonInteractive) {
      if (!options.token || !options.rootPageId) {
        console.error("비대화형 모드에서는 --token과 --root-page-id가 필수입니다.");
        process.exitCode = 1;
        return;
      }

      if (!options.token.startsWith("ntn_")) {
        console.error("토큰은 ntn_으로 시작해야 합니다.");
        process.exitCode = 1;
        return;
      }

      const spinner = ora("Notion 연결 확인 중...").start();
      try {
        const client = new NotionClient({ token: options.token });
        await client.search({ pageSize: 1, filter: { property: "object", value: "page" } });
        spinner.succeed("Notion 연결 성공");

        await configManager.init({ token: options.token, rootPageId: options.rootPageId });
        console.log("\n✓ Im-Nobsidian 초기화 완료!");
        console.log(`  설정: ${configManager.configPath}`);
        console.log(`  DB: ${configManager.dbPath}`);
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
      message: "Notion Internal Integration Token:",
      validate: (v) => v.startsWith("ntn_") || "ntn_으로 시작하는 토큰을 입력하세요",
    });

    const spinner = ora("Notion 연결 확인 중...").start();

    try {
      const client = new NotionClient({ token });
      const result = await client.search({
        pageSize: 10,
        filter: { property: "object", value: "page" },
      });
      spinner.succeed("Notion 연결 성공");

      if (result.results.length === 0) {
        spinner.warn("접근 가능한 페이지가 없습니다. Integration에 페이지를 공유해주세요.");
        return;
      }

      console.log("\n사용 가능한 루트 페이지:");
      for (const [i, page] of result.results.entries()) {
        const title = extractPageTitle(page);
        console.log(`  [${i + 1}] ${title}`);
      }

      const rootPageId = await input({
        message: "루트 페이지 ID (위에서 선택하거나 직접 입력):",
        default: result.results[0]?.id,
      });

      await configManager.init({ token, rootPageId });
      console.log("\n✓ Im-Nobsidian 초기화 완료!");
      console.log(`  설정: ${configManager.configPath}`);
      console.log(`  DB: ${configManager.dbPath}`);
      console.log("\n다음 명령으로 동기화를 시작하세요:");
      console.log("  nobsi pull   — Notion → 로컬");
      console.log("  nobsi push   — 로컬 → Notion");
      console.log("  nobsi sync   — 양방향");
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
