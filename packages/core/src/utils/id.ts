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

/**
 * 멘션 위키링크용 정규 id — 하이픈 제거 + 소문자. 오케스트레이터의 멘션 해소 정규식
 * (`[[notion:<32hex>]]`)이 인식하는 유일한 형태다. 블록 폴백 경로(formatMention)와
 * markdown-api 경로(convertPageMentions)가 동일 형태로 수렴하도록 한다(rank20/I3).
 */
export function compactNotionId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}
