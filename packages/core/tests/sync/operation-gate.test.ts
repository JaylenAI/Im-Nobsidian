/**
 * S-09 — 한 오케스트레이터의 작업은 한 번에 하나만 돈다.
 *
 * 오케스트레이터는 실행마다 원격을 본 시각 · 고른 새 경로를 쥔다. 플러그인의 수동 · 자동 · 볼트
 * 이벤트 sync 와 CLI `watch` 의 주기 sync 가 겹쳐 불러, 뒤 실행이 앞 실행의 기준을 덮었다. 겹친
 * 요청은 기다리지 않고 거절한다 — 무엇을 할지는 부른 쪽이 정한다.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { OperationGate, SyncBusyError, operationLabel } from "../../src/sync/operation-gate.js";
import { SyncOrchestrator } from "../../src/sync/orchestrator.js";
import { StateDB } from "../../src/state/state-db.js";
import { DEFAULT_CONFIG } from "../../src/types/config.js";
import { createConfig } from "../helpers/mock-orchestrator.js";
import { MemoryVault, memoryNotion } from "../helpers/memory-sync.js";

describe("OperationGate", () => {
  it("차례로 부르면 모두 돈다", async () => {
    const gate = new OperationGate();
    expect(await gate.run("pull", async () => 1)).toBe(1);
    expect(await gate.run("push", async () => 2)).toBe(2);
    expect(gate.running).toBeNull();
  });

  it("도는 중에 부르면 기다리지 않고 거절한다 — 무엇이 돌고 무엇을 거절했는지 싣는다", async () => {
    const gate = new OperationGate();
    let release!: () => void;
    const running = gate.run("sync", () => new Promise<void>((resolve) => (release = resolve)));

    expect(gate.running).toBe("sync");
    const refused = gate.run("status", async () => "안 돈다");
    await expect(refused).rejects.toBeInstanceOf(SyncBusyError);
    await expect(refused).rejects.toMatchObject({ running: "sync", requested: "status" });
    expect(() => gate.runSync("resolve", () => "안 돈다")).toThrow(SyncBusyError);

    release();
    await running;
    expect(gate.running).toBeNull();
  });

  it("작업이 실패해도 잠금을 푼다", async () => {
    const gate = new OperationGate();
    await expect(gate.run("push", () => Promise.reject(new Error("실패")))).rejects.toThrow("실패");
    expect(() =>
      gate.runSync("resolve", () => {
        throw new Error("동기 실패");
      }),
    ).toThrow("동기 실패");
    expect(gate.running).toBeNull();
    expect(await gate.run("push", async () => "다시 돈다")).toBe("다시 돈다");
  });

  it("알림 문구는 내부 코드값 대신 보이는 이름을 쓴다", () => {
    const message = new SyncBusyError("status", "resolve").message;
    expect(message).toContain(operationLabel("status"));
    expect(message).toContain(operationLabel("resolve"));
    expect(message).not.toMatch(/\b(status|resolve)\b/);
  });
});

describe("SyncOrchestrator — 겹친 작업 거절(S-09)", () => {
  let tempDir: string;
  let db: StateDB;
  let vault: MemoryVault;
  let orchestrator: SyncOrchestrator;
  /** 다음 볼트 목록 조회를 멈춘다 — 작업이 «도는 중» 인 때를 만든다. */
  let holdVault: () => { entered: Promise<void>; release: () => void };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "im-nobsidian-gate-"));
    db = StateDB.open(join(tempDir, "state.db"));
    vault = new MemoryVault();
    const notion = memoryNotion();
    const fs = vault.fs();
    // 먼저 부르는 목록 조회 하나만 멈춘다.
    let pending: { entered: () => void; released: Promise<void> } | null = null;
    const holding =
      <T>(original: () => Promise<T>) =>
      async (): Promise<T> => {
        const held = pending;
        pending = null;
        if (held) {
          held.entered();
          await held.released;
        }
        return original();
      };
    const listFiles = fs.listMarkdownFiles.getMockImplementation()!;
    const listStats = fs.listMarkdownFileStats.getMockImplementation()!;
    fs.listMarkdownFiles.mockImplementation(holding(() => listFiles()));
    fs.listMarkdownFileStats.mockImplementation(holding(() => listStats()));
    holdVault = () => {
      let release!: () => void;
      let entered!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const enteredPromise = new Promise<void>((resolve) => (entered = resolve));
      pending = { entered, released };
      return { entered: enteredPromise, release };
    };
    orchestrator = new SyncOrchestrator(
      createConfig({
        notion: { token: "ntn_test_token", rootPageId: "root-page-id", databases: [] },
        advanced: { ...DEFAULT_CONFIG.advanced, retryWaitMs: 0 },
      }),
      db,
      notion.client as never,
      fs,
    );
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("pull 이 도는 동안 status · push · sync · 원격 확인 · 충돌 해결을 거절하고, pull 은 끝까지 돈다", async () => {
    vault.write("Note.md", "본문");
    const held = holdVault();
    const pulling = orchestrator.pull();
    await held.entered;

    expect(orchestrator.runningOperation).toBe("pull");
    await expect(orchestrator.status()).rejects.toMatchObject({
      running: "pull",
      requested: "status",
    });
    await expect(orchestrator.push()).rejects.toBeInstanceOf(SyncBusyError);
    await expect(orchestrator.sync()).rejects.toBeInstanceOf(SyncBusyError);
    await expect(orchestrator.fetch()).rejects.toBeInstanceOf(SyncBusyError);
    expect(() => orchestrator.clearStaleConflicts([])).toThrow(SyncBusyError);
    await expect(orchestrator.resolveConflict({} as never, "local")).rejects.toBeInstanceOf(
      SyncBusyError,
    );
    await expect(orchestrator.resolveAllConflicts([], "local-first")).rejects.toBeInstanceOf(
      SyncBusyError,
    );

    held.release();
    await expect(pulling).resolves.toMatchObject({ failed: [] });
    expect(orchestrator.runningOperation).toBeNull();
    await expect(orchestrator.push()).resolves.toMatchObject({ created: 1, failed: [] });
  });

  it("sync 는 안에서 pull · push 를 차례로 부른다 — 스스로를 거절하지 않는다", async () => {
    vault.write("Note.md", "본문");
    await expect(orchestrator.sync()).resolves.toMatchObject({
      push: { created: 1, failed: [] },
    });
    expect(orchestrator.runningOperation).toBeNull();
  });

  it("로컬만 보는 상태 · 이름 변경 기록은 도는 작업과 함께 부를 수 있다", async () => {
    vault.write("Note.md", "본문");
    const held = holdVault();
    const pushing = orchestrator.push();
    await held.entered;

    await expect(orchestrator.statusLocal()).resolves.toMatchObject({ remoteChanges: [] });
    expect(() => orchestrator.recordLocalRename("Note.md", "Moved.md", "file")).not.toThrow();

    held.release();
    await expect(pushing).resolves.toMatchObject({ created: 1, failed: [] });
  });
});
