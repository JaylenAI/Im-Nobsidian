import { randomUUID } from "node:crypto";

export function generateId(): string {
  return randomUUID();
}

export function normalizeNotionId(id: string): string {
  const raw = id.replace(/-/g, "");
  if (raw.length !== 32) return id;
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

/** 대시 포함(8-4-4-4-12) 또는 대시 없는 32 hex Notion ID 전체 일치 패턴. */
const NOTION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9a-f]{32}$/i;

/** 값 전체가 Notion ID(페이지 · 사용자 · DB) 모양인지. */
export function isNotionId(value: string): boolean {
  return NOTION_ID_RE.test(value);
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
