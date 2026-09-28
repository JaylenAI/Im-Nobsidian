import { Command } from "commander";
import {
  ConfigManager,
  StateDB,
  NotionClient,
  SyncOrchestrator,
  NodeVaultFS,
  formatUnifiedDiff,
  lineDiff,
  matchesPathScope,
} from "@im-nobsidian/core";
import type { ChangeDiff } from "@im-nobsidian/core";
import { printUnifiedDiff } from "../utils/diff-output.js";

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

      let failed = 0;
      for (const change of changes) {
        // --remote: 마지막 스냅샷이 아니라 Notion 의 현재 본문을 기준선으로 삼는다.
        // 원격이 그 사이 바뀌었을 때 "내가 뭘 덮어쓰게 되는지"는 이 비교로만 보인다.
        if (options.remote && change.type !== "deleted") {
          // 옮긴 노트는 Notion 에 반영하기 전까지 추적 기록이 옛 자리에 있다 — Notion 쪽 이름도 그 자리다.
          let remotePath = change.path;
          let remote = await orchestrator.renderRemoteSnapshot(remotePath);
          if (remote === null && change.movedFrom) {
            remotePath = change.movedFrom;
            remote = await orchestrator.renderRemoteSnapshot(remotePath);
          }
          if (remote === null) {
            console.log(`--- (원격 없음) ${change.path}`);
            console.log(`+++ b/${change.path}`);
            console.log(`(아직 Notion 에 없는 파일입니다)`);
            console.log("");
            continue;
          }
          const currentContent = await vaultFs.readFile(change.path);
          const hunks = lineDiff(remote, currentContent);
          const lines = formatUnifiedDiff(hunks, `notion/${remotePath}`, `b/${change.path}`);
          // 이름 줄만 찍고 끝나면 같은 것인지 못 읽은 것인지 알 수 없다 — 같다고 적는다.
          if (hunks.length === 0) lines.push("(Notion 과 내용이 같습니다)");
          printUnifiedDiff(lines, options.color);
          console.log("");
          continue;
        }

        // 지난 동기화 때의 글과 지금 글 — 플러그인 변경 패널의 비교와 같은 두 글이다.
        let diff: ChangeDiff;
        try {
          diff = await orchestrator.localChangeDiff(change);
        } catch (error) {
          failed++;
          console.log(`--- a/${change.path}`);
          console.log(`(${error instanceof Error ? error.message : String(error)})`);
          console.log("");
          continue;
        }
        printChangeDiff(diff, options.color);
        console.log("");
      }
      // 보이지 못한 비교가 있으면 실패로 끝낸다 — 스크립트가 빠진 것을 알 수 있게.
      if (failed > 0) process.exitCode = 1;
    } finally {
      stateDb.close();
    }
  });

/** 옮긴 노트는 Git 처럼 옛 자리 · 새 자리를 먼저 적는다. 내용이 같으면 비교 대신 그렇다고 알린다. */
function printChangeDiff(diff: ChangeDiff, color: boolean): void {
  const oldPath = diff.before === null ? "/dev/null" : `a/${diff.movedFrom ?? diff.path}`;
  const newPath = diff.after === null ? "/dev/null" : `b/${diff.path}`;
  if (diff.movedFrom) {
    console.log(`rename from ${diff.movedFrom}`);
    console.log(`rename to ${diff.path}`);
    if (diff.before === diff.after) {
      console.log("(내용은 그대로입니다 — 자리만 옮겼습니다)");
      return;
    }
  }
  printUnifiedDiff(
    formatUnifiedDiff(lineDiff(diff.before ?? "", diff.after ?? ""), oldPath, newPath),
    color,
  );
}
