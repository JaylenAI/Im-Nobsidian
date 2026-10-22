import { describe, it, expect, vi } from "vitest";

const mockInit = vi.fn().mockResolvedValue(undefined);
const mockSearch = vi.fn().mockResolvedValue({ results: [{ id: "page-1" }] });

vi.mock("@im-nobsidian/core", async () => ({
  // 루트 페이지 입력 판정 · 토큰 머리는 진짜를 쓴다 — 플러그인 설정 · 설정 검증과 같은 판정인지가 시험 대상이다
  ...(await vi
    .importActual<typeof import("@im-nobsidian/core")>("@im-nobsidian/core")
    .then(({ notionIdFromInput, NOTION_TOKEN_PREFIX }) => ({
      notionIdFromInput,
      NOTION_TOKEN_PREFIX,
    }))),
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

const RAW_ID = "35a13b18d38280cf9057e37e6e473e41";
const PAGE_ID = "35a13b18-d382-80cf-9057-e37e6e473e41";

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
    await runInit("--non-interactive", "--token", "ntn_valid", "--root-page-id", RAW_ID);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Token validated"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Config saved"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Ready!"));
    // init 은 상태 DB 를 만들지 않는다(첫 동기화가 만든다) — 만들었다고 말하지 않는다
    expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining("State DB"));
    expect(mockInit).toHaveBeenCalledWith({ token: "ntn_valid", rootPageId: PAGE_ID });
    consoleSpy.mockRestore();
  });

  it("비대화형 모드 — 루트 페이지에 주소를 넣으면 그 안의 ID 를 적는다 (D1)", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockInit.mockClear();
    await runInit(
      "--non-interactive",
      "--token",
      "ntn_valid",
      "--root-page-id",
      `https://www.notion.so/myspace/Notes-${RAW_ID}?pvs=4`,
    );
    expect(mockInit).toHaveBeenCalledWith({ token: "ntn_valid", rootPageId: PAGE_ID });
    consoleSpy.mockRestore();
  });

  it("비대화형 모드 — 루트 페이지에서 ID 를 못 찾으면 Notion 에 묻기 전에 멈춘다 (D1)", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockInit.mockClear();
    mockSearch.mockClear();
    await runInit("--non-interactive", "--token", "ntn_valid", "--root-page-id", "pg123");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("페이지 ID(32자리)를 찾지 못했습니다"),
    );
    expect(process.exitCode).toBe(1);
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockInit).not.toHaveBeenCalled();
    process.exitCode = undefined;
    consoleSpy.mockRestore();
  });
});
