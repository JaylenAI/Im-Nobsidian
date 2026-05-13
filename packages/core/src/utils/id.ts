import { randomUUID } from "node:crypto";

export function generateId(): string {
  return randomUUID();
}

export function normalizeNotionId(id: string): string {
  const raw = id.replace(/-/g, "");
  if (raw.length !== 32) return id;
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

export function notionIdsEqual(a: string, b: string): boolean {
  return a.replace(/-/g, "") === b.replace(/-/g, "");
}
