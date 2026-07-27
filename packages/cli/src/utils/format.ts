import chalk from "chalk";

export const icons = {
  create: chalk.green("+"),
  update: chalk.yellow("~"),
  delete: chalk.red("-"),
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

export function operationIcon(op: "create" | "update" | "delete"): string {
  return icons[op];
}

export function operationLabel(op: "create" | "update" | "delete"): string {
  switch (op) {
    case "create":
      return chalk.green("created");
    case "update":
      return chalk.yellow("updated");
    case "delete":
      return chalk.red("deleted");
  }
}

export function summary(created: number, updated: number, deleted: number): string {
  const parts: string[] = [];
  if (created > 0) parts.push(chalk.green(`${created} created`));
  if (updated > 0) parts.push(chalk.yellow(`${updated} updated`));
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

export function failedItem(path: string, error: string): void {
  console.log(`  ${icons.fail} ${path}: ${chalk.red(error)}`);
}
