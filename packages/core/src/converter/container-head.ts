/**
 * push 가 Obsidian 콜아웃 · 토글을 NFM 컨테이너(`<callout>` · `<details>`)로 바꾸는 머리 줄 — SSOT.
 *
 * 변환기(enhanced-md-converter 의 convertObsidianCallouts · convertTogglesToHtml)와 임베드
 * 자리표시자(pre-processors/embed)가 같은 규칙을 봐야 한다. 변환기가 컨테이너로 보지 않는 인용 —
 * `>[!note]` 처럼 `>` 뒤 공백이 없거나, 종류에 낱말 글자가 아닌 것이 섞이거나, 접기 표시가 없는
 * `[!toggle]` — 은 일반 인용으로 Notion 에 가고, 그 안에 둔 자리표시자는 Notion 이 앞뒤 글과 이어 붙인다.
 *
 * 인용 안의 머리는 바깥 인용 접두(`> `)를 한 겹씩 뗀 줄로 묻는다 — 변환기도 그렇게 벗기며 안쪽
 * 머리를 찾는다.
 */

/** 콜아웃 머리 줄 — 들여쓰기(0~3칸) · `> [!종류]` · 접기 표시 · 제목. 종류는 낱말 글자만. */
export const CALLOUT_HEAD_LINE_RE = /^([ \t]{0,3})> \[!(\w+)\]([-+])?[ \t]*(.*)$/;

/** 토글 머리 — 들여쓰기(0~3칸) · 소문자 `[!toggle]-`. 본문까지 잡는 정규식이 뒤를 잇도록 원문으로 둔다. */
export const TOGGLE_HEAD_SOURCE = String.raw`^([ \t]{0,3})> \[!toggle\]-`;

const TOGGLE_HEAD_RE = new RegExp(TOGGLE_HEAD_SOURCE);

/** 머리 꼴이 콜아웃이어도 콜아웃으로 바꾸지 않는 종류 — 토글(`[!toggle]-` 만 토글이다) · 탭. */
const NOT_CALLOUT_KINDS: ReadonlySet<string> = new Set(["toggle", "tab"]);

export type PushContainerKind = "callout" | "toggle";

/** push 가 이 줄을 컨테이너 머리로 바꾸는가 — 바꾸지 않으면 null. */
export function pushContainerKind(line: string): PushContainerKind | null {
  if (TOGGLE_HEAD_RE.test(line)) return "toggle";
  const kind = CALLOUT_HEAD_LINE_RE.exec(line)?.[2]?.toLowerCase();
  return kind === undefined || NOT_CALLOUT_KINDS.has(kind) ? null : "callout";
}
