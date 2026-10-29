/**
 * Notion 날짜 필터의 상대 조건 ↔ Bases 날짜 식 — 필터를 옮기는 두 방향(`notion-filter-translator.ts` 와 그 반대)이
 * 같은 표를 읽는다.
 *
 * 2026-10-29 실측(오늘 = 10-29 목, 하루 간격 행 · 같은 날짜의 노트):
 *   - Notion `past_week` 는 오늘 − 7일 ~ 오늘(양 끝 포함), `past_month` 는 오늘 − 1달(09-29) ~ 오늘, `next_week` 는
 *     오늘 ~ 오늘 + 7일, `next_month` 는 오늘 ~ 오늘 + 1달(11-29). Bases 의 `today() - "7d"` · `today() + "1M"` 이 같은
 *     날을 고른다
 *   - `equals` · `before` · … 의 값 `"today"` · `"one_week_ago"` … 는 같은 기준의 날 하나다(2026-03-30 API)
 *   - Notion `this_week` 는 일요일에 시작하는 주였다(10-25 일 ~ 10-31 토). 주 시작 요일은 Notion 설정을 따르고 Bases
 *     에는 주의 시작을 구하는 식이 없어 옮기지 않는다
 *   - 시각이 있는 값은 `.date()` 로 날만 견준다 — `note["시각"] > today()` 는 오늘 09:00 도 고른다. Notion 은 날로 견준다
 *
 * Notion 은 API 연결(internal integration)의 «오늘» 을 UTC 로 정하고 Bases 는 이 컴퓨터의 시각으로 정한다 — 자정 근처
 * 몇 시간은 두 쪽의 오늘이 하루 어긋날 수 있다.
 */

/** 날짜 비교의 값으로 오는 상대 날짜 → Bases 식. */
export const RELATIVE_DATE_VALUES: Readonly<Record<string, string>> = {
  today: "today()",
  tomorrow: 'today() + "1d"',
  yesterday: 'today() - "1d"',
  one_week_ago: 'today() - "7d"',
  one_week_from_now: 'today() + "7d"',
  one_month_ago: 'today() - "1M"',
  one_month_from_now: 'today() + "1M"',
};

/** 값 없이 오는 상대 기간(`{ past_week: {} }`) → 오늘에서 어느 쪽으로 얼마나. */
export const RELATIVE_DATE_RANGES: Readonly<
  Record<string, { readonly toward: "past" | "next"; readonly span: string }>
> = {
  past_week: { toward: "past", span: "7d" },
  past_month: { toward: "past", span: "1M" },
  past_year: { toward: "past", span: "1y" },
  next_week: { toward: "next", span: "7d" },
  next_month: { toward: "next", span: "1M" },
  next_year: { toward: "next", span: "1y" },
};

/** 상대 날짜와 견줄 때의 왼쪽 — 날만 남긴다. */
export function dateOnly(ref: string): string {
  return `${ref}.date()`;
}

/** 상대 기간을 Bases 식 둘(시작 · 끝, 둘 다 포함)로. */
export function relativeRangeExprs(
  ref: string,
  range: { readonly toward: "past" | "next"; readonly span: string },
): [string, string] {
  const day = dateOnly(ref);
  return range.toward === "past"
    ? [`${day} >= today() - "${range.span}"`, `${day} <= today()`]
    : [`${day} >= today()`, `${day} <= today() + "${range.span}"`];
}
