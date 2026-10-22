#!/usr/bin/env node
/**
 * roundtrip 단계가 «이번 실행에서 새로 만든» probe 를 Notion · 상태 DB · 볼트 세 곳에서 치운다.
 *
 * 사용: node cleanup-probe.mjs <볼트 절대경로> <probe 폴더명> <시작 시각 'YYYY-MM-DD HH:MM:SS' UTC>
 * 출력: stdout 에 JSON 한 줄 — { probe, since, created, trashed, failed }
 *
 * 전에는 볼트 쪽만 지우고 "Notion 의 probe 는 수동으로 지우라" 는 안내만 남겼다. 머리말은
 * "자기정리" 라고 했지만 실제로는 실행마다 Notion 에 흔적이 쌓였다.
 *
 * 범위는 «시작 시각 이후 생성된 레코드» 로 한정한다. probe 폴더는 다른 시험도 쓰는
 * 네임스페이스라, 폴더째 치우면 이번 실행이 만들지 않은 페이지까지 휴지통으로 간다.
 * 이미 있던 probe 페이지는 갱신만 됐으므로 그대로 둔다 — 실행이 거듭돼도 쌓이지 않는다.
 *
 * 순서가 중요하다 — Notion 휴지통 이동이 전부 성공했을 때만 상태 레코드와 로컬 파일을
 * 지운다. 하나라도 실패하면 아무것도 지우지 않아 다음 정리가 같은 레코드로 다시 시도한다.
 * 토큰은 출력하지 않는다(호출측이 redact.mjs 로 한 번 더 거른다).
 */
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [vault, probe, since] = process.argv.slice(2);

// probe 는 볼트 직속의 `__이름__` 폴더만 받는다 — 경로 조작으로 다른 폴더를 지우지 못하게.
if (
  !vault ||
  !isAbsolute(vault) ||
  !probe ||
  !/^__[A-Za-z0-9_-]+__$/.test(probe) ||
  !since ||
  !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(since)
) {
  console.error("사용: cleanup-probe.mjs <볼트 절대경로> <__probe__> <'YYYY-MM-DD HH:MM:SS' UTC>");
  process.exit(2);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const coreEntry = join(repoRoot, "packages/core/dist/index.js");
if (!existsSync(coreEntry)) {
  console.error(`core dist 없음 — 먼저 빌드: ${coreEntry}`);
  process.exit(1);
}
const { ConfigManager, StateDB, NotionClient } = await import(pathToFileURL(coreEntry).href);

/** 레코드가 Notion 트리에서 차지하는 자리. 폴더 노트 `a/b/b.md` 는 폴더 `a/b` 다. */
function nodePath(record) {
  const p = record.obsidianPath;
  return record.fileType === "folder-note" ? p.slice(0, p.lastIndexOf("/")) : p;
}

function ancestors(path) {
  const out = [];
  for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/")) {
    path = path.slice(0, i);
    out.push(path);
  }
  return out;
}

const configManager = new ConfigManager(vault);
const config = await configManager.load();
const stateDb = StateDB.open(configManager.dbPath);

const trashed = [];
const failed = [];
let created = [];
try {
  // 상태 DB 의 created_at 은 SQLite datetime('now') — UTC 'YYYY-MM-DD HH:MM:SS' 라 문자열 비교가 곧 시각 비교다.
  created = stateDb
    .getAll()
    .filter((r) => r.obsidianPath === probe || r.obsidianPath.startsWith(`${probe}/`))
    .filter((r) => r.createdAt >= since);

  // 가장 바깥 것만 휴지통으로 — Notion 은 부모를 옮기면 자식도 함께 옮긴다.
  const nodes = new Set(created.map(nodePath));
  const outermost = created.filter(
    (r) => r.notionPageId && !ancestors(nodePath(r)).some((a) => nodes.has(a)),
  );

  const client = NotionClient.fromConfig(config);
  for (const r of outermost) {
    try {
      await client.archivePage(r.notionPageId);
      trashed.push(r.obsidianPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 이미 휴지통이거나 사라진 페이지는 치울 것이 없다 — 실패가 아니다.
      if (/archived|in_trash|object_not_found|Could not find/i.test(message)) {
        trashed.push(r.obsidianPath);
      } else {
        failed.push({ path: r.obsidianPath, error: message });
      }
    }
  }

  if (failed.length === 0) {
    for (const r of created) stateDb.delete(r.id);
  }
} finally {
  stateDb.close();
}

if (failed.length === 0) {
  // 레코드가 가리키던 로컬 파일만 지운다. 폴더 노트였다면(폴더째 새로 만든 경우) 폴더를 지운다.
  for (const r of created) {
    const target = r.fileType === "folder-note" ? nodePath(r) : r.obsidianPath;
    await rm(join(vault, target), { recursive: true, force: true });
  }
}

process.stdout.write(
  `${JSON.stringify({ probe, since, created: created.map((r) => r.obsidianPath), trashed, failed })}\n`,
);
process.exit(failed.length === 0 ? 0 : 1);
