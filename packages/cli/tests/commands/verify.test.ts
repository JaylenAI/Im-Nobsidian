/**
 * R11-B — `nobsi verify` 표면 잠금.
 *
 * 완결성 게이트의 값어치는 **실패가 종료 코드로 나가는 것**에 있다. 화면에만 빨간
 * 글씨를 찍고 0 으로 끝나면 E2E 하니스도 CI 도 미발견을 못 잡는다(R11-C 와 같은 함정).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";

const { mockVerify } = vi.hoisted(() => ({ mockVerify: vi.fn() }));

vi.mock("@im-nobsidian/core", () => ({
  ConfigManager: vi.fn().mockImplementation(() => ({
    dbPath: "/mock/sync.db",
    load: vi.fn().mockResolvedValue({
      notion: { token: "ntn_test", rootPageId: "root", databases: [] },
      paths: {},
      sync: { direction: "both" },
      advanced: { concurrency: 3 },
    }),
  })),
  StateDB: {
    open: vi.fn().mockReturnValue({ close: vi.fn(), getAll: vi.fn().mockReturnValue([]) }),
  },
  NotionClient: Object.assign(
    vi.fn().mockImplementation(() => ({})),
    { fromConfig: vi.fn().mockReturnValue({}) },
  ),
  SyncOrchestrator: vi.fn().mockImplementation(() => ({ verifyCompleteness: mockVerify })),
  NodeVaultFS: vi.fn().mockImplementation(() => ({})),
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

import { verifyCommand } from "../../src/commands/verify.js";

function runVerify(...args: string[]) {
  const program = new Command();
  program.addCommand(verifyCommand);
  return program.parseAsync(["node", "cli", "verify", ...args]);
}

const DB_COMPLETE = {
  databases: [{ databaseId: "db-a", remoteRows: 2, localRows: 2, missingIds: [], extraIds: [] }],
  failures: [],
  remoteTotal: 2,
  localTotal: 2,
  complete: true,
};

const DB_INCOMPLETE = {
  databases: [
    { databaseId: "db-a", remoteRows: 3, localRows: 1, missingIds: ["r2", "r3"], extraIds: [] },
  ],
  failures: [],
  remoteTotal: 3,
  localTotal: 1,
  complete: false,
};

const PAGES_COMPLETE = {
  remotePages: 5,
  vaultPages: 5,
  missingIds: [],
  localOnlyIds: [],
  complete: true,
};

const COMPLETE = { databases: DB_COMPLETE, pages: PAGES_COMPLETE, complete: true };
const INCOMPLETE = { databases: DB_INCOMPLETE, pages: PAGES_COMPLETE, complete: false };

describe("verify command", () => {
  beforeEach(() => {
    process.exitCode = undefined;
    mockVerify.mockReset();
  });

  it("완결이면 성공 문구를 찍고 종료 코드를 세우지 않는다", async () => {
    mockVerify.mockResolvedValue(COMPLETE);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runVerify();

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("DB Completeness"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("All database rows present"));
    expect(process.exitCode).toBeUndefined();
    spy.mockRestore();
  });

  it("미발견이 있으면 실패 종료 코드를 세운다", async () => {
    mockVerify.mockResolvedValue(INCOMPLETE);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runVerify();

    expect(process.exitCode).toBe(1);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Incomplete databases: 1"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("missing"));
    spy.mockRestore();
  });

  it("조회 실패도 실패로 판정한다 — 이상 없음으로 접지 않는다", async () => {
    mockVerify.mockResolvedValue({
      databases: {
        databases: [],
        failures: [{ databaseId: "db-x", error: "object_not_found" }],
        remoteTotal: 0,
        localTotal: 0,
        complete: false,
      },
      pages: PAGES_COMPLETE,
      complete: false,
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runVerify();

    expect(process.exitCode).toBe(1);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Query failures: 1"));
    spy.mockRestore();
  });

  it("--json 은 리포트를 기계가 읽을 형태로 낸다", async () => {
    mockVerify.mockResolvedValue(INCOMPLETE);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runVerify("--json");

    const printed = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(JSON.parse(printed)).toMatchObject({
      complete: false,
      databases: { remoteTotal: 3 },
      pages: { remotePages: 5 },
    });
    expect(process.exitCode).toBe(1);
    spy.mockRestore();
  });

  // ── R12-C — 페이지 대조 표면 ──────────────────────────────────────────────
  //
  // DB 가 완결이어도 페이지가 빠지면 실패로 나가야 한다. 두 대조가 한 종료 코드로 합쳐지는
  // 지점이 여기라, DB 만 보고 0 을 내보내던 옛 동작이 되살아나면 이 테스트가 먼저 깨진다.

  it("페이지 대조 결과를 함께 출력한다", async () => {
    mockVerify.mockResolvedValue(COMPLETE);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runVerify();

    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Page Completeness"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Remote pages:"));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("All remote pages present"));
    spy.mockRestore();
  });

  it("DB 가 완결이어도 페이지 미발견이면 실패 종료 코드를 세운다", async () => {
    mockVerify.mockResolvedValue({
      databases: DB_COMPLETE,
      pages: {
        remotePages: 7,
        vaultPages: 5,
        missingIds: ["p6", "p7"],
        localOnlyIds: [],
        complete: false,
      },
      complete: false,
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runVerify();

    expect(process.exitCode).toBe(1);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Pages missing from vault: 2"));
    spy.mockRestore();
  });

  it("로컬 전용 페이지는 정보성으로만 찍고 실패로 만들지 않는다", async () => {
    mockVerify.mockResolvedValue({
      databases: DB_COMPLETE,
      pages: {
        remotePages: 5,
        vaultPages: 6,
        missingIds: [],
        localOnlyIds: ["draft-1"],
        complete: true,
      },
      complete: true,
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runVerify();

    expect(process.exitCode).toBeUndefined();
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("local-only pages: 1 (informational)"),
    );
    spy.mockRestore();
  });

  it("페이지 열거 실패를 비침묵 보고하고 실패로 판정한다", async () => {
    mockVerify.mockResolvedValue({
      databases: DB_COMPLETE,
      pages: {
        remotePages: 0,
        vaultPages: 5,
        missingIds: [],
        localOnlyIds: [],
        error: "search unavailable",
        complete: false,
      },
      complete: false,
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runVerify();

    expect(process.exitCode).toBe(1);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("Page enumeration failed"));
    spy.mockRestore();
  });

  it("DB 모드(pages=null)에서는 페이지 대조 생략을 명시한다", async () => {
    mockVerify.mockResolvedValue({ databases: DB_COMPLETE, pages: null, complete: true });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await runVerify();

    expect(process.exitCode).toBeUndefined();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("skipped (database mode)"));
    spy.mockRestore();
  });
});
