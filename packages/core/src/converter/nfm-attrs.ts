/**
 * NFM 태그 속성 — 멘션 · 표처럼 태그 속성을 마커에 실어 되살리는 변환이 같이 쓴다.
 *
 * 값은 Notion 이 내보낸 글자 그대로 둔다(`&amp;` 같은 엔티티도 풀지 않는다). 되살릴 때 같은 글자로
 * 적어야 Notion 이 같은 속성으로 읽는다.
 */

/** 태그 속성 — Notion 이 내보낸 순서 그대로. 되살릴 때 같은 순서로 적는다. */
export type NfmAttrs = ReadonlyArray<readonly [string, string]>;

const ATTR_RE = /([A-Za-z][\w-]*)="([^"]*)"/g;

/** 태그 안의 속성 글(` color="red" width="200"`)을 속성으로. */
export function parseNfmAttrs(raw: string): Array<[string, string]> {
  return [...raw.matchAll(ATTR_RE)].map((m) => [m[1]!, m[2]!]);
}

export function nfmAttrValue(attrs: NfmAttrs, name: string): string | undefined {
  return attrs.find(([k]) => k === name)?.[1];
}

/** 속성을 태그 안의 글로 — 앞에 공백 하나를 붙여 `<tag${…}>` 에 그대로 넣는다. */
export function nfmAttrString(attrs: NfmAttrs): string {
  return attrs.map(([k, v]) => ` ${k}="${v.replace(/"/g, "&quot;")}"`).join("");
}
