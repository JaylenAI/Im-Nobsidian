import { Command } from "commander";
import {
  ConfigManager,
  StateDB,
  NotionClient,
  SyncOrchestrator,
  NodeVaultFS,
  isRemoteDeletion,
} from "@im-nobsidian/core";
import chalk from "chalk";
import {
  header,
  separator,
  icons,
  dimText,
  localDateTime,
  lastFullScanText,
  remoteDeletionHint,
} from "../utils/format.js";

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
        console.log(`  ${dimText("Last sync:")}  ${localDateTime(status.lastSyncAt)}`);
      } else {
        console.log(`  ${dimText("Last sync:")}  ${chalk.yellow("never")}`);
      }
      // Notion 에서 지운 노트는 전체 대조 때 볼트에 반영된다 — 그때를 함께 보인다.
      console.log(`  ${dimText("Full scan:")}  ${lastFullScanText(status.lastFullScanAt)}`);

      // Tracked files summary
      const allRecords = stateDb.getAll();
      const total = allRecords.length;
      const conflictCount = status.conflictRecords.length;
      const createdChanges = status.localChanges.filter((c) => c.type === "created");
      const modifiedChanges = status.localChanges.filter((c) => c.type === "modified");
      const deletedChanges = status.localChanges.filter((c) => c.type === "deleted");
      const movedChanges = status.localChanges.filter((c) => c.type === "moved");

      // 추적 파일 내역은 서로 겹치지 않아야 한다. DB 의 status 는 push/pull 시점에만 갱신되므로
      // 방금 고친 파일도 레코드상으론 여전히 'synced' 다 — 그대로 세면 같은 파일이 synced 와
      // modified 양쪽에 잡혀 내역 합이 총계를 넘는 표가 나온다(무엇이 밀렸는지 못 읽는다).
      // 실제 변경이 걸린 경로를 먼저 덜어 내고 남은 것만 synced 로 센다.
      // 옮긴 노트의 레코드는 아직 옛 경로(movedFrom)를 적고 있다 — 두 경로를 다 덜어 낸다.
      const dirtyPaths = new Set([
        ...modifiedChanges.map((c) => c.path),
        ...deletedChanges.map((c) => c.path),
        ...movedChanges.flatMap((c) => [c.path, c.movedFrom ?? c.path]),
        ...status.conflictRecords.map((r) => r.obsidianPath),
      ]);
      const synced = allRecords.filter(
        (r) => r.status === "synced" && !dirtyPaths.has(r.obsidianPath),
      ).length;
      const remoteCreated = status.remoteChanges.filter((c) => c.type === "created");
      const remoteModified = status.remoteChanges.filter((c) => c.type === "modified");
      const remoteDeleted = status.remoteChanges.filter((c) => c.type === "deleted");
      const remoteMoved = status.remoteChanges.filter((c) => c.type === "moved");
      const { folderMoves } = status;

      console.log(`\n  ${header(`Tracked files: ${total}`)}`);
      console.log(`  ${icons.synced} ${chalk.green("synced")}     ${synced}`);
      if (modifiedChanges.length > 0) {
        console.log(`  ${icons.modified} ${chalk.yellow("modified")}   ${modifiedChanges.length}`);
      }
      if (movedChanges.length > 0) {
        console.log(`  ${icons.move} ${chalk.cyan("moved")}      ${movedChanges.length}`);
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

      // Moved — 폴더를 먼저 보인다. 그 안의 노트는 아래에 노트마다 따로 있다.
      if (folderMoves.length + movedChanges.length > 0) {
        console.log(`\n  ${header("Moved:")}`);
        for (const move of folderMoves) {
          console.log(`    ${icons.move} ${move.from}/ → ${move.to}/ ${dimText("(folder)")}`);
        }
        for (const c of movedChanges.slice(0, 10)) {
          console.log(`    ${icons.move} ${c.movedFrom ?? "?"} → ${c.path}`);
        }
        if (movedChanges.length > 10) {
          console.log(dimText(`    ... and ${movedChanges.length - 10} more`));
        }
      }

      // Deleted files — 수만 보이면 무엇이 Notion 에서 지워질지 모른다.
      if (deletedChanges.length > 0) {
        console.log(`\n  ${header("Deleted files:")}`);
        for (const c of deletedChanges.slice(0, 10)) {
          console.log(`    ${chalk.red("-")} ${c.path}`);
        }
        if (deletedChanges.length > 10) {
          console.log(dimText(`    ... and ${deletedChanges.length - 10} more`));
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
        if (remoteMoved.length > 0) {
          console.log(`    ${icons.move} ${chalk.cyan("moved")}      ${remoteMoved.length}`);
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
                : c.type === "moved"
                  ? icons.move
                  : chalk.red("-");
          // 볼트에 있는 노트는 경로, 아직 없는 새 페이지는 Notion 제목 — 내부 id 는 둘 다 없을 때만.
          const name = c.path ?? (c.title ? `${c.title} ${dimText("(new page)")}` : undefined);
          console.log(
            `    ${icon} ${name ?? `${c.pageId.slice(0, 8)}...`} ${dimText(`(${c.type})`)}`,
          );
        }
        if (status.remoteChanges.length > 10) {
          console.log(dimText(`    ... and ${status.remoteChanges.length - 10} more`));
        }
      }

      // Conflicts
      if (conflictCount > 0) {
        console.log(`\n  ${header(chalk.magenta("Conflicts:"))}`);
        // 원격을 읽은 상태(--full)만 Notion 에서 지운 노트를 가른다.
        const remoteDeleted = new Set(
          status.conflicts.filter(isRemoteDeletion).map((c) => c.syncRecord.obsidianPath),
        );
        for (const r of status.conflictRecords) {
          const reason = remoteDeleted.has(r.obsidianPath)
            ? "(deleted in Notion, local edits not pushed)"
            : "(both sides changed)";
          console.log(`    ${icons.conflict} ${r.obsidianPath.padEnd(30)} ${dimText(reason)}`);
        }
      }

      // Helpful commands
      const hasChanges =
        status.localChanges.length > 0 ||
        folderMoves.length > 0 ||
        status.remoteChanges.length > 0 ||
        conflictCount > 0;
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
        // 되돌릴 수 있는 것(고친 · 지운 노트)이 있을 때만 — git status 의 `git restore` 안내와 같다.
        if (modifiedChanges.length + deletedChanges.length > 0) {
          console.log(
            `  ${dimText("Run")} ${chalk.cyan("nobsi discard <path>")} ${dimText("to discard local edits")}`,
          );
        }
      } else {
        console.log(`\n  ${chalk.green("Everything up to date")} ✓`);
      }
      if (!opts.full) {
        console.log(
          `\n  ${dimText("Run")} ${chalk.cyan("nobsi status --full")} ${dimText("to check Notion remote changes")}`,
        );
      } else if (status.remoteScan?.deletionsDeferred) {
        // 바뀐 것만 찾았다 — 위 원격 변경에는 Notion 에서 지운 것이 아직 없다.
        console.log(`\n  ${remoteDeletionHint(status.remoteScan)}`);
      }
    } finally {
      stateDb.close();
    }
  });
