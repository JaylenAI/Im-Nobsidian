import { createHash } from "node:crypto";

export function computeHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

export function computeBufferHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
