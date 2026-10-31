/**
 * SHA-256 — 모바일에는 Node `crypto` 가 없고, 웹의 `crypto.subtle` 은 비동기라 core 의 동기 해시(`computeHash` ·
 * 첨부 해시)를 갈음하지 못한다. 결과는 Node `createHash("sha256")` 와 같다(`tests/platform/shims.test.ts`).
 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** 이어 넣을 수 있는 SHA-256 — 큰 첨부를 한 번에 복사하지 않는다. */
export class Sha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly block = new Uint8Array(64);
  private readonly words = new Uint32Array(64);
  private filled = 0;
  private length = 0;

  update(data: Uint8Array): this {
    let offset = 0;
    this.length += data.length;
    while (offset < data.length) {
      const take = Math.min(64 - this.filled, data.length - offset);
      this.block.set(data.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === 64) {
        this.compress(this.block);
        this.filled = 0;
      }
    }
    return this;
  }

  digest(): Uint8Array {
    const bits = this.length * 8;
    const padding = new Uint8Array((this.filled < 56 ? 56 : 120) - this.filled + 8);
    padding[0] = 0x80;
    const view = new DataView(padding.buffer);
    view.setUint32(padding.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(padding.length - 4, bits >>> 0);
    this.update(padding);
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    this.state.forEach((word, i) => outView.setUint32(i * 4, word));
    return out;
  }

  private compress(chunk: Uint8Array): void {
    const w = this.words;
    for (let i = 0; i < 16; i++) {
      w[i] =
        (chunk[i * 4]! << 24) |
        (chunk[i * 4 + 1]! << 16) |
        (chunk[i * 4 + 2]! << 8) |
        chunk[i * 4 + 3]!;
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = this.state as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e! >>> 6) | (e! << 26)) ^ ((e! >>> 11) | (e! << 21)) ^ ((e! >>> 25) | (e! << 7));
      const ch = (e! & f!) ^ (~e! & g!);
      const t1 = (h! + S1 + ch + K[i]! + w[i]!) | 0;
      const S0 =
        ((a! >>> 2) | (a! << 30)) ^ ((a! >>> 13) | (a! << 19)) ^ ((a! >>> 22) | (a! << 10));
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d! + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    const s = this.state;
    s[0] = (s[0]! + a!) | 0;
    s[1] = (s[1]! + b!) | 0;
    s[2] = (s[2]! + c!) | 0;
    s[3] = (s[3]! + d!) | 0;
    s[4] = (s[4]! + e!) | 0;
    s[5] = (s[5]! + f!) | 0;
    s[6] = (s[6]! + g!) | 0;
    s[7] = (s[7]! + h!) | 0;
  }
}
