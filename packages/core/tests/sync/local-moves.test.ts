/**
 * S-11 — 로컬에서 옮기거나 이름을 바꾼 노트를 추적 레코드와 다시 짝짓는 규칙.
 */
import { describe, it, expect } from "vitest";
import {
  EMPTY_RENAME_HINTS,
  deriveFolderMoves,
  foldersOf,
  forgetRenameHint,
  hintedFolderTarget,
  hintedOrigin,
  moveOrigin,
  movePayload,
  pairLocalMoves,
  parseRenameHints,
  pendingMoveOrigins,
  pruneRenameHints,
  recordRenameHint,
  type RenameHints,
  type RenameKind,
} from "../../src/sync/local-moves.js";

/** 이벤트를 차례로 적은 힌트. */
function replay(...events: Array<[string, string, RenameKind]>): RenameHints {
  return events.reduce(
    (hints, [from, to, kind]) => recordRenameHint(hints, from, to, kind),
    EMPTY_RENAME_HINTS,
  );
}

describe("recordRenameHint — rename 이벤트를 «지금 경로 → 옛 경로» 로", () => {
  it("파일 이름 변경", () => {
    expect(replay(["a.md", "b.md", "file"]).files).toEqual({ "b.md": "a.md" });
  });

  it("연달아 바꾸면 처음 경로를 남긴다", () => {
    expect(replay(["a.md", "b.md", "file"], ["b.md", "c.md", "file"]).files).toEqual({
      "c.md": "a.md",
    });
  });

  it("되돌리면 힌트가 사라진다", () => {
    expect(replay(["a.md", "b.md", "file"], ["b.md", "a.md", "file"]).files).toEqual({});
  });

  it("폴더를 바꾸면 그 아래 파일 힌트도 따라간다", () => {
    const hints = replay(["A/w.md", "A/x.md", "file"], ["A", "B", "folder"]);
    expect(hints.files).toEqual({ "B/x.md": "A/w.md" });
    expect(hints.folders).toEqual({ B: "A" });
  });

  it("폴더를 바꾼 뒤 하위 파일 이벤트가 또 와도 한 번 적은 것과 같다 — 순서 무관", () => {
    const folderFirst = replay(
      ["A/w.md", "A/x.md", "file"],
      ["A", "B", "folder"],
      ["A/x.md", "B/x.md", "file"],
    );
    const filesFirst = replay(
      ["A/w.md", "A/x.md", "file"],
      ["A/x.md", "B/x.md", "file"],
      ["A", "B", "folder"],
    );
    expect(folderFirst.files).toEqual({ "B/x.md": "A/w.md" });
    expect(filesFirst.files).toEqual({ "B/x.md": "A/w.md" });
    expect(folderFirst.folders).toEqual({ B: "A" });
    expect(filesFirst.folders).toEqual({ B: "A" });
  });

  it("하위 폴더 이벤트가 또 와도 앞서 적은 하위 폴더 힌트를 덮지 않는다", () => {
    const hints = replay(["A/T", "A/S", "folder"], ["A", "B", "folder"], ["A/S", "B/S", "folder"]);
    expect(hints.folders).toEqual({ B: "A", "B/S": "A/T" });
  });

  it("폴더를 되돌리면 폴더 힌트와 하위 힌트가 제자리로", () => {
    const hints = replay(["A/w.md", "A/x.md", "file"], ["A", "B", "folder"], ["B", "A", "folder"]);
    expect(hints.folders).toEqual({});
    expect(hints.files).toEqual({ "A/x.md": "A/w.md" });
  });

  it("바꾼 폴더 안에서 다시 바꾼 파일 · 폴더는 옛 폴더 기준 경로를 남긴다", () => {
    const hints = replay(
      ["A", "B", "folder"],
      ["B/x.md", "B/y.md", "file"],
      ["B/sub", "B/sub2", "folder"],
    );
    expect(hints.files).toEqual({ "B/y.md": "A/x.md" });
    expect(hints.folders).toEqual({ B: "A", "B/sub2": "A/sub" });
  });

  it("같은 경로로의 이벤트는 무시한다", () => {
    expect(replay(["a.md", "a.md", "file"])).toEqual(EMPTY_RENAME_HINTS);
  });
});

describe("hintedOrigin · forgetRenameHint · pruneRenameHints", () => {
  const hints = replay(
    ["A", "B", "folder"],
    ["B/sub", "B/sub2", "folder"],
    ["x.md", "y.md", "file"],
  );

  it("파일 힌트, 없으면 가장 깊은 폴더 힌트로 옛 경로를 되짚는다", () => {
    expect(hintedOrigin(hints, "y.md")).toBe("x.md");
    expect(hintedOrigin(hints, "B/sub2/n.md")).toBe("A/sub/n.md");
    expect(hintedOrigin(hints, "B/n.md")).toBe("A/n.md");
    expect(hintedOrigin(hints, "C/n.md")).toBeNull();
  });

  it("지운 파일 · 폴더의 힌트를 버린다", () => {
    expect(forgetRenameHint(hints, "y.md").files).toEqual({});
    expect(forgetRenameHint(hints, "B").folders).toEqual({});
    expect(forgetRenameHint(hints, "B/sub2").folders).toEqual({ B: "A" });
  });

  it("쓴 힌트만 지운다 — 그 뒤 새로 적히거나 바뀐 항목은 남긴다", () => {
    const used = replay(["a.md", "b.md", "file"], ["m.md", "n.md", "file"]);
    const now = recordRenameHint(
      recordRenameHint(used, "n.md", "o.md", "file"),
      "p.md",
      "q.md",
      "file",
    );
    expect(pruneRenameHints(now, used).files).toEqual({ "o.md": "m.md", "q.md": "p.md" });
  });

  it("상태 메타가 없거나 깨졌으면 빈 힌트", () => {
    expect(parseRenameHints(null)).toEqual(EMPTY_RENAME_HINTS);
    expect(parseRenameHints("{broken")).toEqual(EMPTY_RENAME_HINTS);
    expect(parseRenameHints(JSON.stringify({ files: { "b.md": 3 }, folders: [] }))).toEqual(
      EMPTY_RENAME_HINTS,
    );
    expect(parseRenameHints(JSON.stringify(hints))).toEqual(hints);
  });
});

describe("pairLocalMoves — 없어진 추적 노트 ↔ 추적하지 않는 파일", () => {
  it("힌트가 있으면 내용이 바뀌어도 짝이다", () => {
    const pairs = pairLocalMoves(
      [{ path: "a.md", hash: "h-old" }],
      [{ path: "b.md", hash: "h-new" }],
      replay(["a.md", "b.md", "file"]),
    );
    expect(pairs).toEqual([{ from: "a.md", to: "b.md" }]);
  });

  it("폴더 힌트로 하위 노트를 짝짓는다", () => {
    const pairs = pairLocalMoves(
      [{ path: "A/n.md", hash: "h1" }],
      [{ path: "B/n.md", hash: "h2" }],
      replay(["A", "B", "folder"]),
    );
    expect(pairs).toEqual([{ from: "A/n.md", to: "B/n.md" }]);
  });

  it("힌트가 없으면 같은 내용끼리 — 같은 파일 이름을 먼저", () => {
    const pairs = pairLocalMoves(
      [{ path: "old/노트.md", hash: "same" }],
      [
        { path: "a/다른.md", hash: "same" },
        { path: "z/노트.md", hash: "same" },
      ],
      EMPTY_RENAME_HINTS,
    );
    expect(pairs).toEqual([{ from: "old/노트.md", to: "z/노트.md" }]);
  });

  it("같은 내용이 여럿이면 경로 순으로 정해 매번 같다", () => {
    const missing = [
      { path: "b.md", hash: "empty" },
      { path: "a.md", hash: "empty" },
    ];
    const untracked = [
      { path: "y.md", hash: "empty" },
      { path: "x.md", hash: "empty" },
    ];
    expect(pairLocalMoves(missing, untracked, EMPTY_RENAME_HINTS)).toEqual([
      { from: "a.md", to: "x.md" },
      { from: "b.md", to: "y.md" },
    ]);
  });

  it("내용도 다르고 힌트도 없으면 짝이 아니다", () => {
    expect(
      pairLocalMoves(
        [{ path: "a.md", hash: "h1" }],
        [{ path: "b.md", hash: "h2" }],
        EMPTY_RENAME_HINTS,
      ),
    ).toEqual([]);
  });

  it("입양해 둔 이동을 원래 자리로 되돌리면 짝이다 — 내용을 고쳤어도", () => {
    const pairs = pairLocalMoves(
      [{ path: "b.md", hash: "h1", origin: "a.md" }],
      [{ path: "a.md", hash: "h2" }],
      EMPTY_RENAME_HINTS,
    );
    expect(pairs).toEqual([{ from: "b.md", to: "a.md" }]);
  });

  it("힌트의 옛 경로가 입양해 둔 이동의 옛 자리여도 찾는다", () => {
    // a → b 를 입양한 뒤 힌트(b ← a)를 치우기 전에 다시 c 로 바꿨다(c ← a).
    const pairs = pairLocalMoves(
      [{ path: "b.md", hash: "h1", origin: "a.md" }],
      [{ path: "c.md", hash: "h2" }],
      replay(["a.md", "b.md", "file"], ["b.md", "c.md", "file"]),
    );
    expect(pairs).toEqual([{ from: "b.md", to: "c.md" }]);
  });

  it("한 노트는 한 파일과만 — 힌트가 먼저 가져간 노트는 내용으로 또 짝짓지 않는다", () => {
    const pairs = pairLocalMoves(
      [{ path: "a.md", hash: "same" }],
      [
        { path: "b.md", hash: "other" },
        { path: "c.md", hash: "same" },
      ],
      replay(["a.md", "b.md", "file"]),
    );
    expect(pairs).toEqual([{ from: "a.md", to: "b.md" }]);
  });
});

describe("deriveFolderMoves — 옮겨진 추적 폴더와 새 자리", () => {
  it("노트들의 짝이 모두 같은 폴더를 가리키면 그 폴더로", () => {
    const moves = deriveFolderMoves(
      ["Docs"],
      new Set(["Documents"]),
      [
        { from: "Docs/a.md", to: "Documents/a.md" },
        { from: "Docs/sub/b.md", to: "Documents/sub/b.md" },
      ],
      EMPTY_RENAME_HINTS,
    );
    expect(moves).toEqual([{ from: "Docs", to: "Documents" }]);
  });

  it("폴더가 아직 있으면 옮긴 것이 아니다", () => {
    const moves = deriveFolderMoves(
      ["Docs"],
      new Set(["Docs", "Other"]),
      [{ from: "Docs/a.md", to: "Other/a.md" }],
      EMPTY_RENAME_HINTS,
    );
    expect(moves).toEqual([]);
  });

  it("노트들이 여러 폴더로 흩어졌으면 옮기지 않는다", () => {
    const moves = deriveFolderMoves(
      ["Docs"],
      new Set(["X", "Y"]),
      [
        { from: "Docs/a.md", to: "X/a.md" },
        { from: "Docs/b.md", to: "Y/b.md" },
      ],
      EMPTY_RENAME_HINTS,
    );
    expect(moves).toEqual([]);
  });

  it("이름까지 바꾼 노트의 짝은 폴더를 정하는 데 쓰지 않는다", () => {
    const moves = deriveFolderMoves(
      ["Docs"],
      new Set(["Documents", "Elsewhere"]),
      [
        { from: "Docs/a.md", to: "Documents/a.md" },
        { from: "Docs/b.md", to: "Elsewhere/c.md" },
      ],
      EMPTY_RENAME_HINTS,
    );
    expect(moves).toEqual([{ from: "Docs", to: "Documents" }]);
  });

  it("폴더 힌트가 짝보다 먼저다 — 하위 폴더도 힌트로", () => {
    const hints = replay(["A", "B", "folder"]);
    const moves = deriveFolderMoves(["A", "A/sub"], new Set(["B", "B/sub"]), [], hints);
    expect(moves).toEqual([
      { from: "A", to: "B" },
      { from: "A/sub", to: "B/sub" },
    ]);
  });

  it("새 자리가 볼트에 없거나 두 폴더가 한 자리로 가면 옮기지 않는다", () => {
    expect(deriveFolderMoves(["A"], new Set(), [], replay(["A", "B", "folder"]))).toEqual([]);
    const moves = deriveFolderMoves(
      ["P", "Q"],
      new Set(["R"]),
      [
        { from: "P/a.md", to: "R/a.md" },
        { from: "Q/b.md", to: "R/b.md" },
      ],
      EMPTY_RENAME_HINTS,
    );
    expect(moves).toEqual([]);
  });
});

describe("foldersOf · 이동 WAL payload", () => {
  it("노트가 든 폴더를 조상까지 모은다", () => {
    expect([...foldersOf(["A/B/c.md", "A/d.md", "e.md"])].sort()).toEqual(["A", "A/B"]);
  });

  it("payload 의 옛 경로 — 읽지 못하면 null", () => {
    expect(moveOrigin(movePayload("a/b.md"))).toBe("a/b.md");
    expect(moveOrigin(null)).toBeNull();
    expect(moveOrigin("{broken")).toBeNull();
    expect(moveOrigin(JSON.stringify({ from: "" }))).toBeNull();
  });
});

describe("hintedFolderTarget · pendingMoveOrigins", () => {
  it("폴더 힌트가 가리키는 새 자리 — 가장 깊은 힌트 기준, 하위 폴더도", () => {
    const hints = replay(["A", "B", "folder"], ["B/sub", "B/deep", "folder"]);
    expect(hintedFolderTarget(hints, "A")).toBe("B");
    expect(hintedFolderTarget(hints, "A/sub")).toBe("B/deep");
    expect(hintedFolderTarget(hints, "A/other")).toBe("B/other");
    expect(hintedFolderTarget(hints, "C")).toBeNull();
  });

  it("두 힌트가 같은 옛 폴더를 가리키면 새 자리를 모른다", () => {
    const hints: RenameHints = { files: {}, folders: { X: "A", Y: "A" } };
    expect(hintedFolderTarget(hints, "A")).toBeNull();
  });

  it("미완료 WAL 가운데 push 쪽 이동만 — 옛 경로를 읽지 못하면 뺀다", () => {
    const origins = pendingMoveOrigins([
      { syncStateId: "r1", operation: "move", direction: "push", payload: movePayload("a.md") },
      { syncStateId: "r2", operation: "create", direction: "push", payload: movePayload("b.md") },
      { syncStateId: "r3", operation: "move", direction: "pull", payload: movePayload("c.md") },
      { syncStateId: "r4", operation: "move", direction: "push", payload: "{broken" },
    ]);
    expect([...origins]).toEqual([["r1", "a.md"]]);
  });
});
