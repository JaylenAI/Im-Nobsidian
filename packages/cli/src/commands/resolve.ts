import { Command } from "commander";
import { select, confirm } from "@inquirer/prompts";
import {
  ConfigManager,
  StateDB,
  NotionClient,
  SyncOrchestrator,
  NodeVaultFS,
} from "@im-nobsidian/core";
import type { Conflict, ResolutionChoice } from "@im-nobsidian/core";

/** 허용 전략 — 오타를 조용히 흘리지 않도록 실행 전에 한 번 검증한다. */
const STRATEGIES = ["local-first", "remote-first", "duplicate"] as const;
type Strategy = (typeof STRATEGIES)[number];

/**
 * 대화형 프롬프트를 띄울 수 있는 환경인지.
 *
 * 파이프·cron·CI 처럼 TTY 가 없는 곳에서 @inquirer 프롬프트를 띄우면 원인을 알 수 없는
 * 오류로 죽거나 입력을 기다리며 멎는다. 먼저 판정해 무엇을 어떻게 하라고 말해 준다.
 */
function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export const resolveCommand = new Command("resolve")
  .description("충돌을 해결합니다")
  .option("-s, --strategy <strategy>", `자동 해결 전략 (${STRATEGIES.join(" | ")})`)
  .option("-y, --yes", "확인 프롬프트 없이 진행 (비대화형/CI)")
  .action(async (options: { strategy?: string; yes?: boolean }) => {
    if (options.strategy && !STRATEGIES.includes(options.strategy as Strategy)) {
      console.error(`알 수 없는 전략 '${options.strategy}' — 사용 가능: ${STRATEGIES.join(", ")}`);
      process.exitCode = 1;
      return;
    }

    const cwd = process.cwd();
    const configManager = new ConfigManager(cwd);
    let stateDb: StateDB | undefined;

    try {
      const config = await configManager.load();
      stateDb = StateDB.open(configManager.dbPath);
      const client = NotionClient.fromConfig(config);
      const vaultFs = new NodeVaultFS(cwd, config.paths);
      const orchestrator = new SyncOrchestrator(config, stateDb, client, vaultFs);

      // 충돌 목록은 **충돌로 표시된 페이지만** 읽어 온다. 예전엔 목록을 얻겠다고 전체 pull 을
      // 돌렸는데, 그건 해소하기도 전에 볼트를 원격으로 덮어쓰는 짓이라 순서가 거꾸로였다.
      const conflicts = await orchestrator.listConflicts();

      if (conflicts.length === 0) {
        console.log("충돌이 없습니다.");
        return;
      }

      // 양쪽이 이미 같아진 항목은 물어볼 게 없다. 그대로 두면 push 가 그 파일을 영영
      // 건너뛰어(충돌 상태는 push 제외) 이후 편집이 조용히 정체하므로 먼저 걷어낸다.
      const cleared = new Set(orchestrator.clearStaleConflicts(conflicts));
      for (const path of cleared) {
        console.log(`  \x1b[32m✓\x1b[0m ${path} → 양쪽 동일, 충돌 표시만 해제`);
      }

      const pending = conflicts.filter((c) => !cleared.has(c.syncRecord.obsidianPath));
      if (pending.length === 0) {
        console.log(`\n${cleared.size}건 모두 이미 해소된 상태였습니다 — 상태만 정리했습니다.`);
        return;
      }

      console.log(`\n충돌 ${pending.length}건 발견\n`);

      if (options.strategy) {
        const strategy = options.strategy as Strategy;

        if (!options.yes) {
          if (!isInteractive()) {
            console.error(
              `비대화형 환경입니다 — '${strategy}' 전략으로 ${pending.length}건을 일괄 해결하려면 --yes 를 함께 지정하세요.`,
            );
            process.exitCode = 1;
            return;
          }
          const shouldProceed = await confirm({
            message: `${pending.length}건의 충돌을 '${strategy}' 전략으로 일괄 해결할까요?`,
          });
          if (!shouldProceed) return;
        }

        const results = await orchestrator.resolveAllConflicts(pending, strategy);
        let failed = 0;
        for (const result of results) {
          if (!result.success) failed++;
          const icon = result.success ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
          console.log(`  ${icon} ${result.path} → ${result.choice}`);
        }
        report(results.length - failed, failed);
        return;
      }

      if (!isInteractive()) {
        console.error(
          "비대화형 환경에서는 대화형 해결을 쓸 수 없습니다 — --strategy <local-first|remote-first|duplicate> --yes 를 지정하세요.",
        );
        process.exitCode = 1;
        return;
      }

      let resolved = 0;
      let failed = 0;
      for (const conflict of pending) {
        if (await resolveInteractive(conflict, orchestrator)) resolved++;
        else failed++;
      }
      report(resolved, failed);
    } catch (error) {
      console.error("오류:", error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } finally {
      // 예전엔 분기마다 close 를 흩뿌려 두고 catch 경로에선 아예 닫지 않았다 — 잠금이 남는다.
      stateDb?.close();
    }
  });

/** 결과를 사실대로 알린다 — 실패가 하나라도 있으면 "완료"라고 말하지 않는다. */
function report(resolved: number, failed: number): void {
  if (failed === 0) {
    console.log(`\n충돌 해결 완료 — ${resolved}건`);
    return;
  }
  console.log(`\n\x1b[33m충돌 ${resolved}건 해결 · ${failed}건 미해결\x1b[0m`);
  process.exitCode = 1;
}

/** @returns 해소에 성공했으면 true. 병합 마커가 남은 경우는 미해결로 센다. */
async function resolveInteractive(
  conflict: Conflict,
  orchestrator: SyncOrchestrator,
): Promise<boolean> {
  const path = conflict.syncRecord.obsidianPath;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`파일: \x1b[1m${path}\x1b[0m`);
  console.log(`${"─".repeat(60)}`);

  const diff = orchestrator.generateConflictDiff(conflict);
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

  const result = await orchestrator.resolveConflict(conflict, choice);

  if (result.success) {
    console.log(`\x1b[32m✓ ${path} → ${choice}로 해결\x1b[0m`);
    return true;
  }
  if (result.mergeHadConflicts) {
    console.log(`\x1b[33m⚠ ${path} → 자동 병합 완료 (수동 확인 필요한 충돌 마커 있음)\x1b[0m`);
    return false;
  }
  console.log(`\x1b[31m✗ ${path} → 해결 실패\x1b[0m`);
  return false;
}
