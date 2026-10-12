/**
 * 마크다운 표현이 없는 블록(북마크 · 임베드 · 자리 태그로만 오는 블록)의 볼트 모양 — 보이는 링크와
 * 뒤따르는 보존 마커 한 쌍. Markdown API 로 받은 본문(`enhanced-md-converter`)과 블록 API 폴백
 * (`block-converter`)이 같은 모양을 쓴다 — 어느 길로 받았든 push 가 같은 블록으로 되돌린다.
 */
import { embedMarker } from "../constants/markers.js";

/**
 * 마크다운 표현이 없는 블록의 **가시 폴백** — 클릭 가능한 링크 + 권위 마커 한 쌍.
 *
 * 마커만 남기면 읽기뷰에서 빈 줄로 보여 사용자가 소실로 오해한다. 링크는 보여주기용이고
 * 왕복 권위는 뒤따르는 마커(인코딩된 원본 URL)가 갖는다. 둘을 **공백 없이** 인접시켜
 * push 때 {@link DEGRADE_LINK_SOURCE} 가 한 쌍으로 소비 → Notion drift 를 막는다.
 *
 * 목적지의 괄호는 반드시 인코딩한다. 짝 패턴이 `\([^)]*\)` 로 끝을 잡으므로 날 괄호가
 * 경계를 앞당겨 끊고, 그러면 링크 잔해가 Notion 본문에 평문으로 박제된다(실측 재현:
 * `https://ex.com/a(b)c`). `%28`/`%29` 는 경로·질의 어디서든 원문과 동치다.
 */
export function degradeLink(label: string, url: string, marker: string): string {
  return `[${label}](${url.replace(/\(/g, "%28").replace(/\)/g, "%29")})${marker}`;
}

/**
 * {@link degradeLink} 가 앞세운 가시 링크. 마커 패턴 앞에 붙여 한 쌍으로 소비한다. 이름의 backslash
 * escape 를 받는다 — 북마크 캡션의 대괄호가 `\]` 로 들어온다(F-09).
 */
export const DEGRADE_LINK_SOURCE = "(?:\\[(?:\\\\.|[^\\\\\\]])*\\]\\([^)]*\\))?";

/** 임베드의 볼트 모양 — 이름은 늘 같다(Markdown API 는 임베드의 캡션을 보내지 않는다). */
export function embedVaultLink(src: string): string {
  return degradeLink("🔗 Embed", src, embedMarker(src));
}
