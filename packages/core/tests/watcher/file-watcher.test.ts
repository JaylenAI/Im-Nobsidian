import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FileWatcher } from "../../src/watcher/file-watcher.js";
import { mkdtempSync, writeFileSync, rmSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("FileWatcher", () => {
  let tempDir: string;
  let watcher: FileWatcher;
  const events: Array<{ event: string; path: string }> = [];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fw-test-"));
    events.length = 0;
  });

  afterEach(async () => {
    if (watcher) {
      await watcher.stop();
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function waitForEvent(timeoutMs = 3000): Promise<{ event: string; path: string }> {
    return new Promise((resolve, reject) => {
      const startLen = events.length;
      const interval = setInterval(() => {
        if (events.length > startLen) {
          clearInterval(interval);
          resolve(events[events.length - 1]!);
        }
      }, 50);
      setTimeout(() => {
        clearInterval(interval);
        reject(new Error("timeout waiting for event"));
      }, timeoutMs);
    });
  }

  it("파일 생성 이벤트 감지", async () => {
    watcher = new FileWatcher(tempDir, (event, path) => {
      events.push({ event, path });
    });
    watcher.start();

    await new Promise((r) => setTimeout(r, 300));

    const filePath = join(tempDir, "new-file.txt");
    writeFileSync(filePath, "hello");

    const ev = await waitForEvent();
    expect(ev.event).toBe("add");
    // 절대경로가 아니라 rootPath 기준 볼트 상대경로를 방출해야 한다(동기화 paths 필터 정합).
    expect(ev.path).toBe("new-file.txt");
  });

  it("파일 수정 이벤트 감지", async () => {
    const filePath = join(tempDir, "existing.txt");
    writeFileSync(filePath, "original");

    watcher = new FileWatcher(tempDir, (event, path) => {
      events.push({ event, path });
    });
    watcher.start();

    await new Promise((r) => setTimeout(r, 300));

    writeFileSync(filePath, "modified");

    const ev = await waitForEvent();
    expect(ev.event).toBe("change");
    expect(ev.path).toBe("existing.txt");
  });

  it("파일 삭제 이벤트 감지", async () => {
    const filePath = join(tempDir, "to-delete.txt");
    writeFileSync(filePath, "bye");

    watcher = new FileWatcher(tempDir, (event, path) => {
      events.push({ event, path });
    });
    watcher.start();

    await new Promise((r) => setTimeout(r, 300));

    unlinkSync(filePath);

    const ev = await waitForEvent();
    expect(ev.event).toBe("unlink");
    expect(ev.path).toBe("to-delete.txt");
  });

  it("중첩 폴더 파일은 '/' 구분 상대경로로 방출", async () => {
    const subDir = join(tempDir, "sub");
    mkdirSync(subDir);

    watcher = new FileWatcher(tempDir, (event, path) => {
      events.push({ event, path });
    });
    watcher.start();

    await new Promise((r) => setTimeout(r, 300));

    writeFileSync(join(subDir, "nested.md"), "hi");

    const ev = await waitForEvent();
    expect(ev.event).toBe("add");
    expect(ev.path).toBe("sub/nested.md");
  });

  it("dotfile 무시", async () => {
    watcher = new FileWatcher(tempDir, (event, path) => {
      events.push({ event, path });
    });
    watcher.start();

    await new Promise((r) => setTimeout(r, 300));

    writeFileSync(join(tempDir, ".hidden"), "secret");
    await new Promise((r) => setTimeout(r, 1000));

    expect(events.filter((e) => e.path.includes(".hidden"))).toHaveLength(0);
  });

  it(".im-nobsidian 디렉토리 무시", async () => {
    const obsiDir = join(tempDir, ".im-nobsidian");
    mkdirSync(obsiDir);

    watcher = new FileWatcher(tempDir, (event, path) => {
      events.push({ event, path });
    });
    watcher.start();

    await new Promise((r) => setTimeout(r, 300));

    writeFileSync(join(obsiDir, "sync.db"), "data");
    await new Promise((r) => setTimeout(r, 1000));

    expect(events.filter((e) => e.path.includes(".im-nobsidian"))).toHaveLength(0);
  });

  it("stop 후 이벤트 미감지", async () => {
    watcher = new FileWatcher(tempDir, (event, path) => {
      events.push({ event, path });
    });
    watcher.start();
    await new Promise((r) => setTimeout(r, 300));

    await watcher.stop();

    writeFileSync(join(tempDir, "after-stop.txt"), "nope");
    await new Promise((r) => setTimeout(r, 1000));

    expect(events.filter((e) => e.path.includes("after-stop"))).toHaveLength(0);
  });
});
