/**
 * Notion 멘션(사용자 · 날짜 · DB · 데이터 소스 · 에이전트) ↔ 볼트 짝 마커 (F-01 · F-02).
 *
 * Markdown API 는 멘션을 이름 없는 태그로 내보낸다 — `<mention-user url="user://…"/>`,
 * `<mention-date start="2026-09-26" startTime="09:00" end="2026-09-27" endTime="18:00"
 * timeZone="Etc/GMT-9"/>`(실측). 예전 pull 은 옛 모양(`<mention-user id>이름</mention-user>`)만 알아
 * 사용자 멘션 태그를 볼트에 그대로 남겼고(읽기 보기에서 빈칸, 편집 화면에서 줄 끊김), 날짜는 시작
 * 날짜만 평문으로 남겨 시각 · 끝 · 시간대를 버렸다. 볼트에는 멘션 문법이 없으니 다음 push 가 Notion
 * 쪽 멘션까지 평문으로 바꿨다.
 *
 * pull 은 태그의 속성을 짝 마커({@link mentionMarker})에 그대로 싣고 사이에 보이는 글을 둔다 —
 * 사용자는 `@이름`, 날짜는 `2026-09-26 09:00 → 2026-09-27 18:00 (UTC+9)`. push 는 마커에서 태그를
 * 되살린다. 날짜는 보이는 글을 고쳤으면 고친 글을 읽어 새 멘션을 만들고, 날짜로 읽지 못하면 글로
 * 보낸다. 페이지 멘션은 위키링크가 맡는다(`enhanced-md-converter` 의 `convertPageMentions`).
 *
 * 코드(펜스 · 인라인) 안의 태그와 마커는 사용자가 적은 글자라 건드리지 않는다.
 */
import {
  MARKER_BRAND_RE,
  MARKER_PAYLOAD_CHAR,
  MENTION_END,
  mentionMarker,
} from "../constants/markers.js";
import { isNotionId } from "../utils/id.js";
import { mapOutsideCode } from "../utils/md-regions.js";

/** 짝 마커로 싣는 멘션 종류 — Notion 문서의 멘션 목록에서 페이지를 뺀 것이다. */
const MENTION_KINDS = ["user", "date", "database", "data-source", "agent"] as const;
type MentionKind = (typeof MENTION_KINDS)[number];

/** 태그 속성 — Notion 이 내보낸 순서 그대로. 되살릴 때 같은 순서로 적는다. */
type Attrs = ReadonlyArray<readonly [string, string]>;

/** 이름을 모를 때 보이는 글 — 날짜는 속성에서 만든다({@link dateMentionLabel}). */
const FALLBACK_LABEL: Readonly<Record<Exclude<MentionKind, "date">, string>> = {
  user: "@user",
  database: "Notion database",
  "data-source": "Notion data source",
  agent: "Notion agent",
};

const KIND_SOURCE = MENTION_KINDS.join("|");

/** NFM 멘션 태그 — 닫힌 형태(`…/>`)와 이름이 든 형태(`…>이름</mention-…>`) 둘 다 온다. */
const NFM_MENTION_RE = new RegExp(
  `<mention-(${KIND_SOURCE})((?:\\s+[A-Za-z][\\w-]*="[^"]*")*)\\s*(?:\\/>|>([^<]*)<\\/mention-\\1>)`,
  "g",
);
const ATTR_RE = /([A-Za-z][\w-]*)="([^"]*)"/g;

/** 볼트의 짝 마커. 보이는 글은 한 줄 안에 있다. */
const VAULT_MENTION_RE = new RegExp(
  `%%${MARKER_BRAND_RE}:mention-(${KIND_SOURCE}):(${MARKER_PAYLOAD_CHAR}*)%%([^\\n]*?)${MENTION_END}`,
  "g",
);

function parseAttrs(raw: string): Array<[string, string]> {
  return [...raw.matchAll(ATTR_RE)].map((m) => [m[1]!, m[2]!]);
}

function attrValue(attrs: Attrs, name: string): string | undefined {
  return attrs.find(([k]) => k === name)?.[1];
}

function attrString(attrs: Attrs): string {
  return attrs.map(([k, v]) => ` ${k}="${v.replace(/"/g, "&quot;")}"`).join("");
}

/** 마커 페이로드(`k=v&k=v`, 값은 퍼센트 인코딩)를 속성으로. */
function parsePayload(payload: string): Array<[string, string]> {
  if (payload === "") return [];
  return payload.split("&").map((pair) => {
    const at = pair.indexOf("=");
    const key = at === -1 ? pair : pair.slice(0, at);
    const raw = at === -1 ? "" : pair.slice(at + 1);
    try {
      return [key, decodeURIComponent(raw)];
    } catch {
      return [key, raw];
    }
  });
}

/** 사용자 멘션의 사용자 id — `url="user://<id>"`(지금) 또는 `id="<id>"`(옛 모양). */
function userIdOf(attrs: Attrs): string | undefined {
  const url = attrValue(attrs, "url");
  const id = url?.startsWith("user://") ? url.slice("user://".length) : attrValue(attrs, "id");
  return id && isNotionId(id) ? id : undefined;
}

/** 보이는 글은 마커 사이 한 줄에 산다 — 줄바꿈과 마커 구분자(`%%`)를 들이지 않는다. */
function safeLabel(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").replace(/%%/g, "%");
}

// ─── 날짜 ───

/** 날짜 멘션의 날짜 속성 — 이 순서로 적는다(실측 순서). */
const DATE_KEYS = ["start", "startTime", "end", "endTime", "timeZone"] as const;
type DateParts = Partial<Record<(typeof DATE_KEYS)[number], string>>;

/** `Etc/GMT-9` 는 UTC+9 다 — IANA 의 Etc 시간대는 부호가 반대다. */
const ETC_GMT_RE = /^Etc\/GMT([+-])(\d{1,2})$/;
const UTC_OFFSET_LABEL_RE = /^UTC([+-])(\d{1,2})$/;

function timeZoneLabel(timeZone: string): string {
  const m = ETC_GMT_RE.exec(timeZone);
  return m ? `UTC${m[1] === "-" ? "+" : "-"}${m[2]}` : timeZone;
}

function timeZoneFromLabel(label: string): string {
  const m = UTC_OFFSET_LABEL_RE.exec(label);
  return m ? `Etc/GMT${m[1] === "+" ? "-" : "+"}${m[2]}` : label;
}

/** 날짜 멘션의 보이는 글 — `시작[ 시각][ → 끝[ 시각]][ (시간대)]`. 시작이 없으면 `date`. */
export function dateMentionLabel(attrs: Attrs): string {
  const start = attrValue(attrs, "start");
  if (!start) return "date";
  const startTime = attrValue(attrs, "startTime");
  const end = attrValue(attrs, "end");
  const endTime = attrValue(attrs, "endTime");
  const timeZone = attrValue(attrs, "timeZone");
  let label = startTime ? `${start} ${startTime}` : start;
  if (end) label += ` → ${endTime ? `${end} ${endTime}` : end}`;
  else if (endTime) label += ` → ${endTime}`;
  if (timeZone) label += ` (${timeZoneLabel(timeZone)})`;
  return label;
}

const DATE_SRC = "(\\d{4}-\\d{2}-\\d{2})";
const TIME_SRC = "(\\d{2}:\\d{2})";
/** {@link dateMentionLabel} 의 모양. 사용자가 치기 쉽게 `->` 도 화살표로 받는다. */
const DATE_LABEL_RE = new RegExp(
  `^${DATE_SRC}(?: ${TIME_SRC})?(?: (?:→|->) (?:${DATE_SRC}(?: ${TIME_SRC})?|${TIME_SRC}))?(?: \\(([^()]+)\\))?$`,
);

function isValidDate(date: string): boolean {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

function isValidTime(time: string): boolean {
  const [h, m] = time.split(":").map(Number) as [number, number];
  return h < 24 && m < 60;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * 고친 보이는 글을 날짜로 읽는다 — 읽지 못하거나 없는 날짜 · 시각 · 시간대면 null.
 *
 * 사람이 고친 글이라 Notion 이 내보내지 않는 모양도 들어온다. 끝에 시각만 적으면(`→ 18:00`) 같은
 * 날 끝이다. 기간의 한쪽에만 시각이 있거나 끝이 시작보다 앞서면 읽지 않는다 — 그런 멘션을 보내면
 * Notion 이 본문 교체를 통째로 거절할 수 있다. 시각이 없으면 시간대를 버린다 — 하루짜리 날짜에는
 * 시간대가 없다.
 */
export function parseDateMentionLabel(label: string): DateParts | null {
  const m = DATE_LABEL_RE.exec(label);
  if (!m) return null;
  const start = m[1]!;
  const startTime = m[2];
  const endTime = m[4] ?? m[5];
  const end = m[3] ?? (m[5] ? start : undefined);
  const timeZone = m[6] ? timeZoneFromLabel(m[6]) : undefined;

  if (![start, end].every((d) => d === undefined || isValidDate(d))) return null;
  if (![startTime, endTime].every((t) => t === undefined || isValidTime(t))) return null;
  if (end && Boolean(startTime) !== Boolean(endTime)) return null;
  if (end && `${end} ${endTime ?? ""}` < `${start} ${startTime ?? ""}`) return null;
  if (timeZone && !isValidTimeZone(timeZone)) return null;

  const parts: DateParts = { start };
  if (startTime) parts.startTime = startTime;
  if (end) parts.end = end;
  if (endTime) parts.endTime = endTime;
  if (timeZone && startTime) parts.timeZone = timeZone;
  return parts;
}

/** 날짜 속성만 새 값으로 — Notion 이 더 붙인 속성은 그대로 둔다. */
function withDateParts(attrs: Attrs, parts: DateParts): Attrs {
  const dateKeys: ReadonlySet<string> = new Set(DATE_KEYS);
  const fresh = DATE_KEYS.flatMap((k) => (parts[k] ? [[k, parts[k]] as const] : []));
  return [...fresh, ...attrs.filter(([k]) => !dateKeys.has(k))];
}

// ─── pull ───

function labelOf(
  kind: MentionKind,
  attrs: Attrs,
  inner: string | undefined,
  userNames: ReadonlyMap<string, string> | undefined,
): string {
  if (kind === "date") return dateMentionLabel(attrs);
  const named = inner?.trim();
  if (kind === "user") {
    const id = userIdOf(attrs);
    const name = named || (id ? userNames?.get(id) : undefined);
    if (!name) return FALLBACK_LABEL.user;
    return safeLabel(name.startsWith("@") ? name : `@${name}`);
  }
  return named ? safeLabel(named) : FALLBACK_LABEL[kind];
}

/** 이름을 물어야 할 사용자 멘션의 사용자 id — 코드 안의 태그는 빼고. */
export function mentionUserIds(enhanced: string): string[] {
  const ids = new Set<string>();
  mapOutsideCode(enhanced, (segment) => {
    for (const m of segment.matchAll(NFM_MENTION_RE)) {
      if (m[1] !== "user" || m[3]?.trim()) continue;
      const id = userIdOf(parseAttrs(m[2]!));
      if (id) ids.add(id);
    }
    return segment;
  });
  return [...ids];
}

/**
 * NFM 멘션 태그를 짝 마커로 바꾼다(pull).
 *
 * @param userNames 사용자 id → 이름. 없는 사용자는 {@link FALLBACK_LABEL} 로 보인다.
 */
export function mentionsToMarkers(
  enhanced: string,
  userNames?: ReadonlyMap<string, string>,
): string {
  return mapOutsideCode(enhanced, (segment) =>
    segment.replace(
      NFM_MENTION_RE,
      (_m, kind: MentionKind, rawAttrs: string, inner: string | undefined) => {
        const attrs = parseAttrs(rawAttrs);
        return `${mentionMarker(kind, attrs)}${labelOf(kind, attrs, inner, userNames)}${MENTION_END}`;
      },
    ),
  );
}

// ─── push ───

function restoreDate(attrs: Attrs, label: string): string {
  if (label === dateMentionLabel(attrs)) return `<mention-date${attrString(attrs)}/>`;
  const edited = parseDateMentionLabel(label.trim());
  // 날짜로 읽지 못하는 글 — 사용자가 멘션을 글로 바꾼 것이다.
  if (!edited) return label;
  return `<mention-date${attrString(withDateParts(attrs, edited))}/>`;
}

function restoreMention(kind: MentionKind, attrs: Attrs, label: string): string {
  if (kind === "date") return restoreDate(attrs, label);
  // 보이는 글을 지웠으면 멘션을 지운 것이다.
  if (label.trim() === "") return "";
  if (label === FALLBACK_LABEL[kind]) return `<mention-${kind}${attrString(attrs)}/>`;
  // 안의 이름은 보이는 글일 뿐이다 — 누구 · 무엇인지는 url 이 정하고 Notion 이 이름을 다시 붙인다.
  // 그래도 싣는 까닭은 문서가 쓰는 형태라서이고, Notion 을 거치지 않은 왕복(오프라인)도 같은
  // 글로 돌아오게 하려서다.
  const inner = (kind === "user" ? label.replace(/^@/, "") : label).replace(/[<>]/g, "");
  return `<mention-${kind}${attrString(attrs)}>${inner}</mention-${kind}>`;
}

/** 짝 마커를 NFM 멘션 태그로 되살린다(push). */
export function markersToMentions(obsidian: string): string {
  return mapOutsideCode(obsidian, (segment) =>
    segment.replace(VAULT_MENTION_RE, (_m, kind: MentionKind, payload: string, label: string) =>
      restoreMention(kind, parsePayload(payload), label),
    ),
  );
}

/**
 * 짝 마커를 보이는 글만 남기고 걷어낸다 — 멘션을 표현할 수 없는 블록 방식 push 전용. 마커 글자가
 * Notion 본문에 새지 않게 한다(색 · 밑줄 마커와 같은 강등).
 */
export function stripMentionMarkers(obsidian: string): string {
  return obsidian.replace(
    VAULT_MENTION_RE,
    (_m, _kind: string, _payload: string, label: string) => label,
  );
}
