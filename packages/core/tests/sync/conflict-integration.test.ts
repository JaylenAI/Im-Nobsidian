import { describe, it, expect, vi } from "vitest";
import { resolvePullConflict } from "../../src/sync/conflict-detector.js";
import { ConflictResolver } from "../../src/conflict/resolver.js";
import type { RemoteChange, SyncRecord, SyncStatus } from "../../src/types/sync.js";
import type { VaultFS } from "../../src/sync/vault-fs.js";
import type { IStateDB } from "../../src/state/state-db-interface.js";
import { computeHash } from "../../src/utils/hash.js";

/**
 * I8 통합 — 충돌 탐지 → 해소 전 구간(end-to-end).
 *
 * 단위 테스트는 세 레이어를 분리해 검증한다:
 *   - merger.test.ts          : threeWayMerge 순수 함수
 *   - conflict-detector.test.ts: resolvePullConflict 순수 판정
 *   - resolver.test.ts        : ConflictResolver(목 stateDb/vaultFs)
 *
 * 그러나 "pull 이 base 스냅샷을 Buffer 로 적재 → 그 Buffer 가 3-way 병합의 non-null base 가
 * 되어 비겹침 편집을 거짓 충돌 없이 자동 병합"하는 **실제 배선**은 어디에서도 단언되지 않았다.
 * 이 파일은 진짜 detector + 진짜 resolver + 진짜 merger 를 인메모리 VaultFS/StateDB 위에서
 * 함께 구동해 I8 불변식을 통합 수준으로 잠근다:
 *
 *   - base 스냅샷(Buffer) → conflict.baseContent(non-null) → threeWayMerge 의 base 로 왕복
 *   - 비겹침 편집 → 자동 병합 성공, 양측 편집 모두 보존, **false-conflict 0**
 *   - 겹침 편집  → 명시적 충돌 마커, status 는 conflict 유지(**조용한 덮어쓰기 금지**)
 *   - 무내용 last_edited 변경(remote==base) → 충돌 아님, 로컬 보존(detector 단계 단락)
 *   - 양측 동일 변경(local==remote) → 충돌 아님(write 로 수렴)
 *   - 해소 후 재pull → 충돌 재발 0(**영구 충돌 루프 0**)
 */

/** updateHash/updateStatus 변이를 실제로 적재해 다시 읽을 수 있는 최소 인메모리 StateDB. */
class InMemoryStateDb {
  private record: SyncRecord;

  constructor(initial: SyncRecord) {
    this.record = initial;
  }

  get(): SyncRecord {
    return this.record;
  }

  updateHash = vi.fn((id: string, hash: string, snapshot?: Buffer | Uint8Array | null): void => {
    expect(id).toBe(this.record.id);
    const base =
      snapshot == null ? null : Buffer.isBuffer(snapshot) ? snapshot : Buffer.from(snapshot);
    this.record = { ...this.record, contentHash: hash, baseSnapshot: base };
  });

  updateStatus = vi.fn((id: string, status: SyncStatus): void => {
    expect(id).toBe(this.record.id);
    this.record = { ...this.record, status };
  });
}

/** 디스크 대신 메모리에 파일 내용을 보관하는 VaultFS — 병합 결과를 읽어 단언한다. */
function createMemoryVaultFs(seed: Record<string, string> = {}): VaultFS & {
  files: Map<string, string>;
} {
  const files = new Map<string, string>(Object.entries(seed));
  return {
    files,
    readFile: vi.fn(async (p: string) => files.get(p) ?? ""),
    readBinary: vi.fn(async () => Buffer.from("")),
    writeFile: vi.fn(async (p: string, c: string) => {
      files.set(p, c);
    }),
    writeBinary: vi.fn(async () => undefined),
    deleteFile: vi.fn(async (p: string) => {
      files.delete(p);
    }),
    moveFile: vi.fn(async () => undefined),
    exists: vi.fn(async (p: string) => files.has(p)),
    ensureFolder: vi.fn(async () => undefined),
    listMarkdownFiles: vi.fn(async () => []),
    listMarkdownFileStats: vi.fn(async () => []),
    listNonMarkdownFiles: vi.fn(async () => []),
    getFileStat: vi.fn(async () => null),
  };
}

function makeRecord(baseText: string, overrides?: Partial<SyncRecord>): SyncRecord {
  return {
    id: "rec-1",
    obsidianPath: "db/감자.md",
    notionPageId: "page-1",
    notionParentId: "db-1",
    // 마지막 동기화 시점 = base 와 동일한 콘텐츠 해시.
    contentHash: computeHash(baseText),
    notionLastEdited: "2026-05-30T00:00:00.000Z",
    localLastModified: "2026-05-30T00:00:00.000Z",
    syncDirection: "both",
    fileType: "db-row",
    status: "synced",
    // pull 이 적재한 base 스냅샷 — 3-way 병합의 공통 조상.
    baseSnapshot: Buffer.from(baseText, "utf-8"),
    localMtime: null,
    localFileSize: null,
    version: 1,
    createdAt: "2026-05-30T00:00:00.000Z",
    updatedAt: "2026-05-30T00:00:00.000Z",
    ...overrides,
  };
}

const remoteChange: RemoteChange = {
  pageId: "page-1",
  type: "modified",
  lastEdited: "2026-05-30T02:00:00.000Z",
  previousEdited: "2026-05-30T00:00:00.000Z",
};

/** detector → resolver 전 구간을 한 번에 구동하는 헬퍼. */
async function detectAndResolve(opts: {
  record: SyncRecord;
  localContent: string;
  remoteContent: string;
  stateDb: InMemoryStateDb;
  vaultFs: VaultFS;
}) {
  const decision = resolvePullConflict({
    record: opts.record,
    localContent: opts.localContent,
    remoteContent: opts.remoteContent,
    remoteChange,
    strategy: "manual",
  });

  if (decision.action !== "conflict") {
    return { decision, resolution: null as null };
  }

  const resolver = new ConflictResolver(opts.stateDb as unknown as IStateDB, opts.vaultFs);
  // manual 전략 → merge 경로(3-way 병합).
  const resolution = await resolver.resolveByStrategy(decision.conflict!, "manual");
  return { decision, resolution };
}

describe("I8 통합: pull base 스냅샷 → 3-way 병합 전 구간", () => {
  it("비겹침 편집: base(Buffer) 가 non-null base 로 왕복되어 자동 병합 — false-conflict 0", async () => {
    const base = "# 감자\n\n상태: 진행\n메모: 없음\n수확: 가을";
    // 로컬은 '메모' 줄을, 리모트는 '상태' 줄을 — 서로 다른 영역을 수정.
    const local = "# 감자\n\n상태: 진행\n메모: 밭에 심음\n수확: 가을";
    const remote = "# 감자\n\n상태: 완료\n메모: 없음\n수확: 가을";

    const record = makeRecord(base);
    const stateDb = new InMemoryStateDb(record);
    const vaultFs = createMemoryVaultFs({ [record.obsidianPath]: local });

    const { decision, resolution } = await detectAndResolve({
      record,
      localContent: local,
      remoteContent: remote,
      stateDb,
      vaultFs,
    });

    // detector: 양측 수정 → 충돌로 넘기되 baseContent 는 스냅샷에서 복원된 non-null.
    expect(decision.action).toBe("conflict");
    expect(decision.conflict!.baseContent).toBe(base);
    expect(decision.conflict!.baseContent).not.toBeNull();

    // resolver(merge): 비겹침 → 자동 병합 성공, 충돌 마커 없음.
    expect(resolution!.success).toBe(true);
    expect(resolution!.mergeHadConflicts).toBe(false);

    // 병합 결과 파일이 양측 편집을 모두 보존.
    const merged = vaultFs.files.get(record.obsidianPath)!;
    expect(merged).toContain("상태: 완료"); // 리모트 편집
    expect(merged).toContain("메모: 밭에 심음"); // 로컬 편집
    expect(merged).not.toContain("<<<<<<<");

    // 상태는 synced 로 정리.
    expect(stateDb.get().status).toBe("synced");
    expect(stateDb.get().contentHash).toBe(computeHash(merged));
  });

  it("겹침 편집: 같은 줄을 양측이 다르게 → 명시적 충돌 마커, 조용한 덮어쓰기 금지", async () => {
    const base = "# 양파\n\n상태: 진행";
    const local = "# 양파\n\n상태: 로컬에서 완료";
    const remote = "# 양파\n\n상태: 리모트에서 보류";

    // 실제 orchestrator 는 detector 가 충돌을 반환하면 레코드를 conflict 로 표시한 뒤
    // resolver 에 넘긴다. 그 상태를 그대로 재현한다.
    const record = makeRecord(base, { status: "conflict" });
    const stateDb = new InMemoryStateDb(record);
    const vaultFs = createMemoryVaultFs({ [record.obsidianPath]: local });

    const { decision, resolution } = await detectAndResolve({
      record,
      localContent: local,
      remoteContent: remote,
      stateDb,
      vaultFs,
    });

    expect(decision.action).toBe("conflict");
    expect(resolution!.success).toBe(false);
    expect(resolution!.mergeHadConflicts).toBe(true);

    const written = vaultFs.files.get(record.obsidianPath)!;
    expect(written).toContain("<<<<<<< LOCAL");
    expect(written).toContain("로컬에서 완료");
    expect(written).toContain("리모트에서 보류");
    expect(written).toContain(">>>>>>> REMOTE");

    // merge 미성공 → updateStatus(synced) 미호출 → 충돌 상태 그대로 유지(조용한 덮어쓰기 금지).
    expect(stateDb.updateStatus).not.toHaveBeenCalledWith(record.id, "synced");
    expect(stateDb.get().status).toBe("conflict");
  });

  it("무내용 last_edited 변경(remote==base): 충돌 아님 — detector 단계에서 로컬 보존(skip)", async () => {
    const base = "# 당근\n\n상태: 진행";
    const local = "# 당근\n\n상태: 로컬 수정"; // 로컬만 실제로 변경
    const remote = base; // 리모트는 내용 동일, last_edited 만 갱신된 가짜 변경

    const record = makeRecord(base);

    const decision = resolvePullConflict({
      record,
      localContent: local,
      remoteContent: remote,
      remoteChange,
      strategy: "manual",
    });

    // 콘텐츠 해시 기준 → 리모트는 실변경 아님 → skip(로컬 보존), merge 진입 안 함.
    expect(decision.action).toBe("skip");
    expect(decision.conflict).toBeUndefined();
  });

  it("양측 동일 변경(local==remote): 충돌 아님 — write 로 수렴", () => {
    const base = "# 마늘\n\n상태: 진행";
    const converged = "# 마늘\n\n상태: 완료"; // 양측이 똑같이 편집
    const record = makeRecord(base);

    const decision = resolvePullConflict({
      record,
      localContent: converged,
      remoteContent: converged,
      remoteChange,
      strategy: "manual",
    });

    expect(decision.action).toBe("write");
    expect(decision.conflict).toBeUndefined();
  });

  it("영구 충돌 루프 0: 자동 병합 해소 후 재pull 하면 충돌 재발하지 않는다", async () => {
    const base = "# 감자\n\n상태: 진행\n메모: 없음";
    const local = "# 감자\n\n상태: 진행\n메모: 로컬 추가";
    const remote = "# 감자\n\n상태: 완료\n메모: 없음";

    const record = makeRecord(base);
    const stateDb = new InMemoryStateDb(record);
    const vaultFs = createMemoryVaultFs({ [record.obsidianPath]: local });

    // 1차: 비겹침 충돌 → 자동 병합.
    const first = await detectAndResolve({
      record,
      localContent: local,
      remoteContent: remote,
      stateDb,
      vaultFs,
    });
    expect(first.resolution!.success).toBe(true);

    const merged = vaultFs.files.get(record.obsidianPath)!;
    const resolvedRecord = stateDb.get();
    // 해소 후 base 스냅샷과 contentHash 가 병합 결과로 갱신됨.
    expect(resolvedRecord.baseSnapshot!.toString("utf-8")).toBe(merged);
    expect(resolvedRecord.contentHash).toBe(computeHash(merged));

    // 2차 pull: Notion 이 병합본을 반영(remote==merged), 로컬도 병합본 그대로 → 충돌 재발 없음.
    const second = resolvePullConflict({
      record: resolvedRecord,
      localContent: merged,
      remoteContent: merged,
      remoteChange,
      strategy: "manual",
    });
    expect(second.action).toBe("write"); // 로컬 미수정 → 조용히 정리, 충돌 0
    expect(second.conflict).toBeUndefined();
  });
});
