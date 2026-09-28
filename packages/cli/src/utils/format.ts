import chalk from "chalk";
import type { ProgressItem } from "@im-nobsidian/core";

export const icons = {
  create: chalk.green("+"),
  update: chalk.yellow("~"),
  delete: chalk.red("-"),
  move: chalk.cyan("→"),
  success: chalk.green("✓"),
  fail: chalk.red("✕"),
  conflict: chalk.magenta("!"),
  synced: chalk.green("●"),
  modified: chalk.yellow("●"),
  newFile: chalk.cyan("●"),
  conflictDot: chalk.magenta("●"),
} as const;

export function header(text: string): string {
  return chalk.bold(text);
}

export function separator(width = 35): string {
  return chalk.dim("━".repeat(width));
}

export function operationIcon(op: ProgressItem["operation"]): string {
  return icons[op];
}

export function operationLabel(op: ProgressItem["operation"]): string {
  switch (op) {
    case "create":
      return chalk.green("created");
    case "update":
      return chalk.yellow("updated");
    case "delete":
      return chalk.red("deleted");
    case "move":
      return chalk.cyan("moved");
  }
}

/** 결과 수 한 줄. `moved` 는 push 만 센다 — 옮긴 노트 · 폴더(본문을 함께 고친 것도). */
export function summary(created: number, updated: number, deleted: number, moved = 0): string {
  const parts: string[] = [];
  if (created > 0) parts.push(chalk.green(`${created} created`));
  if (updated > 0) parts.push(chalk.yellow(`${updated} updated`));
  if (moved > 0) parts.push(chalk.cyan(`${moved} moved`));
  if (deleted > 0) parts.push(chalk.red(`${deleted} deleted`));
  if (parts.length === 0) parts.push(chalk.dim("no changes"));
  return parts.join("  ");
}

/**
 * 완료 헤더 — 실패가 하나라도 있으면 초록 "complete" 로 끝내지 않는다.
 *
 * pull/push/sync 가 모두 결과와 무관하게 초록 `... complete` 를 찍었다. 수십 건이 실패해도
 * 화면 맨 아래는 성공으로 읽혀, 사람은 물론 로그를 훑는 스크립트까지 넘어갔다.
 * 헤더 문구·색을 결과에서 파생시켜 세 명령이 같은 판정을 공유한다.
 */
export function completionHeader(label: string, failedCount: number): string {
  return failedCount > 0
    ? header(chalk.yellow(`${label} finished with errors`))
    : header(chalk.green(`${label} complete`));
}

/** 실패 건수 표기. dim 은 "없는 셈" 으로 읽히므로 0 이 아닐 때만 dim 을 벗는다. */
export function failedCountText(count: number): string {
  return count > 0 ? chalk.red(`${count} failed`) : chalk.dim("0 failed");
}

export function duration(ms: number): string {
  return chalk.dim(`Done in ${(ms / 1000).toFixed(1)}s`);
}

export function progress(current: number, total: number): string {
  return chalk.dim(`[${current}/${total}]`);
}

export function dimText(text: string): string {
  return chalk.dim(text);
}

/**
 * 실패 한 줄. 볼트 최상위의 실패(DB 자동 발견 등)는 빈 경로로 오므로 `/` 로 보인다. `direction` 은
 * sync 가 받기(▼) · 올리기(▲)를 가를 때 쓴다.
 */
export function failedItem(path: string, error: string, direction?: string): void {
  const where = `${direction ? `${direction} ` : ""}${path || "/"}`;
  console.log(`  ${icons.fail} ${where}: ${chalk.red(error)}`);
}
