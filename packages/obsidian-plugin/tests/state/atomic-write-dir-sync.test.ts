/**
 * 이름 바꾸기도 디스크에 내린다 (D6) — 파일 내용만 내리고 폴더를 내리지 않으면, 전원이 나갔을 때 바뀐 이름이
 * 사라져 옛 파일로 돌아갈 수 있다(POSIX). 파일 시스템 호출의 차례를 본다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const calls: string[] = [];
const failDirectoryOpen = { on: false };

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (path: string, flags: string) => {
      if (flags === "r" && failDirectoryOpen.on) {
        calls.push(`open-fail ${path}`);
        throw Object.assign(new Error("EISDIR"), { code: "EISDIR" });
      }
      const handle = await actual.open(path, flags);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        calls.push(`sync ${path}`);
        return sync();
      };
      return handle;
    },
    rename: async (from: string, to: string) => {
      calls.push(`rename ${from} → ${to}`);
      return actual.rename(from, to);
    },
  };
});

const { writeFileAtomically } = await import("../../src/state/atomic-write.js");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "im-nobsidian-dirsync-"));
  calls.splice(0);
  failDirectoryOpen.on = false;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("파일을 한 번에 갈아 끼우기 — 폴더도 내린다 (D6)", () => {
  it("임시 파일을 내리고, 이름을 바꾸고, 폴더를 내린다", async () => {
    const file = join(dir, "sync.db");

    await writeFileAtomically(file, new TextEncoder().encode("new"));

    expect(calls).toEqual([`sync ${file}.tmp`, `rename ${file}.tmp → ${file}`, `sync ${dir}`]);
    expect(readFileSync(file, "utf8")).toBe("new");
  });

  it("폴더를 열 수 없는 곳(Windows)에서도 쓰기는 끝난다", async () => {
    const file = join(dir, "sync.db");
    failDirectoryOpen.on = true;

    await writeFileAtomically(file, new TextEncoder().encode("new"));

    expect(calls.at(-1)).toBe(`open-fail ${dir}`);
    expect(readFileSync(file, "utf8")).toBe("new");
  });
});
