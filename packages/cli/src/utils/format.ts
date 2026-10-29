import chalk from "chalk";
import type {
  FullScanReason,
  ProgressItem,
  ReadOnlySkip,
  RemoteScanInfo,
  SchemaFollowed,
  PropertyRename,
} from "@im-nobsidian/core";

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

/** 로컬 시각 `YYYY-MM-DD HH:MM:SS`. 읽을 수 없는 값은 그대로 보인다 — NaN 으로 바꾸지 않는다. */
export function localDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** 전체 대조한 이유. 코어의 이유 코드가 늘면 여기가 컴파일되지 않는다 — 빠진 말을 조용히 두지 않는다. */
const FULL_SCAN_REASON: Record<FullScanReason, string> = {
  first: "first pull",
  forced: "--force",
  "database-mode": "database mode",
  "every-pull": "every pull",
  due: "scheduled",
};

/**
 * 이번에 원격을 얼마나 훑었나 (ADR-027). 바뀐 것만 찾았으면 Notion 에서 지운 것은 아직 볼트에 반영되지
 * 않았을 수 있다 — 그 사실과 언제 반영되는지를 함께 적는다. 적지 않으면 «Notion 에서 지웠는데 볼트에
 * 남았다» 를 결함으로 읽는다. 원격 삭제를 반영하지 않는 설정(`sync.deleteSync` 꺼짐)이면 적지 않는다.
 */
export function remoteScanLines(scan: RemoteScanInfo): string[] {
  if (scan.kind === "full") {
    return [dimText(scan.reason ? `Full scan (${FULL_SCAN_REASON[scan.reason]})` : "Full scan")];
  }
  const skipped = scan.skippedDatabases ?? 0;
  const skippedText =
    skipped > 0
      ? ` · ${skipped} unchanged ${skipped === 1 ? "database" : "databases"} skipped`
      : "";
  const lines = [dimText(`Changes-only scan${skippedText}`)];
  if (scan.deletionsDeferred) lines.push(remoteDeletionHint(scan));
  return lines;
}

/** 미룬 원격 삭제가 언제 반영되나 — {@link RemoteScanInfo.deletionsDeferred} 일 때 쓴다. */
export function remoteDeletionHint(scan: RemoteScanInfo): string {
  const when = scan.nextFullAt
    ? `the next full scan (${localDateTime(scan.nextFullAt)})`
    : "the next pull (full scan due)";
  return `${dimText(`Deletions in Notion apply at ${when} — or run`)} ${chalk.cyan("nobsi pull --force")}`;
}

/** 마지막 전체 대조 시각 — 한 번도 없으면 never. */
export function lastFullScanText(lastFullScanAt: string | null): string {
  return lastFullScanAt ? localDateTime(lastFullScanAt) : chalk.yellow("never");
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

/** 화면에 늘어놓는 항목(경로 · id) 수 — 넘으면 나머지는 수로 줄인다. */
export const LISTED_ITEMS = 10;

/** 경로 목록 — {@link LISTED_ITEMS} 개까지, 나머지는 수로. */
function pathLines(paths: readonly string[]): string[] {
  const shown = paths.slice(0, LISTED_ITEMS).map((path) => `  ${path}`);
  return paths.length > LISTED_ITEMS
    ? [...shown, dimText(`  … 외 ${paths.length - LISTED_ITEMS}개`)]
    : shown;
}

/**
 * 볼트에서 지웠지만 Notion 에서 지우지 않은 노트(`sync.deleteSync` 꺼짐) — 다음 pull 이 되살린다(D8). 예전에는 말없이
 * 대기로 적기만 해, 지운 파일이 다음 pull 에 돌아왔다.
 */
export function unsentDeletionLines(
  paths: readonly string[] | undefined,
  dryRun = false,
): string[] {
  if (!paths || paths.length === 0) return [];
  return [
    chalk.yellow(
      `⚠ 볼트에서 지운 노트 ${paths.length}개는 Notion 에서 ${dryRun ? "지우지 않습니다" : "지우지 않았습니다"} ` +
        "(sync.deleteSync 꺼짐) — 다음 pull 이 Notion 에서 되살립니다. 지우려면 Notion 에서도 지우거나 deleteSync 를 켜세요:",
    ),
    ...pathLines(paths),
  ];
}

/** pull 이 Notion 에서 되살린(dry-run 은 되살릴) 노트 — 볼트에서 지웠지만 Notion 에 그대로 있던 것(D8). */
export function restoredLines(paths: readonly string[] | undefined, dryRun = false): string[] {
  if (!paths || paths.length === 0) return [];
  return [
    chalk.yellow(
      `⚠ 볼트에서 지운 노트 ${paths.length}개를 Notion 에서 ${dryRun ? "되살립니다" : "되살렸습니다"} ` +
        "— sync.deleteSync 가 꺼져 있어 볼트의 삭제는 Notion 에 보내지 않습니다:",
    ),
    ...pathLines(paths),
  ];
}

/**
 * Notion 에서 이름을 바꾸거나 지운 DB 속성을 행 노트의 키에 옮긴 것(ADR-045) — 노트의 키가 말없이 바뀌지 않게. 지운 속성에
 * 올리지 않은 값이 있어 남긴 키는 경고로 — 그 값을 받을 열이 Notion 에 없다.
 */
export function schemaFollowedLines(followed: readonly SchemaFollowed[] | undefined): string[] {
  const lines: string[] = [];
  for (const db of followed ?? []) {
    const parts = [
      ...(db.renamed.length > 0
        ? [`이름 ${db.renamed.map(([from, to]) => `${from} → ${to}`).join(", ")}`]
        : []),
      ...(db.removed.length > 0 ? [`지움 ${db.removed.join(", ")}`] : []),
    ];
    lines.push(
      `${icons.success} Notion 에서 바뀐 속성을 행 노트 ${db.rows}개에 옮겼습니다 — ${db.folder}: ${parts.join(" · ")}`,
    );
  }
  const kept = (followed ?? []).flatMap((db) => db.kept);
  if (kept.length > 0) {
    lines.push(
      chalk.yellow(
        "⚠ Notion 에서 지운 속성에 올리지 않은 값이 있어 노트에 남겼습니다 — Notion 에는 그 열이 없습니다:",
      ),
      ...pathLines(kept.map(({ path, key }) => `${path} (${key})`)),
    );
  }
  return lines;
}

/**
 * 볼트에서 바꾼 DB 속성 이름을 Notion 의 열 이름으로 바꾼 것(ADR-045) — 행 값은 그대로라 행 수로 세지 않는다. 바꾼 것이
 * 보이지 않으면 Notion 에서 열 이름이 바뀐 까닭을 모른다.
 */
export function renamedPropertyLines(
  renames: readonly PropertyRename[] | undefined,
  dryRun = false,
): string[] {
  return (renames ?? []).map(
    ({ folder, from, to }) =>
      `${icons.success} 볼트에서 바꾼 속성 이름을 Notion 열에 ${dryRun ? "옮깁니다" : "옮겼습니다"} — ${folder}: ${from} → ${to}`,
  );
}

/**
 * 볼트에서 고쳤지만 올리지 않은 읽기 전용 속성 — 다음 pull 이 Notion 값으로 되돌린다. 실패는 아니라 종료 코드는
 * 그대로지만, 고친 값이 사라지기 전에 알아야 한다. 없으면 빈 목록.
 */
export function readOnlySkipLines(
  skips: readonly ReadOnlySkip[] | undefined,
  dryRun = false,
): string[] {
  if (!skips || skips.length === 0) return [];
  const count = skips.reduce((sum, skip) => sum + skip.properties.length, 0);
  return [
    chalk.yellow(
      `⚠ 읽기 전용 속성 ${count}개는 ${dryRun ? "올리지 않습니다" : "올리지 않았습니다"} — Notion 이 값을 정합니다(수식 · 롤업 · ID …). ` +
        "다음 pull 이 Notion 값으로 되돌립니다:",
    ),
    ...skips.map((skip) => `  ${skip.path} — ${skip.properties.join(", ")}`),
  ];
}
