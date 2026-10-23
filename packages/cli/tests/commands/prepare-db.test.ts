import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

const { mockPrepare, mockClose } = vi.hoisted(() => ({
  mockPrepare: vi.fn(),
  mockClose: vi.fn(),
}));

vi.mock("@im-nobsidian/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@im-nobsidian/core")>()),
  ConfigManager: vi.fn().mockImplementation(() => ({
    dbPath: "/mock/sync.db",
    load: vi.fn().mockResolvedValue({ notion: { token: "ntn_test" }, paths: {} }),
  })),
  StateDB: { open: vi.fn().mockReturnValue({ close: mockClose }) },
  NotionClient: Object.assign(
    vi.fn().mockImplementation(() => ({})),
    { fromConfig: vi.fn().mockReturnValue({}) },
  ),
  SyncOrchestrator: vi.fn().mockImplementation(() => ({ prepareFolderDatabase: mockPrepare })),
  findConnectionFolders: vi.fn().mockResolvedValue([]),
  ScopedVaultFS: vi.fn(),
  NodeVaultFS: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("chalk", () => {
  const passthrough = (s: string) => s;
  const fn = Object.assign(passthrough, {
    green: passthrough,
    yellow: passthrough,
    red: passthrough,
    cyan: passthrough,
    magenta: passthrough,
    dim: passthrough,
    bold: passthrough,
  });
  return { default: fn };
});

import { prepareDbCommand } from "../../src/commands/prepare-db.js";

function run(...args: string[]) {
  const program = new Command();
  prepareDbCommand.exitOverride();
  program.addCommand(prepareDbCommand);
  return program.parseAsync(["node", "cli", "prepare-db", ...args]);
}

describe("prepare-db command", () => {
  let lines: string[];
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockPrepare.mockReset();
    mockClose.mockClear();
    lines = [];
    log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    process.exitCode = undefined;
  });

  afterEach(() => {
    log.mockRestore();
    process.exitCode = undefined;
  });

  it("사이드카 자리 · 정한 속성과 까닭 · 옮기지 않은 것을 보인다", async () => {
    mockPrepare.mockResolvedValue({
      folder: "Books",
      sidecarPath: "Books/Books.notion.json",
      rows: 3,
      properties: [{ name: "별점", type: "number", reason: "값 3개가 모두 수" }],
      views: ["전체"],
      skipped: [{ what: "보기 표지 의 필터", reason: "Bases 식은 Notion 필터로 바꾸지 못한다" }],
    });

    await run("Books");

    // Obsidian 설정 폴더는 위로 올라가 찾는다 — 연결 폴더가 볼트 안쪽이어도 속성 타입을 읽는다(ADR-038).
    expect(mockPrepare).toHaveBeenCalledWith("Books", expect.stringMatching(/\.obsidian$/));
    expect(lines).toEqual([
      "  ✓ Books/Books.notion.json — 행 3개",
      "    별점: number (값 3개가 모두 수)",
      "    보기: 전체",
      "    옮기지 않음 — 보기 표지 의 필터: Bases 식은 Notion 필터로 바꾸지 못한다",
      "  타입을 바꾸려면 사이드카를 고친 뒤 push 하세요.",
    ]);
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("거절한 까닭을 그대로 보이고 실패 종료 코드를 남긴다", async () => {
    mockPrepare.mockRejectedValue(new Error("이미 DB 사이드카가 있다: Books/Books.notion.json"));

    await run("Books");

    expect(lines).toEqual(["  ✕ Books: 이미 DB 사이드카가 있다: Books/Books.notion.json"]);
    expect(process.exitCode).toBe(1);
    expect(mockClose).toHaveBeenCalledOnce();
  });
});
