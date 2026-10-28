import { LARGE_FILE_MARKER } from "../constants/markers.js";
import { compactNotionId } from "../utils/id.js";
import { DEGRADE_LINK_SOURCE, degradeLink } from "./degrade-link.js";

/**
 * 크기 상한(`advanced.maxFileSizeBytes`)을 넘어 받지 않은 Notion 파일 — 볼트에는 Notion 의 서명 URL 링크만 남는다.
 * 그 URL 은 한 시간쯤 뒤 끊겨, 볼트에서는 파일을 열 길이 없었다. 그 옆에 끊기지 않는 «Notion 에서 열기» 링크를 둔다.
 *
 * 서명 URL 링크는 그대로 둔다 — push 가 그것을 파일 태그로 되돌려 Notion 이 그 블록을 둔다. 덧붙인 링크는 보여주기용이라
 * push 맨 앞에서 마커와 함께 뗀다({@link stripLargeFileLinks}).
 */

/** 덧붙인 링크 한 쌍(앞 공백 · 링크 · 마커). */
const LARGE_FILE_LINK_RE = new RegExp(` ?${DEGRADE_LINK_SOURCE}${LARGE_FILE_MARKER}`, "g");

/** 그 파일이 든 페이지(블록을 알면 그 블록)의 Notion 주소 — 로그인해 열면 내려받을 수 있다. */
export function notionFileLocation(pageId: string, blockId?: string | null): string {
  const page = `https://www.notion.so/${compactNotionId(pageId)}`;
  return blockId ? `${page}#${compactNotionId(blockId)}` : page;
}

/** 사람이 읽는 크기 — 1MB 아래는 KB 로. 상한은 낮출 수 있어(최소 1KB) MB 로만 적으면 5KB 가 「1MB」 였다. */
export function fileSizeLabel(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${Math.round(mb)}MB` : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/** 덧붙일 링크. */
export function largeFileLink(location: string, bytes: number): string {
  return ` ${degradeLink(`↗ Notion 에서 열기 · ${fileSizeLabel(bytes)}`, location, LARGE_FILE_MARKER)}`;
}

/**
 * `content` 의 `fileLink` 바로 뒤에 «Notion 에서 열기» 링크를 둔다. 이미 있으면 바꾼다 — 볼트의 글을 그대로 둔 pull 이
 * 다시 불러도 하나다.
 */
export function withLargeFileLink(content: string, fileLink: string, link: string): string {
  const at = content.indexOf(fileLink);
  if (at < 0) return content;
  const end = at + fileLink.length;
  const sticky = new RegExp(LARGE_FILE_LINK_RE.source, "y");
  sticky.lastIndex = end;
  const existing = sticky.exec(content);
  const rest = existing ? end + existing[0].length : end;
  return `${content.slice(0, end)}${link}${content.slice(rest)}`;
}

/** push — 덧붙인 링크를 뗀다. 파일 링크는 그대로다. */
export function stripLargeFileLinks(content: string): string {
  return content.includes(LARGE_FILE_MARKER) ? content.replace(LARGE_FILE_LINK_RE, "") : content;
}
