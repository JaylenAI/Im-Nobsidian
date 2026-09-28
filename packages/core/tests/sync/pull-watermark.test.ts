/**
 * 증분 pull 의 기준 시각(`last_pull_at`) — 받지 못한 원격 변경이 다음 조회 창 밖으로 밀리지 않는다.
 *
 * 증분 감지는 「기준 시각 − 안전창(15분)」 이후에 고친 페이지만 search 로 받는다. 예전에는
 * pull 이 «끝난» 시각을 기준으로 적어, 이번 실행이 받지 못한 변경 — 재시도까지 실패 · 중단으로
 * 건너뜀 · 경로를 좁힌 pull 의 범위 밖 — 과 긴 pull 도중의 편집이 다음 창 밖으로 밀려 원격에서
 * 다시 고치기 전까지 영영 빠졌다. status 는 push 도 올리는 `last_sync_at` 을 기준으로 써서
 * pull 이 받을 변경을 「없음」 이라고 보고할 수 있었다.
 *
 * 원격은 조회 시각을 지키는 가짜 search 로 흉내 낸다 — 창 밖의 페이지는 돌려주지 않는다.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";

import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { NotionClient } from "../../src/notion/client.js";
import { NodeVaultFS } from "../../src/sync/node-vault-fs.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { Config } from "../../src/types/config.js";
import type { PullOptions, RemoteChange } from "../../src/types/sync.js";
import { incrementalSearchSince, nextPullWatermark } from "../../src/sync/pull-watermark.js";
import { MOCK_BOT_USER_ID } from "../helpers/mock-orchestrator.js";

const ROOT = "11111111111111111111111111111111";
const OLD = "22222222222222222222222222222222";
const NEW = "33333333333333333333333333333333";
const OTHER = "44444444444444444444444444444444";

const T0 = Date.parse("2026-09-27T09:00:00.000Z");
/** T0 에서 `min` 분 뒤의 ISO 시각. */
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function page(id: string, title: string, editedMin: number): PageObjectResponse {
  return {
    object: "page",
    id,
    last_edited_time: at(editedMin),
    created_time: at(editedMin),
    archived: false,
    in_trash: false,
    parent: { type: "page_id", page_id: ROOT },
    properties: { title: { type: "title", title: [{ plain_text: title }] } },
  } as unknown as PageObjectResponse;
}

describe("증분 pull 기준 시각 — 받지 못한 변경이 다음 조회에 남는다", () => {
  let tmpDir: string | null = null;
  let stateDb: StateDB | null = null;
  /** 원격 페이지 — 시험이 도중에 만들고 고친다. */
  const remote = new Map<string, PageObjectResponse>();
  /** 본문 읽기가 실패하는 페이지(재시도까지). */
  const failing = new Set<string>();
  let onMarkdown: ((id: string) => void) | null = null;
  let searchSince: string[] = [];

  afterEach(async () => {
    stateDb?.close();
    stateDb = null;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
    remote.clear();
    failing.clear();
    onMarkdown = null;
    searchSince = [];
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const now = (min: number) => vi.setSystemTime(new Date(T0 + min * 60_000));
  const pathOf = (id: string) => stateDb!.getByNotionId(id)?.obsidianPath;

  function offlineClient(): NotionClient {
    const client = new NotionClient({ token: "offline-test" });
    // 봇 id 는 원격 판정에 쓴다(N-05) — 오프라인 시험이 users.me 로 나가지 않게.
    vi.spyOn(client, "getBotUserId").mockResolvedValue(MOCK_BOT_USER_ID);
    vi.spyOn(client, "getChildPagesRecursive").mockImplementation(async () => [...remote.values()]);
    // 스키마를 고친 DB 도 search 로 찾는다(ADR-027) — 오프라인 시험이 실제 search 로 나가지 않게.
    vi.spyOn(client, "searchRecentDataSources").mockResolvedValue([]);
    vi.spyOn(client, "searchRecentPages").mockImplementation(async (since: string) => {
      searchSince.push(since);
      return [...remote.values()]
        .filter((p) => Date.parse(p.last_edited_time) > Date.parse(since))
        .sort((a, b) => b.last_edited_time.localeCompare(a.last_edited_time))
        .map((p) => ({ id: p.id, last_edited_time: p.last_edited_time }));
    });
    vi.spyOn(client, "getPage").mockImplementation(async (id: string) => {
      const found = remote.get(id.replace(/-/g, ""));
      if (!found) throw new Error(`unexpected getPage ${id}`);
      return found;
    });
    vi.spyOn(client, "getPageMarkdown").mockImplementation(async (id: string) => {
      const key = id.replace(/-/g, "");
      onMarkdown?.(key);
      if (failing.has(key)) throw new Error("일시 장애");
      return { markdown: `본문 ${key} ${remote.get(key)?.last_edited_time}\n` } as never;
    });
    vi.spyOn(client, "fetchAllChildrenDeep").mockResolvedValue([]);
    vi.spyOn(client, "getChildDatabaseIds").mockResolvedValue([]);
    // Markdown API 가 실패하면 블록 API 로 다시 받는다 — notion-to-md 가 SDK 로 직접 부르는 길이다.
    // 재시도까지 실패한 페이지는 그 길도 실패한다(막지 않으면 실제 HTTPS 로 나갔다 — T-01).
    vi.spyOn((client as any).client.blocks.children, "list").mockRejectedValue(
      new Error("일시 장애"),
    );
    return client;
  }

  async function pull(options?: PullOptions) {
    const config: Config = {
      ...DEFAULT_CONFIG,
      notion: { ...DEFAULT_CONFIG.notion, rootPageId: ROOT, token: "offline-test" },
      advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0, concurrency: 1 },
    };
    const orchestrator = new SyncOrchestrator(
      config,
      stateDb!,
      offlineClient(),
      new NodeVaultFS(tmpDir!),
    );
    return orchestrator.pull(options);
  }

  function orchestrator() {
    const config: Config = {
      ...DEFAULT_CONFIG,
      notion: { ...DEFAULT_CONFIG.notion, rootPageId: ROOT, token: "offline-test" },
    };
    return new SyncOrchestrator(config, stateDb!, offlineClient(), new NodeVaultFS(tmpDir!));
  }

  async function emptyVault() {
    vi.useFakeTimers({ toFake: ["Date"] });
    tmpDir = await mkdtemp(join(tmpdir(), "im-watermark-"));
    await new NodeVaultFS(tmpDir).ensureFolder(".im-nobsidian");
    stateDb = StateDB.open(join(tmpDir, ".im-nobsidian", "sync.db"));
  }

  /** 0분에 전체 스캔으로 예전 노트만 받은 볼트. 이후 pull 은 증분 경로를 탄다. */
  async function pulledVault() {
    await emptyVault();
    remote.set(OLD, page(OLD, "예전 노트", -30));
    now(0);
    expect((await pull()).created).toBe(1);
  }

  it("재시도까지 실패한 새 페이지 — 조회 창이 지나가도 다음 pull 이 받는다", async () => {
    await pulledVault();
    remote.set(NEW, page(NEW, "새 노트", 5));
    failing.add(NEW);

    now(30);
    const second = await pull();
    expect(second.failed.map((f) => f.operation)).toEqual(["create"]);

    failing.delete(NEW);
    now(40); // 30분에 끝난 pull 의 창(15분~)은 5분에 고친 새 노트를 이미 지났다
    const third = await pull();

    expect(third.failed).toEqual([]);
    expect(third.created).toBe(1);
    expect(pathOf(NEW)).toBe("새 노트.md");
  });

  it("재시도까지 실패한 수정 — 다음 pull 이 다시 받는다", async () => {
    await pulledVault();
    remote.set(OLD, page(OLD, "예전 노트", 5));
    failing.add(OLD);

    now(30);
    expect((await pull()).failed.map((f) => f.operation)).toEqual(["update"]);

    failing.delete(OLD);
    now(40);
    const third = await pull();

    expect(third.updated).toBe(1);
    expect(stateDb!.getByNotionId(OLD)?.notionLastEdited).toBe(at(5));
  });

  it("중단된 pull 이 건너뛴 페이지 — 다음 pull 이 받는다", async () => {
    await pulledVault();
    remote.set(NEW, page(NEW, "새 노트", 5));
    remote.set(OTHER, page(OTHER, "딴 노트", 6));

    now(30);
    const controller = new AbortController();
    const second = await pull({ signal: controller.signal, onProgress: () => controller.abort() });
    expect(second.created).toBe(1);

    now(40);
    const third = await pull();

    expect(third.created).toBe(1);
    expect(pathOf(NEW)).toBe("새 노트.md");
    expect(pathOf(OTHER)).toBe("딴 노트.md");
  });

  it("경로를 좁힌 pull 은 기준 시각을 옮기지 않는다 — 범위 밖 변경이 다음 pull 에 남는다", async () => {
    await pulledVault();
    remote.set(NEW, page(NEW, "새 노트", 5));

    now(30);
    expect((await pull({ paths: ["다른 폴더"] })).created).toBe(0);

    now(40);
    const third = await pull();

    expect(third.created).toBe(1);
    expect(pathOf(NEW)).toBe("새 노트.md");
  });

  it("기준 시각은 pull 을 시작한 때 — 긴 pull 도중에 고친 페이지를 놓치지 않는다", async () => {
    await pulledVault();
    remote.set(NEW, page(NEW, "새 노트", 29));
    // 새 노트를 받는 동안 30분이 흐르고, 그사이(40분) 원격에서 예전 노트를 고친다.
    onMarkdown = (id) => {
      if (id !== NEW) return;
      remote.set(OLD, page(OLD, "예전 노트", 40));
      now(60);
    };

    now(30);
    expect((await pull()).created).toBe(1);

    onMarkdown = null;
    now(70);
    const third = await pull();

    expect(third.updated).toBe(1);
    expect(stateDb!.getByNotionId(OLD)?.notionLastEdited).toBe(at(40));
  });

  it("status 는 pull 과 같은 기준 시각으로 원격 변경을 본다 — push 가 올린 시각이 아니라", async () => {
    await pulledVault();
    remote.set(NEW, page(NEW, "새 노트", 10));
    stateDb!.setMeta("last_sync_at", at(30)); // 30분에 push 만 했다

    now(40);
    const status = await orchestrator().status();

    expect(status.remoteChanges.map((c) => [c.pageId, c.type])).toEqual([[NEW, "created"]]);
    expect(status.lastSyncAt).toBe(at(30));
    expect((await pull()).created).toBe(1);
  });

  it("push 만 한 볼트의 첫 pull 은 전체 대조한다 — 그 전에 원격에 있던 페이지도 받는다", async () => {
    await emptyVault();
    remote.set(OLD, page(OLD, "예전 노트", -30));
    remote.set(NEW, page(NEW, "원격에만 있던 노트", -60));
    stateDb!.upsert({
      obsidianPath: "예전 노트.md",
      notionPageId: OLD,
      contentHash: "pushed",
      notionLastEdited: at(-30),
      localLastModified: at(-30),
      syncDirection: "push",
      fileType: "file",
      status: "synced",
    });
    stateDb!.setMeta("last_sync_at", at(30));

    now(40);
    const result = await pull();

    expect(pathOf(NEW)).toBe("원격에만 있던 노트.md");
    expect(result.created).toBe(1);
    expect(searchSince).toEqual([]);
  });

  it("받지 못한 변경이 없으면 기준 시각은 pull 을 시작한 때로 나아간다", async () => {
    await pulledVault();
    remote.set(NEW, page(NEW, "새 노트", 5));

    now(30);
    await pull();
    now(40);
    await pull();

    expect(searchSince.at(-1)).toBe(at(30 - 15));
  });
});

describe("nextPullWatermark · incrementalSearchSince", () => {
  const change = (type: RemoteChange["type"], lastEdited: string): RemoteChange => ({
    pageId: NEW,
    type,
    lastEdited,
    previousEdited: null,
  });

  it("받지 못한 변경 중 가장 이른 수정 시각 — 시작 시각보다 늦은 것 · 삭제 · 읽을 수 없는 값은 보지 않는다", () => {
    const unapplied = [
      change("modified", at(12)),
      change("created", at(7)),
      change("deleted", at(1)),
      change("modified", "언제인지 모름"),
      change("created", at(45)),
    ];
    expect(nextPullWatermark(at(30), unapplied)).toBe(at(7));
    expect(nextPullWatermark(at(30), [])).toBe(at(30));
  });

  it("조회는 기준 시각에서 안전창(15분)만큼 되돌려 시작한다", () => {
    expect(incrementalSearchSince(at(30))).toBe(at(15));
    expect(incrementalSearchSince("언제인지 모름")).toBe("언제인지 모름");
  });
});
