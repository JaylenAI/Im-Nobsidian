/**
 * 큰 볼트의 플러그인 상태 DB (P10) — 평소 시험에서는 건너뛴다. `SCALE_N=1000,5000 npx vitest run tests/scale`.
 *
 * sql.js 는 DB 를 메모리에 두고 바뀌면 5초마다 통째로 내보내 파일에 쓴다. 노트가 많을수록 한 번 쓰는 값이 커진다 —
 * 그 크기 · 내보내는 시간 · 경로 조회 시간을 잰다. 지난 사본(baseSnapshot)은 노트 글 그대로다(합성 노트 ~1KB).
 */
import { describe, it, expect, afterAll } from "vitest";
import { SqlJsStateDB } from "../../src/state/sqljs-state-db.js";

const SIZES = (process.env.SCALE_N ?? "")
  .split(",")
  .map(Number)
  .filter((n) => n > 0);

describe.skipIf(SIZES.length === 0)("큰 볼트의 플러그인 상태 DB (P10)", () => {
  const rows: string[] = [];
  afterAll(() =>
    console.log(
      ["", "N\t파일MB\t내보내기ms\t열기ms\t경로조회ms(1000회)\t전체읽기ms", ...rows].join("\n"),
    ),
  );

  for (const n of SIZES) {
    it(`${n} 노트`, async () => {
      const db = await SqlJsStateDB.open();
      const snapshot = Buffer.from(`# 노트\n\n${"가나다라마바사 합성 본문 ".repeat(60)}\n`);
      db.transaction(() => {
        for (let i = 0; i < n; i++) {
          db.upsert({
            obsidianPath: `영역${i % 20}/노트 ${String(i).padStart(5, "0")}.md`,
            notionPageId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
            notionParentId: null,
            contentHash: `hash-${i}`,
            notionLastEdited: "2026-10-31T00:00:00.000Z",
            localLastModified: "2026-10-31T00:00:00.000Z",
            syncDirection: "both",
            fileType: "file",
            status: "synced",
            baseSnapshot: snapshot,
            localMtime: null,
            localFileSize: null,
          });
        }
      });
      const t0 = performance.now();
      const data = db.export();
      const exportMs = performance.now() - t0;
      db.close();
      const t1 = performance.now();
      const reopened = await SqlJsStateDB.open(data);
      const openMs = performance.now() - t1;
      const t2 = performance.now();
      for (let i = 0; i < 1000; i++) {
        reopened.getByPath(`영역${i % 20}/노트 ${String((i * 37) % n).padStart(5, "0")}.md`);
      }
      const lookupMs = performance.now() - t2;
      const t3 = performance.now();
      expect(reopened.getAll()).toHaveLength(n);
      const allMs = performance.now() - t3;
      reopened.close();
      rows.push(
        `${n}\t${(data.byteLength / 2 ** 20).toFixed(1)}\t${exportMs.toFixed(0)}\t${openMs.toFixed(0)}\t${lookupMs.toFixed(0)}\t${allMs.toFixed(0)}`,
      );
    });
  }
});
