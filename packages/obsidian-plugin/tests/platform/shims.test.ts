/**
 * P11 — Node 모듈 shim(`src/platform/shims/`). 데스크톱이면 Node 의 것을 그대로 넘기고, 모바일(전역 `require` 없음)이면
 * 갈음하는 구현이 Node 와 같은 답을 내는가. vitest 는 ESM 이라 전역 `require` 가 없다 — 모바일 쪽이 기본이다.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRequire } from "node:module";
import * as nodeCrypto from "node:crypto";
import * as nodePath from "node:path";
import { Sha256 } from "../../src/platform/sha256.js";

const nodeRequire = createRequire(import.meta.url);

/** 같은 씨앗이면 같은 값 — 실패를 다시 볼 수 있게. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

/** 전역 `require` 를 두거나 치우고 shim 을 새로 읽는다 — shim 은 읽힐 때 Node 모듈을 고른다. */
async function loadShim<T>(path: string, desktop: boolean): Promise<T> {
  vi.resetModules();
  const global = globalThis as { require?: unknown };
  const saved = global.require;
  if (desktop) global.require = nodeRequire;
  else delete global.require;
  try {
    return (await import(path)) as T;
  } finally {
    if (saved === undefined) delete global.require;
    else global.require = saved;
  }
}

afterEach(() => vi.resetModules());

describe("Sha256 — Node createHash('sha256') 와 같다", () => {
  const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

  it("무작위 길이 · 내용 600가지 (블록 경계 55 · 56 · 63 · 64 · 65 포함)", () => {
    const next = random(20261031);
    const lengths = [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 1000];
    for (let i = 0; i < 600; i++) {
      const length = i < lengths.length ? lengths[i]! : Math.floor(next() * 3000);
      const data = new Uint8Array(length).map(() => Math.floor(next() * 256));
      const expected = nodeCrypto.createHash("sha256").update(data).digest("hex");
      expect(hex(new Sha256().update(data).digest()), `길이 ${length}`).toBe(expected);
    }
  });

  it("나눠 넣어도 한 번에 넣은 것과 같다", () => {
    const next = random(7);
    const data = new Uint8Array(5000).map(() => Math.floor(next() * 256));
    const hash = new Sha256();
    for (let offset = 0; offset < data.length;) {
      const take = 1 + Math.floor(next() * 130);
      hash.update(data.subarray(offset, offset + take));
      offset += take;
    }
    expect(hex(hash.digest())).toBe(nodeCrypto.createHash("sha256").update(data).digest("hex"));
  });
});

describe("모바일(전역 require 없음)", () => {
  it("crypto.createHash('sha256') — 글 · 바이트 모두 Node 와 같은 hex, 다른 것은 까닭을 던진다", async () => {
    const { createHash, randomUUID } = await loadShim<
      typeof import("../../src/platform/shims/crypto.js")
    >("../../src/platform/shims/crypto.js", false);
    expect(createHash).not.toBe(nodeCrypto.createHash);
    for (const text of ["", "한글 본문\n", "a".repeat(1000)]) {
      expect(createHash("sha256").update(text).digest("hex")).toBe(
        nodeCrypto.createHash("sha256").update(text).digest("hex"),
      );
    }
    const bytes = new Uint8Array([0, 1, 2, 255]);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      nodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    );
    expect(() => createHash("md5")).toThrow(/sha256/);
    expect(() => createHash("sha256").update("x").digest("base64")).toThrow(/hex/);
    expect(randomUUID()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("path — Node 의 posix 와 같은 답", async () => {
    const path = await loadShim<typeof import("../../src/platform/shims/path.js")>(
      "../../src/platform/shims/path.js",
      false,
    );
    expect(path.default.join).not.toBe(nodePath.join);
    const next = random(42);
    const pieces = ["a", "b", "..", ".", "", "/", "c.md", "가나", "x.tar.gz", "/r", "d/"];
    const pick = () => pieces[Math.floor(next() * pieces.length)]!;
    for (let i = 0; i < 2000; i++) {
      const parts = Array.from({ length: 1 + Math.floor(next() * 4) }, pick);
      const one = parts.join("");
      const label = JSON.stringify(parts);
      expect(path.join(...parts), label).toBe(nodePath.posix.join(...parts));
      expect(path.normalize(one), label).toBe(nodePath.posix.normalize(one));
      expect(path.dirname(one), label).toBe(nodePath.posix.dirname(one));
      expect(path.basename(one), label).toBe(nodePath.posix.basename(one));
      expect(path.extname(one), label).toBe(nodePath.posix.extname(one));
      expect(path.isAbsolute(one), label).toBe(nodePath.posix.isAbsolute(one));
      for (const ext of [".md", ".gz", "a", "c.md"])
        expect(path.basename(one, ext), `${label} ${ext}`).toBe(nodePath.posix.basename(one, ext));
      // resolve · relative 는 작업 폴더를 본다 — 모바일에는 없으니 절대 경로로만 견준다
      const absolute = parts.map((part) => `/${part}`);
      expect(path.resolve(...absolute), label).toBe(nodePath.posix.resolve(...absolute));
      expect(path.relative(`/${parts[0]}`, `/${one}`), label).toBe(
        nodePath.posix.relative(`/${parts[0]}`, `/${one}`),
      );
    }
    expect(path.sep).toBe("/");
  });

  it("events — 붙이고 · 한 번만 · 떼고 · 알린다", async () => {
    const { EventEmitter } = await loadShim<typeof import("../../src/platform/shims/events.js")>(
      "../../src/platform/shims/events.js",
      false,
    );
    const emitter = new EventEmitter();
    const seen: string[] = [];
    const always = (value: unknown) => seen.push(`always:${String(value)}`);
    emitter.on("e", always);
    emitter.once("e", (value: unknown) => seen.push(`once:${String(value)}`));
    expect(emitter.emit("e", 1)).toBe(true);
    emitter.emit("e", 2);
    emitter.off("e", always);
    expect(emitter.emit("e", 3)).toBe(false);
    expect(seen).toEqual(["always:1", "once:1", "always:2"]);
  });

  it("fs · fs/promises · url.fileURLToPath — 부르면 어디가 빠졌는지 던진다", async () => {
    const fs = await loadShim<typeof import("../../src/platform/shims/fs.js")>(
      "../../src/platform/shims/fs.js",
      false,
    );
    expect(() => fs.readFileSync("x")).toThrow(/모바일에는 fs\.readFileSync/);
    const fsPromises = await loadShim<typeof import("../../src/platform/shims/fs-promises.js")>(
      "../../src/platform/shims/fs-promises.js",
      false,
    );
    expect(() => fsPromises.readFile("x")).toThrow(/모바일에는 fs\/promises\.readFile/);
    const url = await loadShim<typeof import("../../src/platform/shims/url.js")>(
      "../../src/platform/shims/url.js",
      false,
    );
    expect(() => url.fileURLToPath("file:///x")).toThrow(/url\.fileURLToPath/);
    expect(url.URL).toBe(globalThis.URL);
    const os = await loadShim<typeof import("../../src/platform/shims/os.js")>(
      "../../src/platform/shims/os.js",
      false,
    );
    expect(os.hostname()).toBe("mobile");
  });
});

describe("데스크톱(전역 require 있음) — Node 의 것을 그대로 넘긴다", () => {
  it("fs · path · crypto · os · events", async () => {
    const fs = await loadShim<typeof import("../../src/platform/shims/fs.js")>(
      "../../src/platform/shims/fs.js",
      true,
    );
    expect(fs.readFileSync).toBe(nodeRequire("fs").readFileSync);
    expect(fs.Stats).toBe(nodeRequire("fs").Stats);
    const path = await loadShim<typeof import("../../src/platform/shims/path.js")>(
      "../../src/platform/shims/path.js",
      true,
    );
    expect(path.join).toBe(nodeRequire("path").join);
    const crypto = await loadShim<typeof import("../../src/platform/shims/crypto.js")>(
      "../../src/platform/shims/crypto.js",
      true,
    );
    expect(crypto.createHash).toBe(nodeRequire("crypto").createHash);
    const os = await loadShim<typeof import("../../src/platform/shims/os.js")>(
      "../../src/platform/shims/os.js",
      true,
    );
    expect(os.hostname()).toBe(nodeRequire("os").hostname());
    const events = await loadShim<typeof import("../../src/platform/shims/events.js")>(
      "../../src/platform/shims/events.js",
      true,
    );
    expect(events.EventEmitter).toBe(nodeRequire("events").EventEmitter);
  });
});
