/**
 * 시각을 시간대의 벽시계 시각으로, 벽시계 시각을 오프셋이 붙은 시각으로 바꾼다(F-08).
 *
 * Obsidian 의 날짜시각 속성은 시간대가 없는 `YYYY-MM-DDTHH:mm` 이다 — 초 · 밀리초 · `Z` · `+09:00` 이
 * 붙으면 글로 본다(2026-10-04 Obsidian 1.12.4 실측). Notion 은 오프셋 없는 시각을 UTC 로 읽는다(같은 날
 * 실측: `2026-10-01T10:00` 을 보내면 `2026-10-01T10:00:00.000+00:00`). 그래서 pull 은 시각을 시간대의
 * 벽시계 시각으로 적고, push 는 그 시간대의 오프셋을 붙여 보낸다 — 같은 순간이다.
 */

/** 오프셋이 붙은 시각 — Notion 이 돌려주는 모양. */
const ZONED_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/** 오프셋이 없는 시각 — Obsidian 날짜시각 속성의 모양과, 초 · 밀리초가 붙은 것. */
const WALL_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

const MINUTE_MS = 60_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

interface WallParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function wallParts(instant: number, timeZone: string): WallParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    second: part("second"),
  };
}

/** 그 순간에 시간대의 시계가 UTC 보다 몇 분 앞서나. */
function offsetMinutes(instant: number, timeZone: string): number {
  const second = Math.floor(instant / 1000) * 1000;
  const p = wallParts(second, timeZone);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((wallAsUtc - second) / MINUTE_MS);
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * 이 컴퓨터의 시간대(IANA 이름). 부를 때마다 읽는다 — 앱이 켜진 채 시간대가 바뀔 수 있다.
 */
export function systemTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** IANA 시간대 이름인가 — 설정을 읽을 때 가른다. */
export function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * 오프셋이 붙은 시각을 시간대의 벽시계 시각으로 — `YYYY-MM-DDTHH:mm`. 초 · 밀리초가 0 이 아니면 붙인다
 * (잃지 않는다 — Obsidian 은 그 값을 글로 본다). 날짜만 있거나 읽을 수 없으면 그대로 돌려준다.
 */
export function toWallTime(iso: string, timeZone: string): string {
  if (!ZONED_DATETIME_RE.test(iso)) return iso;
  const instant = Date.parse(iso);
  if (Number.isNaN(instant)) return iso;
  const p = wallParts(instant, timeZone);
  const ms = ((instant % 1000) + 1000) % 1000;
  let wall = `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
  if (p.second !== 0 || ms !== 0) wall += `:${pad(p.second)}`;
  if (ms !== 0) wall += `.${pad(ms, 3)}`;
  return wall;
}

/** 오프셋 없는 시각인가 — {@link toZonedIso} 가 바꾸는 모양. */
export function isWallTime(text: string): boolean {
  return WALL_TIME_RE.test(text);
}

/**
 * 오프셋 없는 시각에 시간대의 오프셋을 붙인다 — `2026-10-01T10:00` → `2026-10-01T10:00:00+09:00`.
 * 달력에 없는 날짜 · 시각이면 null. 서머타임으로 건너뛴 시각(봄에 시계를 당긴 한 시간)은 당기기 전의
 * 오프셋으로, 겹치는 시각(가을에 되돌린 한 시간)은 앞의 것으로 붙인다.
 */
export function toZonedIso(wall: string, timeZone: string): string | null {
  const m = WALL_TIME_RE.exec(wall);
  if (!m) return null;
  const [, y, mo, d, h, mi, s = "00", ms] = m;
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(asUtc);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }
  // 그 벽시계 시각이 되는 순간을 찾는다 — 오프셋을 어림해 순간을 잡고, 그 순간의 오프셋으로 다시 잡는다.
  // 앞뒤 오프셋 둘 중 그 순간에 정말 그 벽시계 시각이 되는 쪽을 고른다. 둘 다 아니면(건너뛴 시각) 앞의
  // 오프셋이다.
  const before = offsetMinutes(asUtc - 24 * 60 * MINUTE_MS, timeZone);
  const after = offsetMinutes(asUtc + 24 * 60 * MINUTE_MS, timeZone);
  const fits = (offset: number) => offsetMinutes(asUtc - offset * MINUTE_MS, timeZone) === offset;
  const offset = fits(before) ? before : fits(after) ? after : before;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${ms ? `.${ms}` : ""}${formatOffset(offset)}`;
}
