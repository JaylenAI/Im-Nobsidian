import { describe, it, expect, vi } from "vitest";

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockSearch = vi.fn().mockResolvedValue({ results: [{ id: "page-1" }] });

vi.mock("@im-nobsidian/core", () => ({
  ConfigManager: vi.fn().mockImplementation(() => ({
    configPath: "/mock/.im-nobsidian/config.yaml",
    dbPath: "/mock/.im-nobsidian/sync.db",
    isInitialized: vi.fn().mockResolvedValue(false),
    init: mockInit,
    load: vi.fn().mockResolvedValue({}),
  })),
  NotionClient: vi.fn().mockImplementation(() => ({
    search: mockSearch,
  })),
}));

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

vi.mock("ora", () => ({
  default: vi.fn().mockReturnValue({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock("@inquirer/prompts", () => ({
  input: vi.fn().mockResolvedValue("ntn_test_token"),
  confirm: vi.fn().mockResolvedValue(false),
}));

import { Command } from "commander";
import { initCommand } from "../../src/commands/init.js";

function runInit(...args: string[]) {
  const program = new Command();
  program.addCommand(initCommand);
  return program.parseAsync(["node", "cli", "init", ...args]);
}

describe("init command", () => {
  it("비대화형 모드 — 토큰+ID 누락 시 에러", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runInit("--non-interactive");
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("필수"));
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    consoleSpy.mockRestore();
  });

  it("비대화형 모드 — 잘못된 토큰 형식", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await runInit("--non-interactive", "--token", "bad_token", "--root-page-id", "abc");
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("ntn_"));
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    consoleSpy.mockRestore();
  });

  it("비대화형 모드 — 성공", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runInit("--non-interactive", "--token", "ntn_valid", "--root-page-id", "pg123");
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Token validated"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Config saved"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Ready!"));
    expect(mockInit).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
