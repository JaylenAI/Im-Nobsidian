import { Command } from "commander";
import {
  ConfigManager,
  StateDB,
  NotionClient,
  SyncOrchestrator,
  NodeVaultFS,
} from "@im-nobsidian/core";
import { createTwoFilesPatch } from "diff";

export const diffCommand = new Command("diff")
  .description("로컬과 Notion 간의 차이 표시")
  .argument("[path]", "특정 파일 경로 (생략 시 변경된 모든 파일)")
  .option("--color", "컬러 출력", true)
  .action(async (targetPath: string | undefined, options) => {
    const cwd = process.cwd();
    const configManager = new ConfigManager(cwd);
    const config = await configManager.load();
    const stateDb = StateDB.open(configManager.dbPath);

    try {
      const client = new NotionClient({
        token: config.notion.token,
        concurrency: config.advanced.concurrency,
        timeoutMs: config.advanced.timeoutMs,
      });
      const vaultFs = new NodeVaultFS(cwd, config.paths);
      const orchestrator = new SyncOrchestrator(config, stateDb, client, vaultFs);

      const status = await orchestrator.statusLocal();

      const changes = targetPath
        ? status.localChanges.filter((c) => c.path === targetPath || c.path.startsWith(targetPath))
        : status.localChanges;

      if (changes.length === 0) {
        console.log("변경사항 없음");
        return;
      }

      for (const change of changes) {
        const record = stateDb.getByPath(change.path);

        if (change.type === "created") {
          const content = await vaultFs.readFile(change.path);
          const patch = createTwoFilesPatch("/dev/null", `b/${change.path}`, "", content);
          printPatch(patch, options.color, "/dev/null", `b/${change.path}`);
        } else if (change.type === "deleted") {
          if (record?.baseSnapshot) {
            const oldContent = record.baseSnapshot.toString("utf-8");
            const patch = createTwoFilesPatch(`a/${change.path}`, "/dev/null", oldContent, "");
            printPatch(patch, options.color, `a/${change.path}`, "/dev/null");
          } else {
            console.log(`--- a/${change.path}`);
            console.log(`+++ /dev/null`);
            console.log(`(이전 스냅샷 없음)`);
          }
        } else if (change.type === "modified" && record?.baseSnapshot) {
          const currentContent = await vaultFs.readFile(change.path);
          const baseContent = record.baseSnapshot.toString("utf-8");
          const patch = createTwoFilesPatch(
            `a/${change.path}`,
            `b/${change.path}`,
            baseContent,
            currentContent,
          );
          printPatch(patch, options.color, `a/${change.path}`, `b/${change.path}`);
        }

        console.log("");
      }
    } finally {
      stateDb.close();
    }
  });

function printPatch(patch: string, color: boolean, oldPath: string, newPath: string): void {
  for (const line of patch.split("\n")) {
    let output = line;
    if (line.startsWith("===")) {
      output = "===================================================================";
    } else if (line.startsWith("--- ")) {
      output = `--- ${oldPath}`;
    } else if (line.startsWith("+++ ")) {
      output = `+++ ${newPath}`;
    }

    if (!color) {
      console.log(output);
      continue;
    }

    if (output.startsWith("+++") || output.startsWith("---")) {
      console.log(`\x1b[1m${output}\x1b[0m`);
    } else if (output.startsWith("+")) {
      console.log(`\x1b[32m${output}\x1b[0m`);
    } else if (output.startsWith("-")) {
      console.log(`\x1b[31m${output}\x1b[0m`);
    } else if (output.startsWith("@@")) {
      console.log(`\x1b[36m${output}\x1b[0m`);
    } else {
      console.log(output);
    }
  }
}
