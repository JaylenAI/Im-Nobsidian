/**
 * rank11 — push 측 I5 멱등성(idempotency)을 **오케스트레이터 배선 수준**에서 잠근다.
 *
 * 같은 내용을 두 번 push 하면 2회차는 무손실 no-op 이어야 한다(Notion 쓰기 0건). 이 성질이
 * 깨지면 sync 가 매번 가짜 변경을 만들어 무한 churn·중복 페이지를 유발한다. 본 테스트는
 * 모킹 stateDb 에 기대 레코드를 손으로 심지 않고 **실제 StateDB(임시 파일)** 를 써서 1회차
 * push 가 기록한 진짜 레코드를 2회차가 production getByPath/getByStatus 경로로 읽게 한다
 * (손-심기는 "증명하려는 그 레코드"를 가정으로 깔아버리는 자기충족 함정이라 금지).
 *
 * 두 가드를 각각 증명한다:
 *  1. 빠른 경로 — mtime+size 일치 → 내용 읽지 않고 skip (detectLocalChangesFast 단락).
 *  2. content-hash fixpoint — 파일이 touch 돼 mtime 이 바뀌어도(=size 동일·내용 동일)
 *     해시가 일치하면 변경 0 (mtime churn 이 가짜 push 를 만들지 않는다 — I5 핵심).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import type { FileStatInfo, VaultFS } from "../../src/sync/vault-fs.js";
import {
  createMockVaultFs,
  createMockNotionClient,
  createConfig,
} from "../helpers/mock-orchestrator.js";

const FILE = "note.md";
const CONTENT = "# Note\n\nHello lossless world.\n\n- a\n- b\n";
const SIZE = Buffer.byteLength(CONTENT, "utf-8");
const T0 = "2026-05-30T00:00:00.000Z";
const T1 = "2026-05-30T12:34:56.000Z"; // touch 로 mtime 만 바뀐 시각(내용 불변)

describe("push 측 I5 멱등성 (push-twice → no-op, rank11)", () => {
  let tempDir: string;
  let db: StateDB;
  let vaultFs: VaultFS;
  let notionClient: ReturnType<typeof createMockNotionClient>;
  let orchestrator: SyncOrchestrator;
  // listMarkdownFileStats / getFileStat 가 함께 바라보는 단일 stat(테스트가 mtime 을 조작).
  let currentStat: FileStatInfo;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-pushidem-"));
    db = StateDB.open(join(tempDir, "state.db"));
    currentStat = { path: FILE, mtime: T0, size: SIZE };

    vaultFs = createMockVaultFs();
    // 실제 볼트처럼 동작: 같은 파일/내용/stat 을 일관되게 돌려준다.
    vaultFs.listMarkdownFileStats = async () => [currentStat];
    vaultFs.readFile = async (path: string) => {
      if (path === FILE) return CONTENT;
      throw new Error(`unexpected readFile: ${path}`);
    };
    vaultFs.getFileStat = async (path: string) => (path === FILE ? currentStat : null);

    notionClient = createMockNotionClient();
    orchestrator = new SyncOrchestrator(createConfig(), db, notionClient as never, vaultFs);
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  /** push 1건이 만든 Notion 쓰기 호출 총합(생성+갱신 경로 전부). */
  function notionWriteCount(): number {
    return (
      notionClient.createPageWithMarkdown.mock.calls.length +
      notionClient.createPage.mock.calls.length +
      notionClient.appendChildren.mock.calls.length +
      notionClient.replacePageMarkdown.mock.calls.length +
      notionClient.updatePageMarkdownPartial.mock.calls.length
    );
  }

  it("동일 mtime+size → 2회차 push 는 내용을 읽지 않고 no-op(빠른 경로)", async () => {
    const first = await orchestrator.push();
    expect(first.created).toBe(1);
    expect(notionClient.createPageWithMarkdown).toHaveBeenCalledTimes(1);
    const writesAfterFirst = notionWriteCount();

    // 2회차: stat 그대로(T0). detectLocalChangesFast 가 mtime+size 일치로 단락 skip.
    const second = await orchestrator.push();
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.deleted).toBe(0);
    expect(second.failed).toEqual([]);

    // 어떤 Notion 쓰기도 추가로 일어나지 않았다(진짜 no-op).
    expect(notionWriteCount()).toBe(writesAfterFirst);
    expect(notionClient.createPageWithMarkdown).toHaveBeenCalledTimes(1);
  });

  it("mtime 만 변함(touch)·내용 동일 → content-hash fixpoint 로 여전히 no-op", async () => {
    const first = await orchestrator.push();
    expect(first.created).toBe(1);
    expect(notionClient.createPageWithMarkdown).toHaveBeenCalledTimes(1);
    const writesAfterFirst = notionWriteCount();

    // 파일을 touch: mtime 만 T1 으로(빠른 경로 단락이 깨짐) — size·내용은 불변.
    currentStat = { path: FILE, mtime: T1, size: SIZE };

    const second = await orchestrator.push();
    expect(second.created).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.deleted).toBe(0);

    // 빠른 경로가 아니라 해시 비교로 막혔다 — Notion 쓰기 추가 0.
    expect(notionWriteCount()).toBe(writesAfterFirst);
    expect(notionClient.createPageWithMarkdown).toHaveBeenCalledTimes(1);
  });
});
