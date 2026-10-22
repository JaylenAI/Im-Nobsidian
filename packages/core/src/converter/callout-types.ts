/**
 * Obsidian 콜아웃 종류와 Notion 콜아웃 아이콘의 대응 — 콜아웃의 종류 · 아이콘은 모두 이 표에서 읽는다.
 *
 * 종류마다 아이콘이 하나다. 별칭(Obsidian 이 같은 모양으로 그리는 이름 — https://help.obsidian.md/callouts)은
 * 그 종류의 아이콘으로 보내고, 받으면 첫 이름으로 돌아온다. 로컬 노트에 적은 별칭은 pull 이 되살린다
 * (`restoreLocalForm`). 표에 없는 종류는 아이콘 없이 보낸다.
 *
 * 예전에는 표가 넷이었고 둘이 `abstract` · `example` 의 아이콘을 거꾸로 적었다 — 블록 경로로 받은
 * `abstract` 가 `example` 로 돌아왔다. 별칭은 어느 표에도 없어 `[!faq]` 가 아이콘 없이 올라가 `[!note]` 로
 * 돌아왔다(F-06, 2026-10-04 실측).
 */
const CALLOUT_ICONS: ReadonlyArray<readonly [icon: string, types: readonly string[]]> = [
  ["\u{1F4DD}", ["note"]],
  ["\u{1F4CC}", ["abstract", "summary", "tldr"]],
  ["\u{2139}\u{FE0F}", ["info"]],
  ["\u{2611}\u{FE0F}", ["todo"]],
  ["\u{1F4A1}", ["tip", "hint", "important"]],
  ["\u{2705}", ["success", "check", "done"]],
  ["\u{2753}", ["question", "help", "faq"]],
  ["\u{26A0}\u{FE0F}", ["warning", "caution", "attention"]],
  ["\u{274C}", ["failure", "fail", "missing"]],
  ["\u{1F525}", ["danger", "error"]],
  ["\u{1F41B}", ["bug"]],
  ["\u{1F4CB}", ["example"]],
  ["\u{1F4AC}", ["quote", "cite"]],
];

/** 아이콘을 알 수 없는 콜아웃의 종류 — Obsidian 도 모르는 종류를 이것처럼 그린다. */
export const DEFAULT_CALLOUT_TYPE = "note";

const TYPE_BY_ICON = new Map(CALLOUT_ICONS.map(([icon, types]) => [icon, types[0]!]));
const ICON_BY_TYPE = new Map(
  CALLOUT_ICONS.flatMap(([icon, types]) => types.map((type) => [type, icon] as const)),
);

/** 아이콘이 가리키는 종류 — 표에 없는 아이콘이면 {@link DEFAULT_CALLOUT_TYPE}. */
export function calloutTypeOf(icon: string): string {
  return TYPE_BY_ICON.get(icon) ?? DEFAULT_CALLOUT_TYPE;
}

/** 종류(별칭 포함, 대소문자 무시)의 아이콘 — 표에 없는 종류면 undefined. */
export function calloutIconOf(type: string): string | undefined {
  return ICON_BY_TYPE.get(type.toLowerCase());
}

/** 표의 아이콘과 그 종류(첫 이름) — 아이콘마다 줄을 찾는 곳이 쓴다. */
export function calloutIcons(): ReadonlyArray<readonly [icon: string, type: string]> {
  return [...TYPE_BY_ICON];
}
