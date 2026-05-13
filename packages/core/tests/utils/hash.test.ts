import { describe, it, expect } from "vitest";
import { computeHash, computeBufferHash } from "../../src/utils/hash.js";

describe("computeHash", () => {
  it("동일 입력에 동일 해시 반환", () => {
    const hash1 = computeHash("hello world");
    const hash2 = computeHash("hello world");
    expect(hash1).toBe(hash2);
  });

  it("다른 입력에 다른 해시 반환", () => {
    const hash1 = computeHash("hello world");
    const hash2 = computeHash("hello korea");
    expect(hash1).not.toBe(hash2);
  });

  it("SHA-256 해시 길이 = 64자", () => {
    const hash = computeHash("test");
    expect(hash).toHaveLength(64);
  });

  it("빈 문자열도 해시 가능", () => {
    const hash = computeHash("");
    expect(hash).toHaveLength(64);
  });
});

describe("computeBufferHash", () => {
  it("Buffer 입력에 해시 반환", () => {
    const hash = computeBufferHash(Buffer.from("hello"));
    expect(hash).toHaveLength(64);
  });

  it("동일 내용의 string과 buffer 해시 일치", () => {
    const strHash = computeHash("hello");
    const bufHash = computeBufferHash(Buffer.from("hello", "utf-8"));
    expect(strHash).toBe(bufHash);
  });
});
