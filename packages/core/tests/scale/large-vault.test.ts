/**
 * 큰 볼트 측정 (P10) — 평소 시험에서는 건너뛴다. `SCALE_N=1000,5000 npx vitest run tests/scale` 로 돈다.
 *
 * 메모리 Notion 이라 Notion 의 응답 시간은 없다 — 재는 것은 «로컬 처리» 가 노트 수에 비례하는지(O(N²) 이 숨어 있지
 * 않은지)와 단계마다 부르는 Notion API 수다. 실제 시간은 API 수 ÷ 초당 3 회(공용 한도)가 아래에서 받친다.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { mkdtemp, mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { NodeVaultFS } from "../../src/sync/node-vault-fs.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { LAST_FULL_PULL_META_KEY } from "../../src/sync/remote-scan.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { memoryNotion } from "../helpers/memory-sync.js";

const SIZES = (process.env.SCALE_N ?? "")
  .split(",")
  .map(Number)
  .filter((n) => n > 0);
const ROOT = "root-page-id";
const FOLDERS = 20;

/** 합성 노트 — 제목 · 목록 · 표 · 코드 · 인용 · 다른 노트 링크 둘(scratchpad 의 gen.py 와 같은 모양). */
function note(i: number, n: number): string {
  const a = (i * 7919 + 13) % n;
  const b = (i * 104729 + 7) % n;
  return [
    "---",
    `tags: [합성, 묶음${i % 7}]`,
    "---",
    `# 노트 ${String(i).padStart(5, "0")}`,
    "",
    `큰 볼트 측정용 합성 노트. [[노트 ${String(a).padStart(5, "0")}]] 와 [[노트 ${String(b).padStart(5, "0")}]] 를 가리킨다.`,
    "",
    "## 할 일",
    `- [ ] 첫째 ${i}`,
    "- [x] 둘째",
    "- 그냥 항목 **굵게** *기울임* `코드`",
    "",
    "| 열 | 값 |",
    "| --- | --- |",
    `| 번호 | ${i} |`,
    "",
    "```python",
    `print(${i})`,
    "```",
    "",
    `> 인용 한 줄 ${i}`,
    "",
    `마지막 문단. ${"가나다라마바사 ".repeat(8)}`,
    "",
  ].join("\n");
}

describe.skipIf(SIZES.length === 0)("큰 볼트 (P10)", () => {
  const rows: string[] = [];
  afterAll(() => console.log(["", "N\t단계\t초\tAPI\t힙MB\t결과", ...rows].join("\n")));

  for (const n of SIZES) {
    describe(`${n} 노트`, () => {
      let vaultDir: string;
      let stateDir: string;
      let db: StateDB;
      let notion: ReturnType<typeof memoryNotion>;

      beforeAll(async () => {
        vaultDir = await mkdtemp(join(tmpdir(), "im-nobsidian-scale-vault-"));
        stateDir = await mkdtemp(join(tmpdir(), "im-nobsidian-scale-state-"));
        db = StateDB.open(join(stateDir, "state.db"));
        notion = memoryNotion();
        // 추적 페이지가 순회 예산을 넘으면 실제처럼 워크스페이스 search 로 찾는다 — 같은 페이지 목록을 준다
        const walk = notion.client.getChildPagesRecursive.getMockImplementation()!;
        notion.client.getPagesUnderRootViaSearch.mockImplementation((root: string) => walk(root));
        for (let f = 0; f < FOLDERS; f++) await mkdir(join(vaultDir, `영역${f}`));
        for (let i = 0; i < n; i++) {
          await writeFile(
            join(vaultDir, `영역${i % FOLDERS}`, `노트 ${String(i).padStart(5, "0")}.md`),
            note(i, n),
          );
        }
      });
      afterAll(async () => {
        db.close();
        await rm(vaultDir, { recursive: true, force: true });
        await rm(stateDir, { recursive: true, force: true });
      });

      const orchestrator = (fullReconcileInterval = 0) =>
        new SyncOrchestrator(
          createConfig({
            notion: { token: "ntn_test_token", rootPageId: ROOT, databases: [] },
            // 지운 것 반대쪽에서도 지우기 — 플러그인 기본값. 증분 pull 이 삭제 확인을 돈다
            sync: { ...DEFAULT_CONFIG.sync, fullReconcileInterval, deleteSync: true },
            advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
          }),
          db,
          notion.client as never,
          new NodeVaultFS(vaultDir),
        );
      const apiCalls = (): Map<string, number> =>
        new Map(
          Object.entries(notion.client)
            .filter(([, fn]) => typeof fn === "function" && "mock" in fn)
            .map(([name, fn]) => [name, (fn as { mock: { calls: unknown[] } }).mock.calls.length]),
        );
      const measure = async (label: string, run: () => Promise<unknown>) => {
        const before = apiCalls();
        const started = performance.now();
        const result = await run();
        const seconds = (performance.now() - started) / 1000;
        const after = apiCalls();
        const used = [...after].map(
          ([name, count]) => [name, count - (before.get(name) ?? 0)] as const,
        );
        // 부르는 것만 센다 — extract* 같은 응답 해석은 요청이 아니다
        const requests = used
          .filter(([name, count]) => count > 0 && !/^(extract|is|to|parse)/.test(name))
          .sort((x, y) => y[1] - x[1]);
        const total = requests.reduce((sum, [, count]) => sum + count, 0);
        const heap = Math.round(process.memoryUsage().heapUsed / 2 ** 20);
        const summary = JSON.stringify(result, (key, value) =>
          Array.isArray(value) ? value.length : value,
        ).slice(0, 160);
        rows.push(`${n}\t${label}\t${seconds.toFixed(2)}\t${total}\t${heap}\t${summary}`);
        rows.push(
          `\t\t\t\t\t  ${requests
            .slice(0, 6)
            .map(([name, count]) => `${name} ${count}`)
            .join(" · ")}`,
        );
        return result;
      };

      it("첫 push · 변경 없음 · 받기 · 증분 · 전체 대조", { timeout: 600_000 }, async () => {
        const first = (await measure("push 첫", () => orchestrator().push())) as {
          created: number;
          failed: unknown[];
        };
        expect(first.failed).toEqual([]);
        expect(first.created).toBeGreaterThanOrEqual(n);
        await measure("status 로컬", () => orchestrator().statusLocal());
        const again = (await measure("push 변경 없음", () => orchestrator().push())) as {
          created: number;
          updated: number;
        };
        expect([again.created, again.updated]).toEqual([0, 0]);
        await measure("pull 첫(전체)", () => orchestrator(86_400_000).pull());
        await measure("pull 증분 변경 없음", () => orchestrator(86_400_000).pull());
        // 주기(fullReconcileInterval)가 돌린 전체 대조 — 자식 DB 를 다시 훑지 않는다(`--force` 와 다르다)
        db.setMeta(LAST_FULL_PULL_META_KEY, "2000-01-01T00:00:00.000Z");
        await measure("pull 주기 전체 대조", () => orchestrator(3600).pull());
        for (const i of [3, Math.floor(n / 3), Math.floor((2 * n) / 3)]) {
          await appendFile(
            join(vaultDir, `영역${i % FOLDERS}`, `노트 ${String(i).padStart(5, "0")}.md`),
            "고침\n",
          );
        }
        const edited = (await measure("push 3 노트 고침", () => orchestrator().push())) as {
          updated: number;
        };
        expect(edited.updated).toBe(3);
        await measure("pull --force 전체 대조", () =>
          orchestrator(86_400_000).pull({ force: true }),
        );
        await measure("status --full", () => orchestrator().status());
      });
    });
  }
});
