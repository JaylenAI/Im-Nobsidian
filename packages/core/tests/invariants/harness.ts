/**
 * Invariant(불변식) 안전망 공용 하네스.
 *
 * 실제 Notion 워크스페이스의 ROOT 아래에 테스트 전용 격리 서브트리
 * (`[INVARIANT] ...`)를 만들어 그 안에서만 동기화를 수행한다. 실제 노트
 * 코퍼스는 절대 건드리지 않으며, 생성한 페이지는 afterAll 에서 archive 한다.
 *
 * 모든 단언은 카운트/구조 기반(`.toContain` 금지) — 데이터 누락/드리프트/
 * resurrection 을 수치로 검증한다.
 */
import { Client } from "@notionhq/client";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";

import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { NotionClient } from "../../src/notion/client.js";
import { NodeVaultFS } from "../../src/sync/node-vault-fs.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { Config } from "../../src/types/config.js";

export const TOKEN = process.env["NOTION_TOKEN"] ?? "";
export const ROOT_PAGE_ID = process.env["NOTION_ROOT_PAGE_ID"] ?? "";
export const SKIP = !TOKEN || !ROOT_PAGE_ID;

export const INTERNAL_DIR = ".im-nobsidian";

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 원시 @notionhq Client — 페이지 생성/조회/archive 검증용. */
export function rawNotion(): Client {
  return new Client({ auth: TOKEN });
}

/**
 * ROOT 아래에 테스트 전용 격리 루트 페이지를 만든다.
 * 반환된 id 를 orchestrator 의 rootPageId 로 사용하면 pull 이 이 서브트리만 본다.
 */
export async function createIsolatedRoot(raw: Client, label: string): Promise<string> {
  const suffix = `${Date.now().toString(36)}`;
  const page = (await raw.pages.create({
    parent: { page_id: ROOT_PAGE_ID },
    properties: {
      title: { title: [{ text: { content: `[INVARIANT] ${label} ${suffix}` } }] },
    },
  })) as PageObjectResponse;
  return page.id;
}

/** 임시 볼트 디렉터리 생성 + 내부 폴더 보장. */
export async function createTmpVault(prefix = "im-nobsi-inv-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await new NodeVaultFS(dir).ensureFolder(INTERNAL_DIR);
  return dir;
}

export interface OrchestratorBundle {
  orchestrator: SyncOrchestrator;
  stateDb: StateDB;
  vaultFs: NodeVaultFS;
}

/** 격리 루트를 rootPageId 로 하는 orchestrator 번들을 만든다. */
export function makeOrchestrator(
  tmpDir: string,
  rootPageId: string,
  syncOverrides: Partial<Config["sync"]> = {},
): OrchestratorBundle {
  const dbPath = join(tmpDir, INTERNAL_DIR, "sync.db");
  const vaultFs = new NodeVaultFS(tmpDir);
  const stateDb = StateDB.open(dbPath);
  const notionClient = new NotionClient({ token: TOKEN });

  const config: Config = {
    ...DEFAULT_CONFIG,
    notion: { ...DEFAULT_CONFIG.notion, rootPageId, token: TOKEN },
    sync: { ...DEFAULT_CONFIG.sync, ...syncOverrides },
  };

  const orchestrator = new SyncOrchestrator(config, stateDb, notionClient, vaultFs);
  return { orchestrator, stateDb, vaultFs };
}

/**
 * 볼트의 모든 .md 파일을 상대경로→내용 Map 으로 스냅샷한다.
 * 내부 폴더(.im-nobsidian)는 제외. 드리프트 deep-equal 비교용.
 */
export async function snapshotVault(tmpDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const entries = await readdir(tmpDir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    const parentPath =
      (entry as unknown as { parentPath?: string; path?: string }).parentPath ??
      (entry as unknown as { path?: string }).path ??
      tmpDir;
    const abs = join(parentPath, entry.name);
    const rel = relative(tmpDir, abs).split(sep).join("/");
    if (rel.startsWith(`${INTERNAL_DIR}/`)) continue;
    out.set(rel, await readFile(abs, "utf-8"));
  }
  return out;
}

/** 두 볼트 스냅샷의 차이를 구한다 (드리프트 측정). */
export interface SnapshotDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export function diffSnapshots(
  before: Map<string, string>,
  after: Map<string, string>,
): SnapshotDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [path, content] of after) {
    if (!before.has(path)) added.push(path);
    else if (before.get(path) !== content) changed.push(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) removed.push(path);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

/** 생성한 페이지들을 archive (정리). 실패는 무시. */
export async function archivePages(raw: Client, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    try {
      await raw.pages.update({ page_id: id, archived: true });
    } catch {
      /* 이미 archive 되었거나 접근 불가 — 무시 */
    }
  }
}

/** 페이지가 archive(휴지통) 상태인지 확인. */
export async function isArchived(raw: Client, pageId: string): Promise<boolean> {
  const page = (await raw.pages.retrieve({ page_id: pageId })) as PageObjectResponse & {
    archived?: boolean;
    in_trash?: boolean;
  };
  return page.archived === true || page.in_trash === true;
}

/** 볼트 정리 + stateDb close. */
export async function cleanupVault(tmpDir: string, stateDb?: StateDB): Promise<void> {
  try {
    stateDb?.close();
  } catch {
    /* 무시 */
  }
  await rm(tmpDir, { recursive: true, force: true });
}
