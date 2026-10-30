/**
 * 원격을 얼마나 훑었나 — pull · sync · status 가 함께 쓰는 문구 (ADR-027).
 *
 * 바뀐 것만 찾은 pull 은 Notion 에서 지운 노트를 아직 볼트에서 지우지 않는다. 그 사실과 언제 반영되는지를
 * 적지 않으면 사람은 «지웠는데 남았다» 를 결함으로 읽는다.
 */
import { describe, it, expect, vi } from "vitest";
import type { FullScanReason, RemoteScanInfo } from "@im-nobsidian/core";

vi.mock("chalk", () => {
  const passthrough = (s: string) => s;
  const fn = Object.assign(passthrough, {
    green: passthrough,
    yellow: passthrough,
    red: passthrough,
    blue: passthrough,
    cyan: passthrough,
    magenta: passthrough,
    dim: passthrough,
    bold: passthrough,
  });
  return { default: fn };
});

import {
  lastFullScanText,
  localDateTime,
  LISTED_ITEMS,
  readOnlySkipLines,
  remoteDeletionHint,
  restoredLines,
  schemaFollowedLines,
  renamedPropertyLines,
  schemaEditLines,
  heldSidecarLines,
  viewEditLines,
  placementChangeLines,
  databaseMoveLines,
  heldBaseLines,
  unsentDeletionLines,
  remoteScanLines,
  summary,
} from "../../src/utils/format.js";

/** 로컬 시각으로 만든 ISO — 시험을 도는 기계의 시간대와 무관하게 같은 글이 나온다. */
const localIso = (hour: number, minute: number, second = 0) =>
  new Date(2026, 8, 28, hour, minute, second).toISOString();

const incremental = (overrides: Partial<RemoteScanInfo> = {}): RemoteScanInfo => ({
  kind: "incremental",
  lastFullAt: localIso(10, 5),
  nextFullAt: localIso(11, 5),
  deletionsDeferred: true,
  ...overrides,
});

describe("localDateTime", () => {
  it("로컬 시각을 YYYY-MM-DD HH:MM:SS 로 적는다", () => {
    expect(localDateTime(localIso(9, 3, 7))).toBe("2026-09-28 09:03:07");
  });

  it("읽을 수 없는 값은 그대로 보인다 — NaN 으로 바꾸지 않는다", () => {
    expect(localDateTime("not-a-time")).toBe("not-a-time");
  });
});

describe("remoteScanLines", () => {
  it.each<[FullScanReason, string]>([
    ["first", "Full scan (first pull)"],
    ["forced", "Full scan (--force)"],
    ["database-mode", "Full scan (database mode)"],
    ["every-pull", "Full scan (every pull)"],
    ["due", "Full scan (scheduled)"],
  ])("전체 대조(%s)는 이유를 사람의 말로 한 줄", (reason, line) => {
    expect(
      remoteScanLines({
        kind: "full",
        reason,
        lastFullAt: localIso(10, 5),
        nextFullAt: null,
        deletionsDeferred: false,
      }),
    ).toEqual([line]);
  });

  it("바뀐 것만 찾았으면 건너뛴 DB 수와 원격 삭제가 반영되는 때를 적는다", () => {
    expect(remoteScanLines(incremental({ skippedDatabases: 3 }))).toEqual([
      "Changes-only scan · 3 unchanged databases skipped",
      "Deletions in Notion apply at the next full scan (2026-09-28 11:05:00) — or run nobsi pull --force",
    ]);
  });

  it("원격 삭제를 반영하지 않는 설정이면 삭제 안내를 붙이지 않는다 — 전체 대조도 지우지 않는다", () => {
    expect(remoteScanLines(incremental({ deletionsDeferred: false, skippedDatabases: 2 }))).toEqual(
      ["Changes-only scan · 2 unchanged databases skipped"],
    );
  });

  it.each([
    [1, "Changes-only scan · 1 unchanged database skipped"],
    [0, "Changes-only scan"],
    [undefined, "Changes-only scan"],
  ])("건너뛴 DB 가 %s 개면 «%s»", (skippedDatabases, line) => {
    expect(remoteScanLines(incremental({ skippedDatabases }))[0]).toBe(line);
  });
});

describe("remoteDeletionHint", () => {
  it("전체 대조가 이미 때가 됐으면 다음 pull 이 한다고 적는다", () => {
    expect(remoteDeletionHint(incremental({ nextFullAt: null }))).toBe(
      "Deletions in Notion apply at the next pull (full scan due) — or run nobsi pull --force",
    );
  });
});

describe("lastFullScanText", () => {
  it("마지막 전체 대조 시각 — 한 번도 없으면 never", () => {
    expect(lastFullScanText(localIso(10, 5))).toBe("2026-09-28 10:05:00");
    expect(lastFullScanText(null)).toBe("never");
  });
});

describe("readOnlySkipLines", () => {
  it("올리지 않은 읽기 전용 속성을 노트별로 — 다음 pull 이 되돌린다고 말한다", () => {
    expect(
      readOnlySkipLines([
        { path: "db/가.md", properties: ["합계", "ID"] },
        { path: "db/나.md", properties: ["합계"] },
      ]),
    ).toEqual([
      "⚠ 읽기 전용 속성 3개는 올리지 않았습니다 — Notion 이 값을 정합니다(수식 · 롤업 · ID …). 다음 pull 이 Notion 값으로 되돌립니다:",
      "  db/가.md — 합계, ID",
      "  db/나.md — 합계",
    ]);
  });

  it("dry-run 은 올리지 않을 것으로 말한다", () => {
    expect(readOnlySkipLines([{ path: "db/가.md", properties: ["합계"] }], true)[0]).toContain(
      "읽기 전용 속성 1개는 올리지 않습니다",
    );
  });

  it("없으면 아무 줄도 없다", () => {
    expect(readOnlySkipLines(undefined)).toEqual([]);
    expect(readOnlySkipLines([])).toEqual([]);
  });
});

describe("거절한 로컬 삭제 (D8)", () => {
  it("push — Notion 에서 지우지 않은 노트를 경로로, 다음 pull 이 되살린다고 말한다", () => {
    expect(unsentDeletionLines(["가.md", "db/나.md"])).toEqual([
      "⚠ 볼트에서 지운 노트 2개는 Notion 에서 지우지 않았습니다 (sync.deleteSync 꺼짐) — 다음 pull 이 Notion 에서 되살립니다. 지우려면 Notion 에서도 지우거나 deleteSync 를 켜세요:",
      "  가.md",
      "  db/나.md",
    ]);
    expect(unsentDeletionLines(["가.md"], true)[0]).toContain("Notion 에서 지우지 않습니다 ");
  });

  it("pull — 되살린 노트를 경로로 알린다", () => {
    expect(restoredLines(["가.md"])).toEqual([
      "⚠ 볼트에서 지운 노트 1개를 Notion 에서 되살렸습니다 — sync.deleteSync 가 꺼져 있어 볼트의 삭제는 Notion 에 보내지 않습니다:",
      "  가.md",
    ]);
    expect(restoredLines(["가.md"], true)[0]).toContain("되살립니다");
  });

  it("경로가 많으면 앞의 몇 개만 늘어놓고 나머지는 수로 — 없으면 아무 줄도 없다", () => {
    const paths = Array.from({ length: LISTED_ITEMS + 3 }, (_, i) => `노트 ${i}.md`);
    const lines = restoredLines(paths);
    expect(lines).toHaveLength(1 + LISTED_ITEMS + 1);
    expect(lines[lines.length - 1]).toBe("  … 외 3개");
    expect(restoredLines(undefined)).toEqual([]);
    expect(unsentDeletionLines([])).toEqual([]);
  });
});

describe("renamedPropertyLines — 볼트에서 바꾼 속성 이름을 Notion 열에 옮긴 것 (ADR-045)", () => {
  it("DB 폴더와 바꾼 이름을 한 줄씩, dry-run 은 옮길 것으로", () => {
    const renames = [{ folder: "databases/할 일", from: "점수", to: "점수표" }];
    expect(renamedPropertyLines(renames)).toEqual([
      "✓ 볼트에서 바꾼 속성 이름을 Notion 열에 옮겼습니다 — databases/할 일: 점수 → 점수표",
    ]);
    expect(renamedPropertyLines(renames, true)).toEqual([
      "✓ 볼트에서 바꾼 속성 이름을 Notion 열에 옮깁니다 — databases/할 일: 점수 → 점수표",
    ]);
    expect(renamedPropertyLines(undefined)).toEqual([]);
  });
});

describe("schemaEditLines · heldSidecarLines — 사이드카에서 고친 속성 (ADR-045)", () => {
  it("사이드카마다 한 일을 한 줄로, 덮어쓰지 않은 것은 경고와 경로로", () => {
    expect(
      schemaEditLines([
        {
          path: "할 일/할 일.notion.json",
          added: ["마감"],
          removed: ["메모"],
          renamed: [["점수", "점수표"]],
          retyped: [["상태", "select"]],
          redefined: ["두배"],
        },
      ]),
    ).toEqual([
      "✓ 사이드카에서 고친 속성을 Notion 에 올렸습니다 — 할 일/할 일.notion.json: 더함 마감 · 지움 메모 · 이름 점수 → 점수표 · 타입 상태 → select · 설정 두배",
    ]);
    expect(
      schemaEditLines(
        [
          {
            path: "a.notion.json",
            added: [],
            removed: [],
            renamed: [],
            retyped: [],
            redefined: ["상태"],
            droppedOptions: [["상태", ["끝"]]],
            renamedOptions: [["상태", "진행", "진행중"]],
          },
        ],
        true,
      ),
    ).toEqual([
      "✓ 사이드카에서 고친 속성을 Notion 에 올립니다 — a.notion.json: 설정 상태 · 상태 옵션 이름 진행 → 진행중(그 값을 가진 행도 옮깁니다) · 상태 옵션 지움 끝(그 값을 가진 행은 Notion 에서 빈 값이 됩니다)",
    ]);
    expect(heldSidecarLines(["할 일/할 일.notion.json"])).toEqual([
      "⚠ 고친 사이드카 1개는 덮어쓰지 않았습니다 — push 하면 고친 속성을 Notion 에 올립니다:",
      "  할 일/할 일.notion.json",
    ]);
    expect(heldSidecarLines(undefined)).toEqual([]);
  });
});

describe("schemaFollowedLines — Notion 에서 바뀐 속성을 행 노트에 옮긴 것 (ADR-045)", () => {
  it("DB 마다 바꾼 이름 · 지운 속성과 노트 수, 남긴 값은 경고와 경로로", () => {
    expect(
      schemaFollowedLines([
        {
          folder: "databases/할 일",
          renamed: [["점수", "점수표"]],
          removed: ["메모"],
          rows: 2,
          kept: [{ path: "databases/할 일/가.md", key: "메모" }],
        },
      ]),
    ).toEqual([
      "✓ Notion 에서 바뀐 속성을 행 노트 2개에 옮겼습니다 — databases/할 일: 이름 점수 → 점수표 · 지움 메모",
      "⚠ Notion 에서 지운 속성에 올리지 않은 값이 있어 노트에 남겼습니다 — Notion 에는 그 열이 없습니다:",
      "  databases/할 일/가.md (메모)",
    ]);
    expect(schemaFollowedLines(undefined)).toEqual([]);
  });
});

describe("viewEditLines · heldBaseLines — .base 에서 고친 보기 (ADR-046)", () => {
  it("보기마다 한 일을 내부 키 없이 한 줄로, 덮어쓰지 않은 것은 경고와 경로로", () => {
    expect(
      viewEditLines(
        [
          { path: "할 일/할 일.base", view: "점수표", from: "표", changed: ["name", "columns"] },
          { path: "할 일/할 일.base", view: "보드", changed: ["sort", "filter"] },
        ],
        true,
      ),
    ).toEqual([
      "✓ .base 에서 고친 보기를 Notion 에 올립니다 — 할 일/할 일.base: 표 → 점수표 (이름 · 열)",
      "✓ .base 에서 고친 보기를 Notion 에 올립니다 — 할 일/할 일.base: 보드 (정렬 · 필터)",
    ]);
    expect(heldBaseLines(["할 일/할 일.base"])).toEqual([
      "⚠ 보기를 고친 .base 1개는 덮어쓰지 않았습니다 — push 하면 고친 보기 이름 · 열 · 정렬 · 필터를 Notion 에 올립니다:",
      "  할 일/할 일.base",
    ]);
    expect(heldBaseLines([])).toEqual([]);
  });
});

describe("summary — Notion DB 에 올린 것", () => {
  it("보기 · 속성만 올린 push 를 「no changes」 로 적지 않는다", () => {
    expect(summary(0, 0, 0, 0, 2)).toBe("2 DB changes");
    expect(summary(1, 0, 0, 0, 1)).toBe("1 created  1 DB changes");
    expect(summary(0, 0, 0)).toBe("no changes");
  });
});

describe("placementChangeLines — 옮겨서 행 · 페이지가 된 노트 (ADR-047)", () => {
  it("무엇이 되었는지와 대상 DB 에 더해질 열을 한 줄로", () => {
    expect(
      placementChangeLines(
        [
          { path: "할 일/메모.md", becomes: "row", addedColumns: ["상태", "태그 1"] },
          { path: "노트/메모2.md", becomes: "page" },
        ],
        true,
      ),
    ).toEqual([
      "✓ Notion 에서 DB 의 행으로 옮깁니다 — 할 일/메모.md — 대상 DB 에 더해질 열: 상태, 태그 1",
      "✓ Notion 에서 페이지로 옮깁니다 — 노트/메모2.md",
    ]);
    expect(placementChangeLines([{ path: "a.md", becomes: "row" }])).toEqual([
      "✓ Notion 에서 DB 의 행으로 옮겼습니다 — a.md",
    ]);
    expect(placementChangeLines(undefined)).toEqual([]);
  });
});

describe("databaseMoveLines — 옮긴 DB 폴더 (ADR-047)", () => {
  it("Notion 의 DB 도 옮겼는지 · 볼트 쪽만인지 한 줄로", () => {
    expect(databaseMoveLines([{ from: "A/표", to: "B/표" }], true)).toEqual([
      "✓ DB 폴더를 옮깁니다 — A/표 → B/표 (Notion 의 DB 도 함께)",
    ]);
    expect(
      databaseMoveLines([
        { from: "A/표", to: "B/표", inNotion: true },
        { from: "databases/밖", to: "B/밖", inNotion: false },
      ]),
    ).toEqual([
      "✓ Notion 의 DB 도 옮겼습니다 — A/표 → B/표",
      "⚠ DB 폴더를 옮겼습니다 — databases/밖 → B/밖 (Notion 의 DB 는 볼트가 받지 않는 곳에 있어 그대로)",
    ]);
    expect(databaseMoveLines(undefined)).toEqual([]);
  });
});
