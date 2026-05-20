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
