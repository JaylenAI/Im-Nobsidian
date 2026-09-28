import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

const { mockDiscard, mockClose } = vi.hoisted(() => ({
  mockDiscard: vi.fn(),
  mockClose: vi.fn(),
}));

// 무거운 것만 갈아 끼우고 나머지 core export 는 원본을 그대로 편다(resolve.test.ts 와 같다).
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
  SyncOrchestrator: vi.fn().mockImplementation(() => ({ discardLocalChange: mockDiscard })),
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

import { discardCommand } from "../../src/commands/discard.js";

function runDiscard(...args: string[]) {
  const program = new Command();
  // 인자 오류에 process.exit 대신 던진다 — addCommand 한 하위 명령은 부모 설정을 물려받지 않는다.
  discardCommand.exitOverride();
  program.addCommand(discardCommand);
  return program.parseAsync(["node", "cli", "discard", ...args]);
}

describe("discard command", () => {
  let lines: string[];
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockDiscard.mockReset().mockResolvedValue(undefined);
    mockClose.mockClear();
    lines = [];
    log = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    process.exitCode = undefined;
  });

  afterEach(() => {
    // restoreAllMocks 는 core 목(ConfigManager 등)의 구현까지 지운다 — 건 스파이만 푼다.
    log.mockRestore();
    process.exitCode = undefined;
  });

  it("고른 노트를 차례로 되돌리고 경로마다 알린다", async () => {
    await runDiscard("notes/a.md", "b.md");

    expect(mockDiscard.mock.calls).toEqual([["notes/a.md"], ["b.md"]]);
    expect(lines).toEqual(["  ✓ notes/a.md", "  ✓ b.md"]);
    expect(process.exitCode).toBeUndefined();
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("되돌리지 못한 노트는 이유를 그대로 보이고, 나머지는 되돌린 뒤 실패 종료 코드를 남긴다", async () => {
    mockDiscard.mockRejectedValueOnce(
      new Error("추적하지 않는 새 노트라 되돌릴 원본이 없습니다 — new.md"),
    );

    await runDiscard("new.md", "b.md");

    expect(mockDiscard).toHaveBeenCalledTimes(2);
    expect(lines).toEqual([
      "  ✕ new.md: 추적하지 않는 새 노트라 되돌릴 원본이 없습니다 — new.md",
      "  ✓ b.md",
    ]);
    expect(process.exitCode).toBe(1);
    expect(mockClose).toHaveBeenCalledOnce();
  });

  it("경로 없이 부르면 되돌리지 않는다", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(runDiscard()).rejects.toMatchObject({ code: "commander.missingArgument" });
    stderr.mockRestore();
    expect(mockDiscard).not.toHaveBeenCalled();
  });
});
