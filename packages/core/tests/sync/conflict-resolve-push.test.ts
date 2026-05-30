/**
 * 충돌 해소 재push 회귀 잠금 (I8) — "해소했는데 Notion 에 반영 안 돼 영구 유실·충돌 루프" 재발 방지.
 *
 * 결함(rank1): ConflictResolver.resolveMerge/resolveLocal 은 병합/로컬 결과를 **로컬 파일 +
 * sync_state 해시에만** 반영하고 Notion 으로 push 하지 않으며 notionLastEdited 도 갱신하지
 * 않는다. 그 결과 다음 pull 이 (여전히 옛 내용인) 원격을 변경으로 보고 같은 충돌을 재생성
 * → 사용자가 아무리 해소해도 무한 충돌 루프 + 병합 결과 영구 유실.
 *
 * 수정: SyncOrchestrator.resolveConflict* 가 해소 후 propagateResolution 으로
 *   - local/merge(성공)/duplicate → pushUpdate 로 해소된 본문을 Notion 에 재push +
 *     notionLastEdited 를 push 후 시각으로 재조정,
 *   - remote → push 없이 notionLastEdited 를 원격 변경 시각으로 재조정,
 *   - merge(충돌 마커 잔존) → push 안 함·conflict 상태 유지.
 *
 * 본 테스트는 leaf 페이지(자식 없음) 충돌을 mock NotionClient 로 구성하고, 각 분기에서
 * replacePageMarkdown 호출 여부 / notionLastEdited 재조정 / status 를 단언한다.
 * 가드 유효성: 수정 전(propagateResolution 미존재)에는 merge 분기에서 replacePageMarkdown
 * 호출 0 · notionLastEdited 미갱신으로 이 테스트가 실패한다.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BlockObjectResponse } from "@notionhq/client/build/src/api-endpoints.js";

import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { NotionClient } from "../../src/notion/client.js";
import { NodeVaultFS } from "../../src/sync/node-vault-fs.js";
import { obsidianToNotionEnhanced } from "../../src/converter/enhanced-md-converter.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import type { Config } from "../../src/types/config.js";
import type { Conflict, SyncRecord } from "../../src/types/sync.js";

const ROOT = "11111111111111111111111111111111";
const PAGE = "44444444444444444444444444444444";
const PATH = "Note.md";

/** 본문 정규화 — CRLF→LF, 줄 끝 공백 제거, 3+ 연속 개행→2, 말미 trim. */
function canon(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 원격이 마지막으로 동기화된 시각(레코드에 저장된 baseline) vs 이번에 변경된 원격 시각.
const SYNCED_AT = "2026-05-30T01:00:00.000Z"; // 레코드 notionLastEdited (옛 baseline)
const REMOTE_EDITED = "2026-05-30T02:00:00.000Z"; // 원격이 새로 바뀐 시각(remoteChange)

interface Harness {
  orchestrator: SyncOrchestrator;
  db: StateDB;
  vaultFs: NodeVaultFS;
  record: SyncRecord;
  replaceSpy: ReturnType<typeof vi.fn>;
}

describe("충돌 해소 재push — 영구 유실·충돌 루프 회귀 잠금 (I8)", () => {
  let tmpDir: string | null = null;
  let db: StateDB | null = null;

  afterEach(async () => {
    if (db) db.close();
    db = null;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
    vi.restoreAllMocks();
  });

  /**
   * leaf 페이지 충돌 1건을 디스크+DB+mock 으로 구성한다.
   * localBody/remoteBody/baseBody 로 3-way merge 시나리오를 제어한다.
   */
  async function setup(opts: {
    baseBody: string;
    localBody: string;
    remoteBody: string;
  }): Promise<Harness> {
    tmpDir = await mkdtemp(join(tmpdir(), "im-conflict-push-"));
    const vaultFs = new NodeVaultFS(tmpDir);
    await vaultFs.ensureFolder(".im-nobsidian");
    db = StateDB.open(join(tmpDir, ".im-nobsidian", "sync.db"));

    // 로컬 파일은 현재 로컬 본문(local)을 담는다.
    await vaultFs.writeFile(PATH, opts.localBody);

    // conflict 상태 레코드 — 옛 baseline 시각으로 notionLastEdited 고정.
    const record = db.upsert({
      obsidianPath: PATH,
      notionPageId: PAGE,
      notionParentId: ROOT,
      contentHash: "stale-hash",
      notionLastEdited: SYNCED_AT,
      localLastModified: SYNCED_AT,
      syncDirection: "both",
      fileType: "file",
      status: "conflict",
      baseSnapshot: Buffer.from(opts.baseBody, "utf-8"),
    });

    const client = new NotionClient({ token: "offline-test" });
    // leaf 페이지: 직속 child page/database 가 없어야 본문 replace 경로를 탄다.
    vi.spyOn(client, "fetchAllChildren").mockResolvedValue([] as BlockObjectResponse[]);
    const replaceSpy = vi
      .spyOn(client, "replacePageMarkdown")
      .mockResolvedValue({ pageId: PAGE } as never) as unknown as ReturnType<typeof vi.fn>;
    // 본문만 push 하는 plain 시나리오에서는 updatePageProperties 가 호출되지 않아야 한다(단언).
    vi.spyOn(client, "updatePageProperties").mockResolvedValue({
      last_edited_time: REMOTE_EDITED,
    } as never);

    const config: Config = {
      ...DEFAULT_CONFIG,
      notion: { ...DEFAULT_CONFIG.notion, rootPageId: ROOT, token: "offline-test" },
    };
    const orchestrator = new SyncOrchestrator(config, db, client, vaultFs);

    return { orchestrator, db, vaultFs, record, replaceSpy };
  }

  function makeConflict(record: SyncRecord, base: string, local: string, remote: string): Conflict {
    return {
      syncRecord: record,
      localChange: {
        path: PATH,
        type: "modified",
        currentHash: "local-hash",
        previousHash: "stale-hash",
      },
      remoteChange: {
        pageId: PAGE,
        type: "modified",
        lastEdited: REMOTE_EDITED,
        previousEdited: SYNCED_AT,
      },
      baseContent: base,
      localContent: local,
      remoteContent: remote,
    };
  }

  it("manual(merge) 비충돌 병합 → 병합 본문이 Notion 에 재push + notionLastEdited 재조정", async () => {
    // base 공통, local 은 앞줄 추가, remote 는 뒷줄 추가 — 겹치지 않아 자동 병합 성공.
    const base = "shared line\n";
    const local = "local top line\nshared line\n";
    const remote = "shared line\nremote bottom line\n";
    const { orchestrator, db, vaultFs, record, replaceSpy } = await setup({
      baseBody: base,
      localBody: local,
      remoteBody: remote,
    });

    const result = await orchestrator.resolveConflictByStrategy(
      makeConflict(record, base, local, remote),
      "manual",
    );

    // 1) 자동 병합 성공.
    expect(result.success).toBe(true);
    expect(result.choice).toBe("merge");

    // 2) 병합 결과가 Notion 으로 정확히 1회 push (수정 전엔 0회 — 핵심 회귀 잠금).
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    const [pushedPageId, pushedBody] = replaceSpy.mock.calls[0] as [string, string];
    expect(pushedPageId).toBe(PAGE);

    // 3) push 본문 = 디스크에 기록된 병합 본문 (정규화 후 전체 deep-equal, 부분일치 아님).
    //    push 파이프라인은 말미 개행만 정규화(trim)하므로 canon 으로 양변을 맞춘 뒤 비교한다.
    const mergedOnDisk = await vaultFs.readFile(PATH);
    expect(canon(pushedBody)).toBe(canon(obsidianToNotionEnhanced(mergedOnDisk)));

    // 4) 병합 본문에 충돌 마커가 없어야 한다(깨끗한 수렴).
    expect(mergedOnDisk).not.toContain("<<<<<<<");
    expect(mergedOnDisk).not.toContain(">>>>>>>");
    // local·remote 양쪽 편집이 모두 보존된다(한쪽만 이긴 게 아님).
    expect(mergedOnDisk).toContain("local top line");
    expect(mergedOnDisk).toContain("remote bottom line");

    // 5) notionLastEdited 가 옛 baseline 에서 전진(setNotionLastEdited 호출됨) + status synced.
    const after = db.getByNotionId(PAGE)!;
    expect(after.status).toBe("synced");
    expect(after.notionLastEdited).not.toBe(SYNCED_AT);
    expect(after.notionLastEdited).toBeTruthy();
  });

  it("remote(remote-first) → push 없이 notionLastEdited 를 원격 변경 시각으로 재조정", async () => {
    const base = "shared\n";
    const local = "local only\nshared\n";
    const remote = "shared\nremote only\n";
    const { orchestrator, db, record, replaceSpy } = await setup({
      baseBody: base,
      localBody: local,
      remoteBody: remote,
    });

    const result = await orchestrator.resolveConflictByStrategy(
      makeConflict(record, base, local, remote),
      "remote-first",
    );

    expect(result.success).toBe(true);
    expect(result.choice).toBe("remote");

    // 원격 선택은 로컬을 원격으로 덮어쓴 것뿐 — Notion push 불필요.
    expect(replaceSpy).not.toHaveBeenCalled();

    // notionLastEdited = 원격 변경 시각 → 다음 pull 이 동일 변경을 재충돌로 보지 않음.
    const after = db.getByNotionId(PAGE)!;
    expect(after.notionLastEdited).toBe(REMOTE_EDITED);
    expect(after.status).toBe("synced");
  });

  it("manual(merge) 겹치는 편집 → 충돌 마커 잔존 시 push 안 함·conflict 유지", async () => {
    // 같은 줄을 양쪽이 다르게 수정 → 3-way merge 실패(마커 잔존).
    const base = "original line\n";
    const local = "LOCAL edit of same line\n";
    const remote = "REMOTE edit of same line\n";
    const { orchestrator, db, record, replaceSpy } = await setup({
      baseBody: base,
      localBody: local,
      remoteBody: remote,
    });

    const result = await orchestrator.resolveConflictByStrategy(
      makeConflict(record, base, local, remote),
      "manual",
    );

    // 자동 병합 실패 — 사용자가 직접 마커를 풀어야 한다.
    expect(result.success).toBe(false);
    expect(result.mergeHadConflicts).toBe(true);

    // 미해소 마커를 Notion 에 밀어넣지 않는다.
    expect(replaceSpy).not.toHaveBeenCalled();

    // status 는 conflict 유지(해소 안 됨), notionLastEdited 는 옛 baseline 그대로.
    const after = db.getByNotionId(PAGE)!;
    expect(after.status).toBe("conflict");
    expect(after.notionLastEdited).toBe(SYNCED_AT);
  });
});
