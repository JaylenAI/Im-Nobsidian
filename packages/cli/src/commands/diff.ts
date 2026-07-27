import { Command } from "commander";
import {
  ConfigManager,
  StateDB,
  NotionClient,
  SyncOrchestrator,
  NodeVaultFS,
  matchesPathScope,
} from "@im-nobsidian/core";
import { createTwoFilesPatch } from "diff";

// 기본 비교 대상은 **마지막 동기화 스냅샷**이다(로컬에서 무엇을 고쳤는지). Notion 현재
// 본문과의 비교는 API 호출이 필요하므로 `--remote` 로 명시할 때만 한다 — 예전 설명은
// "로컬과 Notion 간의 차이"라고만 적어 두고 실제로는 원격을 한 번도 읽지 않았다.
export const diffCommand = new Command("diff")
  .description(
    "로컬 변경사항 표시 (기본: 마지막 동기화 시점과 비교, --remote: Notion 현재본과 비교)",
  )
  .argument("[path]", "특정 파일 경로 (생략 시 변경된 모든 파일)")
  .option("--color", "컬러 출력", true)
  .option("--remote", "Notion 현재 본문과 비교 (API 호출, 느림)")
  .action(async (targetPath: string | undefined, options) => {
    const cwd = process.cwd();
    const configManager = new ConfigManager(cwd);
    const config = await configManager.load();
    const stateDb = StateDB.open(configManager.dbPath);

    try {
      const client = NotionClient.fromConfig(config);
      const vaultFs = new NodeVaultFS(cwd, config.paths);
      const orchestrator = new SyncOrchestrator(config, stateDb, client, vaultFs);

      const status = await orchestrator.statusLocal();

      const changes = targetPath
        ? status.localChanges.filter((c) => matchesPathScope(c.path, targetPath))
        : status.localChanges;

      if (changes.length === 0) {
        console.log("변경사항 없음");
        return;
      }

      for (const change of changes) {
        const record = stateDb.getByPath(change.path);

        // --remote: 마지막 스냅샷이 아니라 Notion 의 현재 본문을 기준선으로 삼는다.
        // 원격이 그 사이 바뀌었을 때 "내가 뭘 덮어쓰게 되는지"는 이 비교로만 보인다.
        if (options.remote && change.type !== "deleted") {
          const remote = await orchestrator.renderRemoteSnapshot(change.path);
          if (remote === null) {
            console.log(`--- (원격 없음) ${change.path}`);
            console.log(`+++ b/${change.path}`);
            console.log(`(아직 Notion 에 없는 파일입니다)`);
            console.log("");
            continue;
          }
          const currentContent = await vaultFs.readFile(change.path);
          const patch = createTwoFilesPatch(
            `notion/${change.path}`,
            `b/${change.path}`,
            remote,
            currentContent,
          );
          printPatch(patch, options.color, `notion/${change.path}`, `b/${change.path}`);
          console.log("");
          continue;
        }

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
