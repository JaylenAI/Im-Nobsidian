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

/** 주소 끝의 Notion id — `…/p/<32자리>` · `…/<제목>-<32자리>`. 없으면 null. */
export function notionIdOfUrl(url: string): string | null {
  const m =
    /([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[?#].*)?$/i.exec(
      url,
    );
  return m ? normalizeNotionId(m[1]!.toLowerCase()) : null;
}

/**
 * 사용자가 넣은 페이지 — ID(대시 있거나 없거나) 또는 Notion 주소(브라우저 주소창 · 「링크 복사」). 주소창에
 * 보이는 것을 그대로 붙여 넣어도 되게 한다. 못 찾으면 null.
 *
 * 데이터베이스 보기에서 연 페이지 주소는 `…/<DB>?v=<보기>&p=<페이지>` 다 — 연 페이지는 `p` 이고, `v` 는 보기다.
 */
export function notionIdFromInput(input: string): string | null {
  const value = input.trim();
  if (isNotionId(value)) return normalizeNotionId(value.toLowerCase());
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const opened = url.searchParams.get("p");
  if (opened !== null) return isNotionId(opened) ? normalizeNotionId(opened.toLowerCase()) : null;
  return notionIdOfUrl(url.pathname);
}

export function notionIdsEqual(a: string, b: string): boolean {
  return a.replace(/-/g, "") === b.replace(/-/g, "");
}

/**
 * 멘션 위키링크용 정규 id — 하이픈 제거 + 소문자. 오케스트레이터의 멘션 해소 정규식
 * (`[[notion:<32hex>]]`)이 인식하는 유일한 형태다. 블록 방식 받기(`blocks-to-nfm`)와
 * markdown-api 경로(convertPageMentions)가 동일 형태로 수렴하도록 한다(rank20/I3).
 */
export function compactNotionId(id: string): string {
  return id.replace(/-/g, "").toLowerCase();
}

/** 로그 · 화면에 보일 id — 앞 8자만. 전체 id 는 페이지를 가리키므로 남기지 않는다. */
export const SHORT_NOTION_ID_LENGTH = 8;

export function shortNotionId(id: string): string {
  return compactNotionId(id).slice(0, SHORT_NOTION_ID_LENGTH);
}
