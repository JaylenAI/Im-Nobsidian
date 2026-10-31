/**
 * `crypto` — 데스크톱이면 Node 의 것. 모바일이면 core 가 쓰는 둘만 — `randomUUID`(웹 crypto) · `createHash("sha256")`
 * (순수 JS, {@link Sha256}). 쓰는 꼴은 `createHash("sha256").update(글 | 바이트).digest("hex")` 뿐이다.
 */
import type * as NodeCrypto from "node:crypto";
import { nodeModule } from "../node.js";
import { Sha256 } from "../sha256.js";

const crypto = nodeModule<typeof NodeCrypto>("crypto");

class Sha256Hash {
  private readonly hash = new Sha256();

  update(data: string | Uint8Array): this {
    this.hash.update(typeof data === "string" ? new TextEncoder().encode(data) : data);
    return this;
  }

  digest(encoding: "hex"): string {
    if (encoding !== "hex")
      throw new Error(`모바일의 createHash 는 hex 만 냄 (${String(encoding)})`);
    return [...this.hash.digest()].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
}

function mobileCreateHash(algorithm: string): Sha256Hash {
  if (algorithm !== "sha256") throw new Error(`모바일의 createHash 는 sha256 만 씀 (${algorithm})`);
  return new Sha256Hash();
}

export const createHash = (crypto?.createHash ??
  mobileCreateHash) as unknown as typeof NodeCrypto.createHash;

export const randomUUID: () => string =
  crypto?.randomUUID ?? (() => globalThis.crypto.randomUUID());
