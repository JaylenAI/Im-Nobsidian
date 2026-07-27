import { Command } from "commander";
import {
  ConfigManager,
  StateDB,
  NotionClient,
  SyncOrchestrator,
  NodeVaultFS,
} from "@im-nobsidian/core";
import chalk from "chalk";
import { header, separator, icons, dimText } from "../utils/format.js";

export const statusCommand = new Command("status")
  .description("동기화 상태 확인 (--full: 원격 변경 포함)")
  .option("--full", "Notion 원격 변경까지 양방향 확인 (API 호출, 느림)")
  .action(async (opts: { full?: boolean }) => {
    const cwd = process.cwd();
    const configManager = new ConfigManager(cwd);
    const config = await configManager.load();
    const stateDb = StateDB.open(configManager.dbPath);

    try {
      const client = NotionClient.fromConfig(config);
      const vaultFs = new NodeVaultFS(cwd, config.paths);
      const orchestrator = new SyncOrchestrator(config, stateDb, client, vaultFs);

      const status = opts.full ? await orchestrator.status() : await orchestrator.statusLocal();

      console.log(`\n${header("  Sync Status")}`);
      console.log(`  ${separator(50)}`);

      const rootId = config.notion.rootPageId;
      const direction = config.sync.direction === "both" ? "bidirectional" : config.sync.direction;
      console.log(`  ${dimText("Root page:")}  ${rootId.slice(0, 8)}...`);
      console.log(`  ${dimText("Direction:")}  ${direction}`);
      if (status.lastSyncAt) {
        const date = new Date(status.lastSyncAt);
        const iso =
          date.getFullYear() +
          "-" +
          String(date.getMonth() + 1).padStart(2, "0") +
          "-" +
          String(date.getDate()).padStart(2, "0") +
          " " +
          String(date.getHours()).padStart(2, "0") +
          ":" +
          String(date.getMinutes()).padStart(2, "0") +
          ":" +
          String(date.getSeconds()).padStart(2, "0");
        console.log(`  ${dimText("Last sync:")}  ${iso}`);
      } else {
        console.log(`  ${dimText("Last sync:")}  ${chalk.yellow("never")}`);
      }

      // Tracked files summary
      const allRecords = stateDb.getAll();
      const total = allRecords.length;
      const conflictCount = status.conflictRecords.length;
      const createdChanges = status.localChanges.filter((c) => c.type === "created");
      const modifiedChanges = status.localChanges.filter((c) => c.type === "modified");
      const deletedChanges = status.localChanges.filter((c) => c.type === "deleted");

      // 추적 파일 내역은 서로 겹치지 않아야 한다. DB 의 status 는 push/pull 시점에만 갱신되므로
      // 방금 고친 파일도 레코드상으론 여전히 'synced' 다 — 그대로 세면 같은 파일이 synced 와
      // modified 양쪽에 잡혀 내역 합이 총계를 넘는 표가 나온다(무엇이 밀렸는지 못 읽는다).
      // 실제 변경이 걸린 경로를 먼저 덜어 내고 남은 것만 synced 로 센다.
      const dirtyPaths = new Set([
        ...modifiedChanges.map((c) => c.path),
        ...deletedChanges.map((c) => c.path),
        ...status.conflictRecords.map((r) => r.obsidianPath),
      ]);
      const synced = allRecords.filter(
        (r) => r.status === "synced" && !dirtyPaths.has(r.obsidianPath),
      ).length;
      const remoteCreated = status.remoteChanges.filter((c) => c.type === "created");
      const remoteModified = status.remoteChanges.filter((c) => c.type === "modified");
      const remoteDeleted = status.remoteChanges.filter((c) => c.type === "deleted");

      console.log(`\n  ${header(`Tracked files: ${total}`)}`);
      console.log(`  ${icons.synced} ${chalk.green("synced")}     ${synced}`);
      if (modifiedChanges.length > 0) {
        console.log(`  ${icons.modified} ${chalk.yellow("modified")}   ${modifiedChanges.length}`);
      }
      if (deletedChanges.length > 0) {
        console.log(`  ${chalk.red("-")} ${chalk.red("deleted")}    ${deletedChanges.length}`);
      }
      if (conflictCount > 0) {
        console.log(`  ${icons.conflictDot} ${chalk.magenta("conflict")}   ${conflictCount}`);
      }
      // new 는 아직 추적 레코드가 없는 파일이라 위 총계(Tracked files)에 들어가지 않는다.
      // 같은 블록에 숫자만 늘어놓으면 합이 안 맞아 보이므로 그 사실을 함께 적는다.
      if (createdChanges.length > 0) {
        console.log(
          `  ${icons.newFile} ${chalk.cyan("new")}        ${createdChanges.length} ${dimText("(untracked)")}`,
        );
      }

      // Modified files
      if (modifiedChanges.length > 0) {
        console.log(`\n  ${header("Modified files:")}`);
        for (const c of modifiedChanges.slice(0, 10)) {
          console.log(
            `    ${chalk.yellow("~")} ${c.path.padEnd(30)} ${dimText("(local changed)")}`,
          );
        }
        if (modifiedChanges.length > 10) {
          console.log(dimText(`    ... and ${modifiedChanges.length - 10} more`));
        }
      }

      // New files
      if (createdChanges.length > 0) {
        console.log(`\n  ${header("New files:")}`);
        for (const c of createdChanges.slice(0, 10)) {
          console.log(`    ${chalk.cyan("+")} ${c.path.padEnd(30)} ${dimText("(untracked)")}`);
        }
        if (createdChanges.length > 10) {
          console.log(dimText(`    ... and ${createdChanges.length - 10} more`));
        }
      }

      // Remote changes (Notion-side)
      if (status.remoteChanges.length > 0) {
        console.log(`\n  ${header(`Remote changes (Notion): ${status.remoteChanges.length}`)}`);
        if (remoteCreated.length > 0) {
          console.log(`    ${chalk.cyan("+")} ${chalk.cyan("new")}        ${remoteCreated.length}`);
        }
        if (remoteModified.length > 0) {
          console.log(
            `    ${chalk.yellow("~")} ${chalk.yellow("modified")}   ${remoteModified.length}`,
          );
        }
        if (remoteDeleted.length > 0) {
          console.log(`    ${chalk.red("-")} ${chalk.red("deleted")}    ${remoteDeleted.length}`);
        }
        for (const c of status.remoteChanges.slice(0, 10)) {
          const icon =
            c.type === "created"
              ? chalk.cyan("+")
              : c.type === "modified"
                ? chalk.yellow("~")
                : chalk.red("-");
          console.log(`    ${icon} ${c.pageId.slice(0, 8)}... ${dimText(`(${c.type})`)}`);
        }
        if (status.remoteChanges.length > 10) {
          console.log(dimText(`    ... and ${status.remoteChanges.length - 10} more`));
        }
      }

      // Conflicts
      if (conflictCount > 0) {
        console.log(`\n  ${header(chalk.magenta("Conflicts:"))}`);
        for (const r of status.conflictRecords) {
          console.log(
            `    ${icons.conflict} ${r.obsidianPath.padEnd(30)} ${dimText("(both sides changed)")}`,
          );
        }
      }

      // Helpful commands
      const hasChanges =
        status.localChanges.length > 0 || status.remoteChanges.length > 0 || conflictCount > 0;
      if (hasChanges) {
        console.log("");
        if (conflictCount > 0) {
          console.log(
            `  ${dimText("Run")} ${chalk.cyan("nobsi resolve")} ${dimText("to resolve conflicts")}`,
          );
        }
        console.log(
          `  ${dimText("Run")} ${chalk.cyan("nobsi sync")} ${dimText("to push/pull changes")}`,
        );
      } else {
        console.log(`\n  ${chalk.green("Everything up to date")} ✓`);
      }
      if (!opts.full) {
        console.log(
          `\n  ${dimText("Run")} ${chalk.cyan("nobsi status --full")} ${dimText("to check Notion remote changes")}`,
        );
      }
    } finally {
      stateDb.close();
    }
  });
