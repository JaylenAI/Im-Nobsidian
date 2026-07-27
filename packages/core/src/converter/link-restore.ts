import { WIKILINK_PROTOCOL, EMBED_PROTOCOL } from "../constants/markers.js";
import { decodeMarkerTarget, MARKER_URL_CAPTURE, MARKER_LABEL_CAPTURE } from "./marker-url.js";

/**
 * Pull 시 Notion 측 링크 표현을 Obsidian 위키링크/임베드로 복원하는 공유 로직.
 *
 * 본문(MentionToWikilink)과 프론트매터 속성 값(FrontmatterGenerator) 양쪽이
 * 동일한 규칙을 써야 하므로 한곳에서 정의한다. 마커가 없는 문자열에는 무영향(no-op).
 */

/** Notion 페이지 링크 → `[[display]]`. */
const NOTION_LINK_REGEX = new RegExp(
  `\\[${MARKER_LABEL_CAPTURE}\\]\\((?:https:\\/\\/(?:www\\.)?notion\\.so\\/|notion:\\/\\/)([a-f0-9-]+)\\)`,
  "g",
);

/** 위키링크 보존 마커 → `[[target]]` 또는 `[[target|display]]`. */
const WIKILINK_PRESERVE_REGEX = new RegExp(
  `\\[${MARKER_LABEL_CAPTURE}\\]\\(${WIKILINK_PROTOCOL}${MARKER_URL_CAPTURE}\\)`,
  "g",
);

/**
 * 임베드 보존 마커 → `![[target]]`. **해독 전용 레거시 경로** — 지금은 아무도 이 형태를
 * 만들지 않는다. Notion 이 미지원 스킴을 버려 `![[대상]]` 이 평문으로 붕괴했기 때문에
 * 노트 임베드는 원문 그대로 올리도록 바뀌었다(`pre-processors/embed.ts` 참조).
 * 구버전이 남긴 본문을 만나도 되살릴 수 있도록 해독만 유지한다.
 */
const EMBED_PRESERVE_REGEX = new RegExp(
  `\\[${MARKER_LABEL_CAPTURE}\\]\\(${EMBED_PROTOCOL}${MARKER_URL_CAPTURE}\\)`,
  "g",
);

/** 문자열에서 링크 보존 마커를 위키링크/임베드로 복원한다. */
export function restoreLinkMarkers(text: string): string {
  let out = text.replace(NOTION_LINK_REGEX, (_match, display: string) => `[[${display}]]`);

  out = out.replace(WIKILINK_PRESERVE_REGEX, (_match, display: string, encodedTarget: string) => {
    const target = decodeMarkerTarget(encodedTarget);
    return target === display ? `[[${target}]]` : `[[${target}|${display}]]`;
  });

  out = out.replace(EMBED_PRESERVE_REGEX, (_match, _display: string, encodedTarget: string) => {
    return `![[${decodeMarkerTarget(encodedTarget)}]]`;
  });

  return out;
}

/**
 * 프론트매터 속성 값(문자열/배열) 안의 링크 보존 마커를 재귀적으로 복원한다.
 * 숫자·불리언·날짜 등 비문자열 값은 그대로 둔다.
 */
export function restoreLinkMarkersInValue(value: unknown): unknown {
  if (typeof value === "string") return restoreLinkMarkers(value);
  if (Array.isArray(value)) return value.map((v) => restoreLinkMarkersInValue(v));
  return value;
}
