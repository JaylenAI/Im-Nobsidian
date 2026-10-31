import { confirm } from "@inquirer/prompts";
import type { SyncOrchestrator } from "@im-nobsidian/core";
import { dimText, icons } from "./format.js";
import { isInteractive } from "./interactive.js";

/**
 * 동기화가 옮긴 폴더를 가리키는 직접 만든 `.base` 의 폴더 필터를 고칠지 묻는다. 동기화가 만든 `.base` 는 말없이 고치지만
 * 직접 만든 것은 무엇을 보려고 만든 필터인지 모른다. 예전에는 묻지도 알리지도 않고 두어 그 보기가 빈 표가 됐다.
 *
 * `--yes` 면 묻지 않고 고친다. 물을 수 없는 곳(파이프 · CI)이면 알리기만 하고 다음에 다시 묻는다.
 */
export async function askUserBaseFilterFixes(
  orchestrator: Pick<SyncOrchestrator, "userBaseFilterFixes" | "resolveUserBaseFilterFixes">,
  options: { yes?: boolean; dryRun?: boolean },
): Promise<void> {
  if (options.dryRun) return;
  const fixes = orchestrator.userBaseFilterFixes();
  if (fixes.length === 0) return;
  console.log(`\n  ${icons.conflict} 직접 만든 .base 의 폴더 필터가 옮긴 폴더를 가리킵니다:`);
  for (const fix of fixes) console.log(`    ${dimText(`· ${fix.path}: ${fix.from} → ${fix.to}`)}`);
  let accept: boolean;
  if (options.yes) {
    accept = true;
  } else if (!isInteractive()) {
    console.log(
      `  ${dimText("고치려면 --yes 를 붙여 다시 실행하세요 — 다음 실행에서 다시 묻습니다")}`,
    );
    return;
  } else {
    accept = await confirm({ message: "새 폴더로 고칠까요?", default: true });
  }
  const fixed = await orchestrator.resolveUserBaseFilterFixes(accept);
  console.log(
    accept
      ? `  ${icons.success} .base ${fixed.length}개의 폴더 필터를 고쳤습니다`
      : `  ${dimText("그대로 둡니다 — 다시 묻지 않습니다")}`,
  );
}
