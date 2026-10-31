import { createRequire } from "node:module";
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { pushCommand } from "./commands/push.js";
import { pullCommand } from "./commands/pull.js";
import { syncCommand } from "./commands/sync.js";
import { statusCommand } from "./commands/status.js";
import { diffCommand } from "./commands/diff.js";
import { discardCommand } from "./commands/discard.js";
import { fetchCommand } from "./commands/fetch.js";
import { resolveCommand } from "./commands/resolve.js";
import { watchCommand } from "./commands/watch.js";
import { verifyCommand } from "./commands/verify.js";
import { prepareDbCommand } from "./commands/prepare-db.js";
import { scheduleForcedExit } from "./utils/exit.js";
import { reportUserFailure } from "./utils/state-db-failure.js";
import { applyLogLevel, logLevelOf } from "./utils/log-level.js";

const requireJson = createRequire(import.meta.url);
const { version } = requireJson("../package.json") as { version: string };

const program = new Command();

program
  .name("im-nobsidian")
  .description("Im-Nobsidian: Obsidian ↔ Notion 양방향 동기화 CLI")
  .version(version)
  .option("--verbose", "엔진의 정보 · 디버그 로그도 출력")
  .option("--quiet", "경고 로그를 숨기고 오류 로그만 출력")
  .hook("preAction", () => applyLogLevel(logLevelOf(program.opts())));

program.addCommand(initCommand);
program.addCommand(pushCommand);
program.addCommand(pullCommand);
program.addCommand(syncCommand);
program.addCommand(statusCommand);
program.addCommand(diffCommand);
program.addCommand(discardCommand);
program.addCommand(fetchCommand);
program.addCommand(resolveCommand);
program.addCommand(watchCommand);
program.addCommand(verifyCommand);
program.addCommand(prepareDbCommand);

// 강제 종료하되 명령이 정한 종료 코드를 보존한다 — 근거는 utils/exit.ts 참조(R11-C).
// 상태 DB 를 쓸 수 없어 명령이 던졌으면 이유와 할 일을 보이고 1 로 끝낸다 — utils/state-db-failure.ts.
program.parseAsync().then(
  () => {
    scheduleForcedExit(process);
  },
  (error: unknown) => {
    reportUserFailure(error, process);
    scheduleForcedExit(process);
  },
);
