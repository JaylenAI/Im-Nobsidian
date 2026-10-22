/**
 * 파일을 한 번에 갈아 끼우기 — 상태 DB 쓰기가 쓰는 도중에 죽어도 잘린 파일을 남기지 않는지 실제 파일로 본다.
 * 마지막 시험은 쓰기를 되풀이하는 자식 프로세스를 쓰는 도중에 죽인다(SIGKILL).
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomically } from "../../src/state/atomic-write.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "im-nobsidian-atomic-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const text = (value: string) => new TextEncoder().encode(value);

describe("파일을 한 번에 갈아 끼우기", () => {
  it("새 내용으로 바꾸고 옆 임시 파일을 남기지 않는다", async () => {
    const dir = tempDir();
    const file = join(dir, "sync.db");

    await writeFileAtomically(file, text("old"));
    await writeFileAtomically(file, text("new"));

    expect(readFileSync(file, "utf8")).toBe("new");
    expect(readdirSync(dir)).toEqual(["sync.db"]);
  });

  it("폴더가 없으면 만든다 — 처음 쓰는 볼트", async () => {
    const file = join(tempDir(), ".im-nobsidian", "sync.db");

    await writeFileAtomically(file, text("first"));

    expect(readFileSync(file, "utf8")).toBe("first");
  });

  it("임시 파일에 쓰지 못하면 이유를 던지고 옛 파일은 그대로다", async () => {
    const dir = tempDir();
    const file = join(dir, "sync.db");
    writeFileSync(file, "old");
    mkdirSync(`${file}.tmp`); // 임시 파일 자리에 폴더 — 열지 못한다

    await expect(writeFileAtomically(file, text("new"))).rejects.toThrow(/EISDIR/);

    expect(readFileSync(file, "utf8")).toBe("old");
  });

  it("쓰는 도중에 죽어도 파일은 옛 것이거나 새 것이다 — 잘린 파일이 남지 않는다", async () => {
    const file = join(tempDir(), "sync.db");
    const size = 4 * 1024 * 1024;
    await writeFileAtomically(file, new Uint8Array(size).fill(1));
    const module = fileURLToPath(new URL("../../src/state/atomic-write.ts", import.meta.url));
    // 한 바이트 값으로 채운 4MB 를 값을 바꿔 가며 끝없이 쓴다. 첫 쓰기를 마치면 알린다.
    const writer = `
      import { writeFileAtomically } from ${JSON.stringify(module)};
      for (let round = 0; ; round++) {
        await writeFileAtomically(${JSON.stringify(file)}, new Uint8Array(${size}).fill(2 + (round % 2)));
        if (round === 0) process.stdout.write("ready");
      }
    `;

    for (let kill = 0; kill < 8; kill++) {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", writer],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      await once(child.stdout, "data");
      // 쓰기 한 번(수 ms ~ 수십 ms) 안의 여러 때에 죽인다
      await new Promise((resolve) => setTimeout(resolve, kill * 3));
      child.kill("SIGKILL");
      await once(child, "exit");

      const content = readFileSync(file);
      expect(content.length).toBe(size);
      expect(content.equals(Buffer.alloc(size, content[0]))).toBe(true);
    }
  });
});
