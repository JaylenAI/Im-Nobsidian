/**
 * 원격 페이지가 우리가 본 뒤에 바뀌었는지 가른다(N-05).
 *
 * Notion 은 `last_edited_time` 을 분 단위로 자른다(초 · 밀리초가 늘 0 — 실측). 우리가 본 «뒤»
 * 같은 분 안에서 고친 것은 시각이 그대로라, 시각이 같은지만 보면 영영 보이지 않았다 — pull 은
 * 받지 않고(`--force` 도), 그 노트를 고쳐 push 하면 Notion 의 편집을 덮어썼다. 그래서 시각과
 * 함께 둘을 더 적는다(`RemoteObservation`).
 *
 * - **언제 봤나** — 그 분이 끝나고도 시계 오차만큼 더 지난 뒤에 봤다면, 그 분의 편집은 모두 본
 *   것이다(«가라앉음»). 뒤에 고치면 시각이 다음 분으로 넘어간다.
 * - **누가 마지막으로 고쳤나** — 사람이 고치면 편집자가 그 사람으로 바뀐다. 우리(통합 봇)가 쓰고
 *   편집자가 여전히 봇이면, 그 뒤에 사람이 고치지 않은 것이다.
 *
 * 둘로도 가를 수 없으면(가라앉기 전 · 사람이 마지막 편집자) «확인 안 됨» 이다 — 호출측이 내용으로
 * 확인한다. 내용 비교는 본문 지문({@link remoteBodyFingerprint})으로 한다.
 */
import { CHILD_DATABASE_TAG_RE, CHILD_PAGE_TAG_RE } from "../converter/child-tags.js";
import type { RemoteObservation, SyncRecord } from "../types/index.js";
import { computeHash } from "../utils/hash.js";
import { isNotionHostedFileUrl } from "../utils/notion-file-url.js";

/** Notion 수정 시각의 단위 — 이 안의 편집은 시각이 같다. */
export const EDIT_TIME_RESOLUTION_MS = 60_000;

/** 이 기기 시계가 Notion 서버 시계보다 빠를 수 있다고 보는 폭. 이만큼 더 지나야 가라앉았다고 본다. */
export const CLOCK_SKEW_MARGIN_MS = 60_000;

/**
 * - `unchanged` — 지난번에 본 뒤로 바뀌지 않았다.
 * - `changed` — 바뀌었다(시각이나 편집자가 다르다).
 * - `unverified` — 시각 · 편집자는 같지만 같은 분 안의 편집일 수 있다. 내용으로 확인해야 한다.
 */
export type RemoteVerdict = "unchanged" | "changed" | "unverified";

/** 판정에 쓰는 원격 페이지의 두 값 — 페이지 객체 · 검색 결과 · DB 조회 결과가 모두 갖는다. */
export interface RemotePageStamp {
  readonly last_edited_time: string;
  readonly last_edited_by?: { readonly id: string } | null;
}

/** 한 번의 동기화가 원격을 보는 기준 — 판정 · 기록에 함께 쓴다. */
export interface ObservationContext {
  /**
   * 이번 동기화가 시작한 시각. 원격을 «본» 시각으로 적는다 — 실제로 본 시각보다 이르거나 같아서
   * 가라앉았다고 서둘러 보지 않는다. 동기화 밖이면 null(가라앉았다고 보지 않는다).
   */
  readonly seenAt: string | null;
  /** 이 토큰의 봇 id. 받지 못했으면 null — 봇 규칙 없이 가른다. */
  readonly botUserId: string | null;
}

/** 동기화 밖의 기준 — 아무것도 가라앉았다고 보지 않는다. */
export const NO_OBSERVATION: ObservationContext = { seenAt: null, botUserId: null };

type ObservedRecord = Pick<SyncRecord, "notionLastEdited" | "notionLastEditedBy" | "notionSeenAt">;

/** 원격 페이지의 마지막 편집자 id. 응답에 없으면 null. */
export function editorOf(page: RemotePageStamp): string | null {
  return page.last_edited_by?.id ?? null;
}

/** 판정에 쓰는 값만 남긴 원격 페이지 — 긴 목록이 페이지 객체 전체를 붙잡지 않게. */
export function remoteStampOf(
  page: RemotePageStamp & { readonly id: string },
): RemotePageStamp & { readonly id: string } {
  const editor = editorOf(page);
  return {
    id: page.id,
    last_edited_time: page.last_edited_time,
    last_edited_by: editor === null ? null : { id: editor },
  };
}

/** `seenAt` 에 본 원격 페이지의 기록. */
export function observationOf(page: RemotePageStamp, seenAt: string | null): RemoteObservation {
  return { lastEdited: page.last_edited_time, lastEditedBy: editorOf(page), seenAt };
}

/** 레코드에서 원격을 본 기록을 담는 칸. */
export type ObservedRecordFields = Pick<
  SyncRecord,
  "notionLastEdited" | "notionLastEditedBy" | "notionSeenAt" | "notionBodyFingerprint"
>;

/**
 * `seenAt` 에 본 원격 페이지를 레코드에 적을 값 — upsert 에 펼쳐 넣는다.
 *
 * @param bodyFingerprint 그 원격 본문의 지문. 모르면 null — 다음 push 가 원격을 덮어쓰기 전에
 *   확인할 길이 없어, 원격이 바뀐 것으로 보이면 pull 을 먼저 하라며 거절한다.
 */
export function observedRecordFields(
  page: RemotePageStamp,
  seenAt: string | null,
  bodyFingerprint: string | null,
): ObservedRecordFields {
  return {
    notionLastEdited: page.last_edited_time,
    notionLastEditedBy: editorOf(page),
    notionSeenAt: seenAt,
    notionBodyFingerprint: bodyFingerprint,
  };
}

/**
 * 수정 시각이 `lastEdited` 인 페이지를 `seenAt` 에 봤으면 그 분의 편집을 모두 본 것인가.
 * 모르는 값이 있으면 아니다.
 */
export function isSettled(lastEdited: string | null, seenAt: string | null): boolean {
  if (lastEdited === null || seenAt === null) return false;
  const edited = Date.parse(lastEdited);
  const seen = Date.parse(seenAt);
  if (Number.isNaN(edited) || Number.isNaN(seen)) return false;
  return seen >= edited + EDIT_TIME_RESOLUTION_MS + CLOCK_SKEW_MARGIN_MS;
}

/**
 * 지난번에 본 원격(레코드)과 지금 원격을 견준다.
 *
 * @param botUserId 이 토큰의 봇 id. 모르면 null — 봇 규칙 없이 가라앉음으로만 가른다.
 */
export function compareRemote(
  record: ObservedRecord,
  page: RemotePageStamp,
  botUserId: string | null,
): RemoteVerdict {
  if (page.last_edited_time !== record.notionLastEdited) return "changed";
  const editor = editorOf(page);
  if (
    editor !== null &&
    record.notionLastEditedBy !== null &&
    editor !== record.notionLastEditedBy
  ) {
    return "changed";
  }
  if (isSettled(record.notionLastEdited, record.notionSeenAt)) return "unchanged";
  // 우리가 쓴 뒤 편집자가 그대로 봇이면 그 뒤에 사람이 고치지 않았다. 같은 토큰을 쓰는 다른
  // 기기의 쓰기와, 사람이 고친 직후 같은 분 안의 우리 쓰기는 가리지 못한다(ADR-017).
  if (botUserId !== null && editor === botUserId && record.notionLastEditedBy === botUserId) {
    return "unchanged";
  }
  return "unverified";
}

/** Notion 이 내주는 URL — 괄호 · 따옴표 · 꺾쇠 · 공백에서 끝난다. */
const URL_RE = /https?:\/\/[^\s)"'<>\]]+/g;

/**
 * 원격 본문(Notion markdown)의 지문 — 같은 본문이면 같다.
 *
 * - 자식 페이지 · 자식 DB 태그는 뺀다. 자식은 따로 추적하는 페이지다 — 우리가 폴더에 노트를
 *   만들면 부모 본문에 태그가 생기지만 부모의 본문은 그대로다.
 * - Notion 이 호스팅하는 파일 URL 의 쿼리는 뺀다. 서명이라 읽을 때마다 바뀐다(약 1시간 만료).
 * - 태그를 뺀 자리의 빈 줄 · 줄 끝 공백은 본문이 아니다.
 *
 * 본문을 바꾼 응답(`pages.updateMarkdown`)의 markdown 은 다시 읽은 markdown 과 같다 — 실측
 * (2026-09-27, 자식이 있는 페이지). 그래서 push 는 응답으로 지문을 얻는다.
 */
export function remoteBodyFingerprint(markdown: string): string {
  const body = markdown
    .replace(CHILD_PAGE_TAG_RE, "")
    .replace(CHILD_DATABASE_TAG_RE, "")
    .replace(URL_RE, (url) => (isNotionHostedFileUrl(url) ? url.split("?")[0]! : url))
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return computeHash(body);
}
