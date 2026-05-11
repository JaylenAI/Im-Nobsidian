import { Command } from "commander";
import { select, confirm } from "@inquirer/prompts";
import {
  ConfigManager,
  StateDB,
  NotionClient,
  SyncOrchestrator,
  NodeVaultFS,
  ConflictResolver,
} from "@obsinotion/core";
import type { Conflict, ResolutionChoice } from "@obsinotion/core";

export const resolveCommand = new Command("resolve")
  .description("충돌을 해결합니다")
  .option("-s, --strategy <strategy>", "자동 해결 전략 (local-first, remote-first, duplicate)")
  .action(async (options: { strategy?: string }) => {
    const cwd = process.cwd();
    const configManager = new ConfigManager(cwd);

    try {
      const config = await configManager.load();
      const stateDb = StateDB.open(configManager.dbPath);
      const client = new NotionClient({
        token: config.notion.token,
        concurrency: 3,
        timeoutMs: 30000,
      });
      const vaultFs = new NodeVaultFS(cwd, config.paths);

      const orchestrator = new SyncOrchestrator(config, stateDb, client, vaultFs);
      const resolver = new ConflictResolver(stateDb, vaultFs);

      await orchestrator.status();
      const conflictRecords = stateDb.getByStatus("conflict");

      if (conflictRecords.length === 0) {
        console.log("충돌이 없습니다.");
        stateDb.close();
        return;
      }

      console.log(`\n충돌 ${conflictRecords.length}건 발견\n`);

      if (options.strategy) {
        const strategy = options.strategy as "local-first" | "remote-first" | "duplicate";
        const shouldProceed = await confirm({
          message: `${conflictRecords.length}건의 충돌을 '${strategy}' 전략으로 일괄 해결할까요?`,
        });

        if (!shouldProceed) {
          stateDb.close();
          return;
        }

        const pullResult = await orchestrator.pull();
        const results = await resolver.resolveAll(pullResult.conflicts, strategy);

        for (const result of results) {
          const icon = result.success ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
          console.log(`  ${icon} ${result.path} → ${result.choice}`);
        }
      } else {
        const pullResult = await orchestrator.pull();

        for (const conflict of pullResult.conflicts) {
          await resolveInteractive(conflict, resolver);
        }
      }

      stateDb.close();
      console.log("\n충돌 해결 완료");
    } catch (error) {
      console.error("오류:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

async function resolveInteractive(conflict: Conflict, resolver: ConflictResolver): Promise<void> {
  const path = conflict.syncRecord.obsidianPath;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`파일: \x1b[1m${path}\x1b[0m`);
  console.log(`${"─".repeat(60)}`);

  const diff = resolver.generateDiff(conflict);
  const diffLines = diff.split("\n");
  for (const line of diffLines) {
    if (line.startsWith("- ")) {
      console.log(`\x1b[31m${line}\x1b[0m`);
    } else if (line.startsWith("+ ")) {
      console.log(`\x1b[32m${line}\x1b[0m`);
    } else if (line.startsWith("---") || line.startsWith("+++")) {
      console.log(`\x1b[1m${line}\x1b[0m`);
    } else {
      console.log(line);
    }
  }

  const choice = await select<ResolutionChoice>({
    message: "어떻게 해결할까요?",
    choices: [
      { name: "로컬 유지 (Obsidian 버전 유지)", value: "local" },
      { name: "원격 유지 (Notion 버전으로 덮어쓰기)", value: "remote" },
      { name: "자동 병합 (3-way merge)", value: "merge" },
      { name: "복제 (원본 유지 + .conflict 파일 생성)", value: "duplicate" },
    ],
  });

  const result = await resolver.resolve(conflict, choice);

  if (result.success) {
    console.log(`\x1b[32m✓ ${path} → ${choice}로 해결\x1b[0m`);
  } else if (result.mergeHadConflicts) {
    console.log(`\x1b[33m⚠ ${path} → 자동 병합 완료 (수동 확인 필요한 충돌 마커 있음)\x1b[0m`);
  } else {
    console.log(`\x1b[31m✗ ${path} → 해결 실패\x1b[0m`);
  }
}
