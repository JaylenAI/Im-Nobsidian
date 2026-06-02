/**
 * rank19 — push 측 삭제(delete)의 I12 크래시-재개 안전성을 오프라인·결정적으로 잠근다.
 *
 * WAL 재개(recoverInterruptedPushOps)는 create 만 재생한다 — update/delete 는 **본질적
 * 멱등성**으로 안전하다(설계 결정). 따라서 그 멱등성이 회귀하면 I12 가 조용히 깨진다.
 *  - delete 재실행: 아카이브가 Notion 엔 적용됐으나 로컬 레코드 삭제가 중단된 경우, 다음
 *    push 가 같은 페이지를 또 아카이브해도 "이미 아카이브된 조상" 오류를 graceful 흡수하고
 *    레코드를 정리해 수렴해야 한다(중복·실패 0).
 *  - 레코드 제거 후 재실행: synced 레코드가 사라졌으면 삭제 변경 자체가 더는 감지되지 않아
 *    추가 아카이브 호출이 0 이어야 한다(완전 멱등).
 *
 * 실제 StateDB + 실 create→delete 경로로 자기충족 함정을 배제하고, archivePage 호출 수·
 * deleted 카운트·레코드 잔존 여부를 수치로 단언한다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import type { FileStatInfo, VaultFS } from "../../src/sync/vault-fs.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import {
  createMockVaultFs,
  createMockNotionClient,
  createConfig,
} from "../helpers/mock-orchestrator.js";

const FILE = "doomed.md";
const CONTENT = "# Doomed\n\n곧 삭제될 노트.\n";
const SIZE = Buffer.byteLength(CONTENT, "utf-8");

describe("push 측 삭제 멱등성·graceful 아카이브 (I12, rank19)", () => {
  let tempDir: string;
  let db: StateDB;
  let vaultFs: VaultFS;
  let notionClient: ReturnType<typeof createMockNotionClient>;
  let orchestrator: SyncOrchestrator;
  let stats: FileStatInfo[];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-del-"));
    db = StateDB.open(join(tempDir, "state.db"));
    stats = [{ path: FILE, mtime: "2026-05-30T00:00:00.000Z", size: SIZE }];

    vaultFs = createMockVaultFs();
    vaultFs.listMarkdownFileStats = async () => stats;
    vaultFs.readFile = async (p: string) => {
      if (p === FILE) return CONTENT;
      throw new Error(`unexpected readFile: ${p}`);
    };
    vaultFs.getFileStat = async (p: string) => (p === FILE && stats.length > 0 ? stats[0]! : null);

    notionClient = createMockNotionClient();
    // deleteSync 를 켜야 실제 아카이브 전파가 일어난다(기본은 false).
    const config = createConfig({
      sync: { ...DEFAULT_CONFIG.sync, deleteSync: true },
    });
    orchestrator = new SyncOrchestrator(config, db, notionClient as never, vaultFs);
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("삭제 후 재push 는 추가 아카이브·실패 0(레코드 제거 → 변경 미감지, 완전 멱등)", async () => {
    const create = await orchestrator.push();
    expect(create.created).toBe(1);

    // 파일 제거 → 삭제 감지 → 아카이브 1회 + 레코드 정리.
    stats = [];
    const del = await orchestrator.push();
    expect(del.deleted).toBe(1);
    expect(del.failed).toEqual([]);
    expect(notionClient.archivePage).toHaveBeenCalledTimes(1);
    expect(db.getByPath(FILE), "삭제 후 레코드 제거됨").toBeFalsy();

    // 재push: 레코드가 없으니 삭제 변경 자체가 없다 → 추가 아카이브 0.
    const again = await orchestrator.push();
    expect(again.deleted).toBe(0);
    expect(again.failed).toEqual([]);
    expect(notionClient.archivePage, "재실행 시 추가 아카이브 0").toHaveBeenCalledTimes(1);
  });

  it("이미 아카이브된 조상 — archivePage 가 'archived ancestor' 던져도 삭제 성공(graceful)", async () => {
    const create = await orchestrator.push();
    expect(create.created).toBe(1);

    // 크래시-재개 모델: 부모가 이미 아카이브돼 자식 아카이브가 거부되는 상황.
    (notionClient.archivePage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error(
        "Can't edit block that is archived. You must unarchive the archived ancestor first.",
      ),
    );

    stats = [];
    const del = await orchestrator.push();
    // graceful 흡수: 실패 0, 삭제 1건으로 카운트, 레코드는 정리됨(수렴).
    expect(del.failed).toEqual([]);
    expect(del.deleted).toBe(1);
    expect(notionClient.archivePage).toHaveBeenCalledTimes(1);
    expect(db.getByPath(FILE), "graceful 삭제 후 레코드 제거됨").toBeFalsy();
  });
});
