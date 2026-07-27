import { createRequire } from "node:module";
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { pushCommand } from "./commands/push.js";
import { pullCommand } from "./commands/pull.js";
import { syncCommand } from "./commands/sync.js";
import { statusCommand } from "./commands/status.js";
import { diffCommand } from "./commands/diff.js";
import { fetchCommand } from "./commands/fetch.js";
import { resolveCommand } from "./commands/resolve.js";
import { watchCommand } from "./commands/watch.js";
import { verifyCommand } from "./commands/verify.js";
import { scheduleForcedExit } from "./utils/exit.js";

const requireJson = createRequire(import.meta.url);
const { version } = requireJson("../package.json") as { version: string };

const program = new Command();

program
  .name("im-nobsidian")
  .description("Im-Nobsidian: Obsidian ↔ Notion 양방향 동기화 CLI")
  .version(version)
  .option("--verbose", "상세 로그 출력")
  .option("--quiet", "최소 출력");

program.addCommand(initCommand);
program.addCommand(pushCommand);
program.addCommand(pullCommand);
program.addCommand(syncCommand);
program.addCommand(statusCommand);
program.addCommand(diffCommand);
program.addCommand(fetchCommand);
program.addCommand(resolveCommand);
program.addCommand(watchCommand);
program.addCommand(verifyCommand);

// 강제 종료하되 명령이 정한 종료 코드를 보존한다 — 근거는 utils/exit.ts 참조(R11-C).
program.parseAsync().then(() => {
  scheduleForcedExit(process);
});
