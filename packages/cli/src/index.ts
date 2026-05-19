import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { pushCommand } from "./commands/push.js";
import { pullCommand } from "./commands/pull.js";
import { syncCommand } from "./commands/sync.js";
import { statusCommand } from "./commands/status.js";
import { diffCommand } from "./commands/diff.js";
import { resolveCommand } from "./commands/resolve.js";
import { watchCommand } from "./commands/watch.js";

const program = new Command();

program
  .name("im-nobsidian")
  .description("Im-Nobsidian: Obsidian ↔ Notion 양방향 동기화 CLI")
  .version("0.1.1")
  .option("--verbose", "상세 로그 출력")
  .option("--quiet", "최소 출력");

program.addCommand(initCommand);
program.addCommand(pushCommand);
program.addCommand(pullCommand);
program.addCommand(syncCommand);
program.addCommand(statusCommand);
program.addCommand(diffCommand);
program.addCommand(resolveCommand);
program.addCommand(watchCommand);

program.parse();
