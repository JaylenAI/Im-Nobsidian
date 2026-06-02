/**
 * rank9 — block-API 폴백 갱신 경로(preferMarkdownApi=false)의 append-then-delete
 * 수렴성(I12 크래시-재개 멱등)을 **오프라인·결정적**으로 잠근다.
 *
 * 폴백 갱신은 (1) 새 블록 append → (2) **append 직전 스냅샷**의 옛 블록 delete 순서다.
 * 이 순서+사전 스냅샷 덕에 같은 갱신이 두 번 실행돼도(예: Notion 엔 적용됐으나 로컬
 * synced-hash 기록이 중단돼 다음 push 가 같은 변경을 재감지) 페이지는 **정확히 한 벌**로
 * 수렴한다(누적·유실 0). 기존 idempotency/crash-resume 불변식은 모두 실Notion 게이트라
 * 이 폴백 경로의 수렴은 오프라인으로 검증되지 않았다 — 본 테스트가 그 갭을 메운다.
 *
 * 자기충족 함정 배제: 모킹 stateDb 에 결과를 심지 않고 **실제 StateDB** + **상태 보존
 * NotionClient 목**(페이지별 children 을 append/delete/fetch 로 실제 변형)을 써서 production
 * push 경로가 진짜 블록 집합을 변형하게 하고, 변형된 children 을 직접 단언한다.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { vi } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { computeHash } from "../../src/utils/hash.js";
import type { FileStatInfo, VaultFS } from "../../src/sync/vault-fs.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import {
  createMockVaultFs,
  createMockNotionClient,
  createConfig,
} from "../helpers/mock-orchestrator.js";

type StoredBlock = { id: string; type: string; [k: string]: unknown };

const FILE = "doc.md";
const V1 = "alpha one\n\nalpha two\n";
const V2 = "beta one\n\nbeta two\n\nbeta three\n";
const byteLen = (s: string) => Buffer.byteLength(s, "utf-8");

/** 블록의 rich_text 평문(없으면 ""). */
function blockText(b: StoredBlock): string {
  const data = b[b.type] as { rich_text?: Array<{ text?: { content?: string } }> } | undefined;
  return (data?.rich_text ?? []).map((rt) => rt.text?.content ?? "").join("");
}

/**
 * 페이지별 children 을 실제로 보존·변형하는 NotionClient 목.
 * createPage→빈 children 등록, appendChildren→결정적 id 부여 후 추가, deleteBlock→id 제거.
 */
function makeStatefulNotion() {
  const base = createMockNotionClient();
  const pages = new Map<string, StoredBlock[]>();
  let pageSeq = 0;
  let blockSeq = 0;

  base.createPage = vi.fn(async () => {
    const id = `page-${++pageSeq}`;
    pages.set(id, []);
    return { id, last_edited_time: "2026-05-30T00:00:00.000Z" };
  }) as never;
  base.appendChildren = vi.fn(async (pageId: string, blocks: StoredBlock[]) => {
    const arr = pages.get(pageId) ?? pages.set(pageId, []).get(pageId)!;
    for (const b of blocks) arr.push({ ...b, id: `blk-${++blockSeq}` });
    return {};
  }) as never;
  base.fetchAllChildren = vi.fn(async (pageId: string) =>
    (pages.get(pageId) ?? []).map((b) => ({ ...b })),
  ) as never;
  base.deleteBlock = vi.fn(async (id: string) => {
    for (const arr of pages.values()) {
      const i = arr.findIndex((b) => b.id === id);
      if (i >= 0) {
        arr.splice(i, 1);
        return;
      }
    }
  }) as never;
  // 갱신 말미의 권위 last_edited 갱신(title 속성 유무 어느 분기든 안전).
  base.updatePageProperties = vi.fn(async () => ({
    last_edited_time: "2026-05-30T00:00:00.000Z",
  })) as never;

  return { client: base, pages };
}

describe("block-API 폴백 갱신 append-then-delete 수렴 (I12, rank9)", () => {
  let tempDir: string;
  let db: StateDB;
  let vaultFs: VaultFS;
  let notion: ReturnType<typeof makeStatefulNotion>;
  let orchestrator: SyncOrchestrator;
  let content: string;
  let stat: FileStatInfo;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-blkupd-"));
    db = StateDB.open(join(tempDir, "state.db"));
    content = V1;
    stat = { path: FILE, mtime: "2026-05-30T00:00:00.000Z", size: byteLen(V1) };

    vaultFs = createMockVaultFs();
    vaultFs.listMarkdownFileStats = async () => [stat];
    vaultFs.readFile = async (p: string) => {
      if (p === FILE) return content;
      throw new Error(`unexpected readFile: ${p}`);
    };
    vaultFs.getFileStat = async (p: string) => (p === FILE ? stat : null);

    notion = makeStatefulNotion();
    const config = createConfig({
      conversion: { ...DEFAULT_CONFIG.conversion, preferMarkdownApi: false },
    });
    orchestrator = new SyncOrchestrator(config, db, notion.client as never, vaultFs);
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  /** 단일 페이지의 현재 블록 평문 집합(정렬). */
  function pageTexts(): string[] {
    const all = [...notion.pages.values()].flat();
    return all.map(blockText).sort();
  }

  it("같은 갱신을 두 번 실행해도 페이지는 정확히 한 벌로 수렴(누적·유실 0)", async () => {
    // 1) 생성: V1 본문. block-API 경로(createPage+appendChildren).
    const push1 = await orchestrator.push();
    expect(push1.created).toBe(1);
    expect(push1.failed).toEqual([]);
    expect(notion.client.createPageWithMarkdown).not.toHaveBeenCalled();
    const v1Texts = ["alpha one", "alpha two"];
    expect(pageTexts()).toEqual([...v1Texts].sort());

    const rec = db.getByPath(FILE)!;
    expect(rec.notionPageId).toBeTruthy();

    // 2) 갱신: V2 본문(파일 변경). append-then-delete 로 V1→V2 교체.
    content = V2;
    stat = { path: FILE, mtime: "2026-05-30T01:00:00.000Z", size: byteLen(V2) };
    const push2 = await orchestrator.push();
    expect(push2.updated).toBe(1);
    expect(push2.created).toBe(0);
    expect(push2.failed).toEqual([]);

    const v2Texts = ["beta one", "beta two", "beta three"];
    // V1 흔적 0, V2 정확히 한 벌(append-then-delete 가 교체로 동작).
    expect(pageTexts()).toEqual([...v2Texts].sort());

    // 3) 크래시-재개 모델: Notion 엔 V2 가 적용됐으나 로컬 synced-hash 기록이 중단됐다고
    //    가정 → 레코드 해시를 옛 값(hash(V1))으로 되돌리고 파일 mtime 만 바꿔, 다음 push 가
    //    "같은 V2 갱신"을 한 번 더 재감지하게 만든다(파일 내용은 그대로 V2).
    db.updateHash(rec.id, computeHash(V1), Buffer.from(V1, "utf-8"));
    stat = { path: FILE, mtime: "2026-05-30T02:00:00.000Z", size: byteLen(V2) };

    const appendsBefore = (notion.client.appendChildren as ReturnType<typeof vi.fn>).mock.calls
      .length;
    const push3 = await orchestrator.push();
    expect(push3.updated, "재감지로 같은 갱신 1회 더 실행").toBe(1);
    expect(push3.failed).toEqual([]);

    // append 가 실제로 한 번 더 일어났다(no-op 으로 빠지지 않음 — 수렴을 진짜 시험).
    expect((notion.client.appendChildren as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      appendsBefore + 1,
    );

    // 핵심: 두 번째 실행 후에도 페이지는 V2 한 벌 그대로 — 중복 누적 0, 유실 0.
    expect(pageTexts()).toEqual([...v2Texts].sort());
    // 블록 총개수도 정확히 V2 개수(중복 검출의 수치 단언).
    expect([...notion.pages.values()].flat().length).toBe(v2Texts.length);
  });
});
