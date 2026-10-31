import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { confirm } from "@inquirer/prompts";
import { askUserBaseFilterFixes } from "../../src/utils/base-filter-prompt.js";

vi.mock("@inquirer/prompts", () => ({ confirm: vi.fn().mockResolvedValue(true) }));

const fix = { path: "내/할일.base", from: "A/T", to: "A/U" };

function orchestrator(fixes = [fix]) {
  return {
    userBaseFilterFixes: vi.fn(() => fixes),
    resolveUserBaseFilterFixes: vi.fn(async (accept: boolean) => (accept ? [fix.path] : [])),
  };
}

function setTty(value: boolean): () => void {
  const saved = [process.stdin.isTTY, process.stdout.isTTY];
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
  return () => {
    Object.defineProperty(process.stdin, "isTTY", { value: saved[0], configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: saved[1], configurable: true });
  };
}

describe("askUserBaseFilterFixes", () => {
  let output: string[];
  beforeEach(() => {
    output = [];
    vi.spyOn(console, "log").mockImplementation((line = "") => void output.push(String(line)));
    vi.mocked(confirm).mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it("--yes 면 묻지 않고 고친다", async () => {
    const o = orchestrator();
    await askUserBaseFilterFixes(o, { yes: true });
    expect(confirm).not.toHaveBeenCalled();
    expect(o.resolveUserBaseFilterFixes).toHaveBeenCalledWith(true);
    expect(output.join("\n")).toContain("내/할일.base: A/T → A/U");
    expect(output.join("\n")).toContain(".base 1개의 폴더 필터를 고쳤습니다");
  });

  it("터미널이면 묻고 답대로 — 두면 다시 묻지 않는다고 알린다", async () => {
    const restore = setTty(true);
    try {
      vi.mocked(confirm).mockResolvedValueOnce(false);
      const o = orchestrator();
      await askUserBaseFilterFixes(o, {});
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(o.resolveUserBaseFilterFixes).toHaveBeenCalledWith(false);
      expect(output.join("\n")).toContain("그대로 둡니다");
    } finally {
      restore();
    }
  });

  it("물을 수 없으면 알리기만 하고 남긴다 — --yes 를 안내한다", async () => {
    const restore = setTty(false);
    try {
      const o = orchestrator();
      await askUserBaseFilterFixes(o, {});
      expect(confirm).not.toHaveBeenCalled();
      expect(o.resolveUserBaseFilterFixes).not.toHaveBeenCalled();
      expect(output.join("\n")).toContain("--yes");
    } finally {
      restore();
    }
  });

  it("dry-run 이거나 물을 것이 없으면 아무것도 하지 않는다", async () => {
    const o = orchestrator();
    await askUserBaseFilterFixes(o, { yes: true, dryRun: true });
    const none = orchestrator([]);
    await askUserBaseFilterFixes(none, { yes: true });
    expect(o.resolveUserBaseFilterFixes).not.toHaveBeenCalled();
    expect(none.resolveUserBaseFilterFixes).not.toHaveBeenCalled();
    expect(output).toEqual([]);
  });
});
