import { patchRichText, richTextChunks, type RichTextItem } from "./rich-text.js";
import type { Config } from "../types/config.js";
import type { RowPropertyChanges } from "../types/sync.js";
import { plainFrontmatterValue, sameFrontmatterValue } from "../utils/frontmatter.js";
import { isNotionId } from "../utils/id.js";
import { isNotionHostedFileUrl } from "../utils/notion-file-url.js";
import { isWallTime, systemTimeZone, toWallTime, toZonedIso } from "../utils/zoned-time.js";

type NotionPropertySchema = {
  id: string;
  type: string;
  name: string;
};

type NotionPropertyValue = Record<string, unknown>;

// ISO-8601 date / datetime. **양끝 앵커 필수** — 앵커가 없으면 "2026-05-29 마감" 처럼
// 날짜로 시작하는 일반 텍스트가 date 로 오분류되어 본문이 유실되고 Notion 에 잘못된
// 날짜가 전송된다. 초/밀리초/타임존(Z, ±HH:MM)까지 허용해 read→write 라운드트립을 보존.
const DATE_REGEX =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const WIKILINK_REGEX = /^\[\[(.+?)(?:\|.+?)?\]\]$/;

/**
 * 기간(끝이 있는 날짜)의 끝을 적는 짝 키의 꼬리 — `마감` 의 끝은 `마감_end`(F-08).
 *
 * Obsidian 속성에는 기간 타입이 없다. `{start, end}` 객체로 적으면 Obsidian 이 알아보지 못하는 값이라
 * 속성 패널 · Bases 에서 날짜로 쓸 수 없다. 짝 키 둘이면 둘 다 날짜(시각) 속성이다. 이 꼬리가 붙은 이름의
 * 속성이 DB 에 따로 있으면 짝 키를 쓰지 않고 예전처럼 객체로 적는다.
 */
export const RANGE_END_SUFFIX = "_end";

/** 날짜 값을 낼 수 있는 속성 타입 — 기간이면 짝 키에 끝을 적는다. */
const DATE_VALUED_TYPES: ReadonlySet<string> = new Set(["date", "formula", "rollup"]);

/** 시각만 내는 속성 타입 — 기간이 없다. */
const TIMESTAMP_TYPES: ReadonlySet<string> = new Set(["created_time", "last_edited_time"]);

/**
 * 값을 보낼 수 없는 속성 타입 — Notion 이 계산하거나(수식 · 롤업 · 생성일 · ID …) 값이 없다
 * (버튼). 이런 속성을 요청에 넣으면 Notion 이 요청 전체를 거부한다.
 */
const READ_ONLY_TYPES: ReadonlySet<string> = new Set([
  "created_time",
  "last_edited_time",
  "created_by",
  "last_edited_by",
  "formula",
  "rollup",
  "unique_id",
  "verification",
  "button",
]);

/**
 * Notion 은 비어 있는 배열형 속성값을 문서화된 `[]` 가 아니라 빈 객체 `{}` 로
 * 돌려주는 경우가 있다(특히 data source 분리 모델의 일부 행). `as Array<…>` 캐스트는
 * 이 불일치를 숨기고, 뒤따르는 `.map` 호출이 "X.map is not a function" 으로 그 행
 * 전체를 pull 실패시켜 **영구 데이터 손실 + 멱등성(churn) 위반**을 만든다.
 * 모든 배열 추출은 이 가드를 통과시켜, 배열이 아니면 안전하게 빈 배열로 강등한다.
 */
function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export interface WikilinkResolver {
  resolve(title: string): string | null;
  resolvePageId(pageId: string): string | null;
}

export interface PropertyMapperOptions {
  /**
   * 날짜시각을 적고 보낼 시간대(IANA 이름, 설정 `conversion.timeZone`). 없으면 이 컴퓨터의 시간대.
   */
  readonly timeZone?: string;
}

/** {@link PropertyMapper.toNotionPropertyChanges} 가 기준으로 삼는 지금 값들. */
export interface PropertyChangeContext {
  /**
   * 지금 로컬 frontmatter — 기간의 시작과 끝 중 하나만 바뀌어도 둘 다 보내야 해서 읽는다. 없으면 바뀐
   * 값만 본다(새 행처럼 비교할 기준이 없을 때와 같다).
   */
  readonly current?: Readonly<Record<string, unknown>>;
  /**
   * 원격 페이지의 지금 속성(`page.properties`) — 글 속성 · 제목은 이 서식 위에 바뀐 글자만 고친다
   * ({@link patchRichText}). 없으면 평문으로 보낸다.
   */
  readonly remote?: Readonly<Record<string, unknown>>;
}

export class PropertyMapper {
  private schema: Map<string, NotionPropertySchema> = new Map();
  private wikilinkResolver: WikilinkResolver | null = null;

  constructor(private readonly options: PropertyMapperOptions = {}) {}

  /** 설정의 변환 옵션으로 만든다 — 시간대를 이 한 곳에서 읽는다. */
  static fromConfig(config: Pick<Config, "conversion">): PropertyMapper {
    return new PropertyMapper({ timeZone: config.conversion.timeZone });
  }

  setWikilinkResolver(resolver: WikilinkResolver): void {
    this.wikilinkResolver = resolver;
  }

  loadSchema(properties: Record<string, { id: string; type: string }>): void {
    this.schema.clear();
    for (const [name, prop] of Object.entries(properties)) {
      this.schema.set(name, { id: prop.id, type: prop.type, name });
    }
  }

  /**
   * frontmatter 전체를 Notion 속성 값으로 바꾼다 — 비교할 기준이 없는 새 행을 만들 때 쓴다.
   *
   * 스키마를 읽었으면 스키마에 없는 키는 보내지 않는다. pull 이 적는 `cover` · `icon` 이나
   * 사용자가 붙인 `aliases` 처럼 DB 속성이 아닌 키를 보내면 Notion 이 «그런 속성은 없다»
   * 며 요청 전체를 거부한다 — 행의 다른 속성까지 하나도 반영되지 않는다.
   */
  toNotionProperties(
    frontmatter: Record<string, unknown>,
    title: string,
  ): Record<string, NotionPropertyValue> {
    const zone = this.zone();
    const result: Record<string, NotionPropertyValue> = {
      title: { title: [{ text: { content: title } }] },
    };

    for (const [key, raw] of Object.entries(frontmatter)) {
      if (key === "title") continue;
      const value = plainFrontmatterValue(raw);
      if (value === null || value === undefined) continue;

      const schemaProp = this.schema.get(key);
      if (this.rangeOwnerOf(key) !== null) continue; // 짝 키 — 시작 속성과 함께 보낸다
      if (schemaProp && this.hasRangeKey(key)) {
        const converted = this.rangeRequest(key, frontmatter, zone);
        if (converted) result[key] = converted;
      } else if (schemaProp) {
        const converted = this.convertBySchema(schemaProp.type, value, zone);
        if (converted) result[key] = converted;
      } else if (this.schema.size === 0) {
        const inferred = this.inferAndConvert(value, zone);
        if (inferred) result[key] = inferred;
      }
    }

    return result;
  }

  /**
   * 바뀐 속성만 Notion 속성 값으로 바꾼다(S-01).
   *
   * 비운 속성은 그 타입의 빈 값으로 보낸다. 되돌릴 수 없는 것은 비우지 않는다 — `files`
   * 를 비우면 Notion 에 올라간 첨부가 지워지고 볼트에는 그 파일이 없다. `status` 는 빈 값이
   * 없다. 스키마에 없는 키와 읽기 전용 속성(수식 · 롤업 · 생성일 …)도 보내지 않는다.
   *
   * 날짜는 오프셋 없는 시각에 시간대의 오프셋을 붙여 보낸다 — Notion 은 오프셋 없는 시각을 UTC 로 읽는다.
   * 기간은 시작과 끝(짝 키) 중 하나만 바뀌어도 둘을 함께 보낸다 — 날짜 값은 통째로 바뀐다. 글 속성 ·
   * 제목은 원격 서식 위에 바뀐 글자만 고친다(`context.remote`).
   *
   * @param title 제목이 바뀌었을 때만 새 제목, 아니면 null.
   * @returns `skipped` — 바뀌었지만 보내지 않은 속성 이름. 호출측이 알린다.
   */
  toNotionPropertyChanges(
    changes: RowPropertyChanges,
    title: string | null,
    context: PropertyChangeContext = {},
  ): { properties: Record<string, NotionPropertyValue>; skipped: string[] } {
    const zone = this.zone();
    const properties: Record<string, NotionPropertyValue> = {};
    const skipped: string[] = [];
    if (title !== null) {
      const runs = context.remote ? titleRunsOf(context.remote) : null;
      properties.title = {
        title: (runs && patchRichText(runs, title)) ?? [{ text: { content: title } }],
      };
    }

    // 기간은 시작 속성 이름으로 모아 한 번에 — 짝 키는 속성이 아니다.
    const ranges = new Set<string>();
    const rangeOf = (key: string): string | null =>
      this.rangeOwnerOf(key) ?? (this.hasRangeKey(key) ? key : null);

    for (const [key, value] of Object.entries(changes.changed)) {
      const range = rangeOf(key);
      if (range !== null) {
        ranges.add(range);
        continue;
      }
      const schemaProp = this.schema.get(key);
      const converted = !schemaProp
        ? null
        : schemaProp.type === "rich_text"
          ? richTextRequest(String(value), richTextRunsOf(context.remote, key))
          : this.convertBySchema(schemaProp.type, value, zone);
      if (converted) properties[key] = converted;
      else skipped.push(key);
    }
    for (const key of changes.cleared) {
      const range = rangeOf(key);
      if (range !== null) {
        ranges.add(range);
        continue;
      }
      const schemaProp = this.schema.get(key);
      const empty = schemaProp ? emptyValueOf(schemaProp.type) : null;
      if (empty) properties[key] = empty;
      else skipped.push(key);
    }
    for (const name of ranges) {
      const converted = this.rangeRequest(name, context.current ?? changes.changed, zone);
      if (converted) properties[name] = converted;
      else skipped.push(name);
    }

    return { properties, skipped };
  }

  /**
   * 값을 보낼 수 있는 속성만, pull 이 적는 모양으로 — 원격 값과 로컬 값을 견줄 때 쓴다.
   *
   * 고르는 것은 스키마에 있고 읽기 전용이 아니고 제목이 아닌 키와 날짜 속성의 짝 키다. 수식 · 롤업 같은
   * 값은 달라도 보낼 수 없으니 견주지 않는다. 날짜는 예전 버전이 적은 모양(`…+09:00` · `{start, end}`)도
   * 시간대의 벽시계 시각 · 짝 키로 바꿔 같은 순간이면 같게 본다(F-08).
   */
  writableValues(values: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const zone = this.zone();
    const picked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      const type = this.schema.get(key)?.type;
      if (this.rangeOwnerOf(key) !== null) {
        picked[key] = localDateForm(value, zone);
      } else if (type === "date") {
        const plain = plainFrontmatterValue(value);
        if (!isDateRangeValue(plain)) {
          picked[key] = localDateForm(plain, zone);
        } else if (this.hasRangeKey(key) && !(key + RANGE_END_SUFFIX in values)) {
          picked[key] = localDateForm(plain.start, zone);
          if (!isBlank(plain.end)) picked[key + RANGE_END_SUFFIX] = localDateForm(plain.end, zone);
        } else {
          picked[key] = {
            start: localDateForm(plain.start, zone),
            ...(isBlank(plain.end) ? {} : { end: localDateForm(plain.end, zone) }),
          };
        }
      } else if (type && type !== "title" && !READ_ONLY_TYPES.has(type)) {
        picked[key] = value;
      }
    }
    return picked;
  }

  /**
   * `written` 에서 예전 버전이 적은 날짜 모양이 남은 키(F-08) — 날짜 · 생성일 · 수정일 · 날짜 수식 · 날짜
   * 롤업 가운데, 지금 받으면 적을 값과 같은 순간인데 적힌 모양이 다른 것(`…Z` · `…+09:00` · `{start, end}`).
   * 기간은 짝 키(`<이름>_end`)도 함께 — 둘 중 하나라도 적혀 있거나 받으면 적을 키만. 원격이 그대로인 행은
   * 다시 받지 않으므로, 이런 행은 따로 골라 이 키들을 새 모양으로 고쳐 써야 한다.
   *
   * 값이 다른 키는 보지 않는다 — 수식 · 롤업은 행의 수정 시각을 바꾸지 않고 다시 계산되고, 시간대 설정을
   * 바꾸면 벽시계 시각이 달라진다. 모양 때문이 아니다.
   *
   * @param written 행 노트에 적힌 frontmatter.
   * @param notionProps 원격 행의 속성(`page.properties`).
   * @returns 고쳐 쓸 키. 없으면 빈 배열.
   */
  outdatedDateKeys(
    written: Readonly<Record<string, unknown>>,
    notionProps: Record<string, unknown>,
  ): string[] {
    const zone = this.zone();
    const fresh = this.fromNotionProperties(notionProps);
    const keys: string[] = [];
    for (const [key, rawProp] of Object.entries(notionProps)) {
      const type = (rawProp as { type?: string } | null)?.type ?? "";
      if (!DATE_VALUED_TYPES.has(type) && !TIMESTAMP_TYPES.has(type)) continue;
      const endKey = rangeEndKeyOf(key, type, notionProps);
      const pair = (endKey === null ? [key] : [key, endKey]).filter(
        (k) => Object.hasOwn(written, k) || Object.hasOwn(fresh, k),
      );
      // 적히지 않은 키는 null 로 본다.
      const sameForm = pair.every((k) =>
        sameFrontmatterValue(written[k] ?? null, fresh[k] ?? null),
      );
      const sameMoment = sameFrontmatterValue(
        momentForm(spanOf(written, key, endKey), zone),
        momentForm(spanOf(fresh, key, endKey), zone),
      );
      if (!sameForm && sameMoment) keys.push(...pair);
    }
    return keys;
  }

  fromNotionProperties(notionProps: Record<string, unknown>): Record<string, unknown> {
    const zone = this.zone();
    const result: Record<string, unknown> = {};

    for (const [key, rawProp] of Object.entries(notionProps)) {
      const prop = rawProp as { type: string; [k: string]: unknown };
      if (prop.type === "title") continue;
      const value = this.extractValue(prop, zone);
      if (value === undefined) continue;
      const endKey = rangeEndKeyOf(key, prop.type, notionProps);
      if (endKey !== null && isDateRangeValue(value) && value.end != null) {
        result[key] = value.start;
        result[endKey] = value.end;
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * 이 행에서 Notion 이 정하는 frontmatter 키 — {@link fromNotionProperties} 가 적을 수 있는 키 전부다.
   * 값이 비어 적지 않은 속성과 지금은 기간이 아니어서 적지 않은 짝 키도 든다. pull 이 받은 속성을 로컬
   * frontmatter 와 합칠 때 이 밖의 키는 로컬 것으로 둔다.
   */
  ownedKeys(notionProps: Readonly<Record<string, unknown>>): string[] {
    const keys: string[] = [];
    for (const [key, rawProp] of Object.entries(notionProps)) {
      const type = (rawProp as { type?: string } | null)?.type ?? "";
      if (type === "title") continue;
      keys.push(key);
      const endKey = rangeEndKeyOf(key, type, notionProps);
      if (endKey !== null) keys.push(endKey);
    }
    return keys;
  }

  private zone(): string {
    return this.options.timeZone ?? systemTimeZone();
  }

  /** `key` 가 날짜 속성의 짝 키면 그 날짜 속성 이름. */
  private rangeOwnerOf(key: string): string | null {
    if (!key.endsWith(RANGE_END_SUFFIX) || this.schema.has(key)) return null;
    const owner = key.slice(0, -RANGE_END_SUFFIX.length);
    return this.schema.get(owner)?.type === "date" ? owner : null;
  }

  /** 날짜 속성인데 짝 키를 쓰는가 — 같은 이름의 속성이 DB 에 따로 없을 때. */
  private hasRangeKey(name: string): boolean {
    return this.schema.get(name)?.type === "date" && !this.schema.has(name + RANGE_END_SUFFIX);
  }

  /**
   * 짝 키를 쓰는 날짜 속성에 보낼 값 — 시작(`name`)과 끝(`name_end`)을 함께. 둘 다 비었으면 지운다.
   * 끝만 있으면 보낼 수 없다(Notion 의 날짜는 시작이 있어야 한다) — null.
   */
  private rangeRequest(
    name: string,
    values: Readonly<Record<string, unknown>>,
    zone: string,
  ): NotionPropertyValue | null {
    const start = plainFrontmatterValue(values[name]);
    const end = plainFrontmatterValue(values[name + RANGE_END_SUFFIX]);
    if (isBlank(start)) return isBlank(end) ? { date: null } : null;
    return this.convertBySchema("date", isBlank(end) ? start : { start, end }, zone);
  }

  private convertBySchema(type: string, value: unknown, zone: string): NotionPropertyValue | null {
    switch (type) {
      case "rich_text":
        return richTextValue(String(value));

      case "number": {
        // 숫자로 변환 불가한 값(NaN/Infinity)은 전송하지 않는다. {number: NaN} 은
        // JSON 직렬화 시 null 로 바뀌어 기존 값을 소리 없이 비워버린다.
        const num = typeof value === "number" ? value : Number(value);
        return Number.isFinite(num) ? { number: num } : null;
      }

      case "select": {
        // 빈 이름은 Notion API 가 거부한다. 공백뿐이면 스킵(기존 값 보존).
        const name = String(value);
        return name.trim() ? { select: { name } } : null;
      }

      case "multi_select": {
        const items = Array.isArray(value)
          ? value
          : String(value)
              .split(",")
              .map((s) => s.trim());
        // 빈 옵션 이름 제거 — "a,,b" 나 후행 콤마로 생긴 빈 항목은 Notion 이 거부한다.
        const names = items.map((name: unknown) => String(name)).filter((name) => name.trim());
        return { multi_select: names.map((name) => ({ name })) };
      }

      case "checkbox":
        return { checkbox: Boolean(value) };

      case "date": {
        if (typeof value === "object" && value !== null && "start" in value) {
          const obj = value as { start: unknown; end?: unknown };
          const start = dateText(obj.start, zone);
          const end = isBlank(obj.end) ? null : dateText(obj.end, zone);
          if (start === null || (end === null && !isBlank(obj.end))) return null;
          return { date: { start, end } };
        }
        const start = dateText(value, zone);
        return start === null ? null : { date: { start, end: null } };
      }

      case "url":
        return { url: String(value) };

      case "email":
        return { email: String(value) };

      case "phone_number":
        return { phone_number: String(value) };

      case "status": {
        // select 와 동일 — 빈 상태 이름은 Notion 이 거부한다.
        const name = String(value);
        return name.trim() ? { status: { name } } : null;
      }

      case "relation": {
        // 관계 · 사람은 보낸 목록으로 «통째로» 바뀐다. 하나라도 알아보지 못한 채 나머지만
        // 보내면 알아보지 못한 연결이 Notion 에서 지워진다 — 그때는 아무것도 보내지 않는다.
        const items = Array.isArray(value) ? value : [value];
        const ids: Array<{ id: string }> = [];
        for (const item of items) {
          const str = String(item);
          const match = str.match(WIKILINK_REGEX);
          const pageId =
            match?.[1] && this.wikilinkResolver
              ? this.wikilinkResolver.resolve(match[1])
              : isNotionId(str)
                ? str
                : null;
          if (!pageId) return null;
          ids.push({ id: pageId });
        }
        return ids.length > 0 ? { relation: ids } : null;
      }

      case "people": {
        // pull 은 사람을 이름으로 적는다. 이름으로는 사용자를 찾을 수 없으므로 ID 로만 된
        // 목록일 때만 보낸다(관계와 같은 이유).
        const users = (Array.isArray(value) ? value : [value]).map(String);
        if (users.length === 0 || !users.every(isNotionId)) return null;
        return { people: users.map((id) => ({ object: "user" as const, id })) };
      }

      case "files": {
        const fileList = Array.isArray(value) ? value : [value];
        // 로컬 첨부 위키링크([[attachments/..]]) 또는 notion-hosted 서명 URL 이 하나라도
        // 있으면 속성 전체를 전송하지 않는다(P3-A). files 배열은 부분 갱신이 불가능해
        // (전송 시 통째 교체) 일부만 보내면 나머지 첨부가 삭제되고, 서명 URL 을 external
        // 로 되밀면 약 1시간 뒤 만료되는 깨진 파일로 Notion 원본이 오염된다(실측).
        // 미전송 시 Notion 이 기존 첨부를 그대로 보존하므로 이것이 무손실 경로다.
        const urls = fileList.map((f) => {
          if (typeof f === "object" && f !== null && "url" in f) {
            return String((f as { url?: unknown }).url ?? "");
          }
          return String(f);
        });
        const hasProtected = urls.some(
          (u) => WIKILINK_REGEX.test(u.trim()) || isNotionHostedFileUrl(u),
        );
        if (hasProtected) return null;

        // 빈 URL 파일 항목은 Notion 이 거부하므로 제거한다(잘못된 첨부 전송 방지).
        const filesArr = fileList
          .map((f) => {
            if (typeof f === "object" && f !== null && "url" in f) {
              const obj = f as { name?: string; url: string };
              const url = String(obj.url ?? "");
              if (!url) return null;
              return { type: "external", name: obj.name ?? "file", external: { url } };
            }
            const url = String(f);
            if (!url) return null;
            return { type: "external", name: url, external: { url } };
          })
          .filter(Boolean);
        return { files: filesArr };
      }

      default:
        // 읽기 전용 · 제목(따로 보낸다) · 모르는 타입(장소 등)은 보내지 않는다. 글로 바꿔
        // 보내면 타입이 맞지 않아 요청 전체가 거부된다.
        return null;
    }
  }

  private inferAndConvert(value: unknown, zone: string): NotionPropertyValue | null {
    if (typeof value === "boolean") {
      return { checkbox: value };
    }
    if (typeof value === "number") {
      return { number: value };
    }
    if (Array.isArray(value)) {
      return {
        multi_select: value.map((v) => ({ name: String(v) })),
      };
    }
    if (typeof value === "string") {
      const start = dateText(value, zone);
      if (start !== null) {
        return { date: { start, end: null } };
      }
      if (value.startsWith("http://") || value.startsWith("https://")) {
        return { url: value };
      }
      return richTextValue(value);
    }
    return null;
  }

  private extractValue(prop: { type: string; [k: string]: unknown }, zone: string): unknown {
    switch (prop.type) {
      case "rich_text": {
        const arr = asArray<{ plain_text: string }>(prop.rich_text);
        return arr.map((t) => t.plain_text).join("") || null;
      }
      case "number":
        return prop.number;
      case "select": {
        const sel = prop.select as { name: string } | null;
        return sel?.name ?? null;
      }
      case "multi_select": {
        return asArray<{ name: string }>(prop.multi_select).map((s) => s.name);
      }
      case "checkbox":
        return prop.checkbox;
      case "date":
        return dateValue(prop.date, zone);
      case "url":
        return prop.url;
      case "email":
        return prop.email;
      case "phone_number":
        return prop.phone_number;
      case "status": {
        const status = prop.status as { name: string } | null;
        return status?.name ?? null;
      }
      case "created_time":
      case "last_edited_time": {
        const time = prop[prop.type];
        return typeof time === "string" ? toWallTime(time, zone) : null;
      }
      case "people": {
        return asArray<{ name?: string; id: string }>(prop.people).map((p) => p.name ?? p.id);
      }
      case "files": {
        const files = asArray<{
          name: string;
          type: string;
          file?: { url: string };
          external?: { url: string };
        }>(prop.files);
        // Obsidian Bases 의 카드 `image:` 는 스칼라 문자열(외부 URL 또는 [[wikilink]])만
        // 렌더한다 — [{name,url}] 객체 배열은 표시되지 않는다. 따라서 URL 문자열로 직렬화한다.
        // 단일 파일 → 스칼라(갤러리 커버 렌더), 복수 → URL 배열(데이터 보존).
        // toNotionProperties 의 files 케이스가 문자열/문자열배열을 모두 받으므로 라운드트립 안전.
        const urls = files
          .map((f) => (f.type === "file" ? f.file?.url : f.external?.url))
          .filter((u): u is string => typeof u === "string" && u.length > 0);
        if (urls.length === 0) return [];
        return urls.length === 1 ? urls[0] : urls;
      }
      case "formula": {
        const formula = prop.formula as { type: string; [k: string]: unknown } | undefined;
        if (!formula) return null;
        if (formula.type === "date") return dateValue(formula.date, zone);
        return formula[formula.type];
      }
      case "relation": {
        const rel = asArray<{ id: string }>(prop.relation);
        if (rel.length === 0) return [];
        return rel.map((r) => {
          if (this.wikilinkResolver) {
            const title = this.wikilinkResolver.resolvePageId(r.id);
            if (title) return `[[${title}]]`;
          }
          return r.id;
        });
      }
      case "rollup": {
        const rollup = prop.rollup as { type: string; [k: string]: unknown } | undefined;
        if (!rollup) return null;
        if (rollup.type === "array") {
          const arr = asArray<{ type: string; [k: string]: unknown }>(rollup.array);
          return arr.map((item) => this.extractValue(item, zone));
        }
        if (rollup.type === "date") return dateValue(rollup.date, zone);
        return rollup[rollup.type] ?? null;
      }
      case "unique_id": {
        const uid = prop.unique_id as { prefix?: string; number?: number } | undefined;
        // number 가 없으면(빈 객체 등) "undefined" 문자열이 새는 것을 막는다.
        if (!uid || typeof uid.number !== "number") return null;
        return uid.prefix ? `${uid.prefix}-${uid.number}` : String(uid.number);
      }
      case "created_by":
      case "last_edited_by": {
        const user = prop[prop.type] as { name?: string; id: string } | undefined;
        return user?.name ?? user?.id ?? null;
      }
      case "verification": {
        const v = prop.verification as { state: string } | undefined;
        return v?.state ?? null;
      }
      default:
        return null;
    }
  }
}

/** 날짜(시각) 값 — 기간이면 끝까지. */
interface DateRangeValue {
  start: unknown;
  end?: unknown;
}

function isDateRangeValue(value: unknown): value is DateRangeValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "start" in value;
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && !value.trim());
}

/**
 * 날짜 속성 값의 짝 키 — 날짜 값을 낼 수 있는 속성이고, 같은 이름의 속성이 따로 없을 때.
 * `properties` 는 그 행의 속성 전부(`page.properties`)다.
 */
function rangeEndKeyOf(
  name: string,
  type: string,
  properties: Readonly<Record<string, unknown>>,
): string | null {
  if (!DATE_VALUED_TYPES.has(type)) return null;
  const endKey = name + RANGE_END_SUFFIX;
  return endKey in properties ? null : endKey;
}

/**
 * Notion 의 날짜 값(`{start, end, time_zone}`)을 볼트에 적을 모양으로 — 시각은 시간대의 벽시계 시각.
 * 끝이 있으면 `{start, end}`, 없으면 시작 글자. 비었으면 null.
 */
function dateValue(date: unknown, zone: string): string | { start: string; end: string } | null {
  const value = date as { start?: unknown; end?: unknown } | null | undefined;
  if (typeof value?.start !== "string" || !value.start) return null;
  const start = toWallTime(value.start, zone);
  return typeof value.end === "string" && value.end
    ? { start, end: toWallTime(value.end, zone) }
    : start;
}

/**
 * 로컬 날짜 값을 pull 이 적는 모양으로 — 오프셋이 붙은 시각은 시간대의 벽시계 시각, YAML 이 읽은 날짜는
 * 적힌 글자. 날짜가 아니면 그대로.
 */
function localDateForm(value: unknown, zone: string): unknown {
  const plain = plainFrontmatterValue(value);
  return typeof plain === "string" ? toWallTime(plain, zone) : plain;
}

/**
 * 날짜 키와 그 짝 키에 적힌 값을 기간 하나로 — 예전 모양(`{start, end}` 객체 · 수식의 `time_zone` 이 붙은
 * 객체)과 짝 키를 같은 모양으로 편다. 짝 키를 쓰지 않는 속성이면 `endKey` 가 null.
 */
function spanOf(
  values: Readonly<Record<string, unknown>>,
  key: string,
  endKey: string | null,
): { start: unknown; end: unknown } {
  const value = plainFrontmatterValue(values[key]);
  if (isDateRangeValue(value)) return { start: value.start, end: value.end };
  return { start: value, end: endKey === null ? null : values[endKey] };
}

/** 날짜 값을 같은 순간이면 같은 모양으로 — 시각은 시간대의 벽시계 시각, 목록 · 기간은 안쪽까지. */
function momentForm(value: unknown, zone: string): unknown {
  const plain = plainFrontmatterValue(value);
  if (Array.isArray(plain)) return plain.map((item) => momentForm(item, zone));
  if (isDateRangeValue(plain)) {
    return {
      start: momentForm(plain.start, zone),
      end: isBlank(plain.end) ? null : momentForm(plain.end, zone),
    };
  }
  return localDateForm(plain, zone) ?? null;
}

/**
 * 날짜 속성에 보낼 글자 — 오프셋 없는 시각에는 시간대의 오프셋을 붙인다. 날짜로 읽을 수 없으면 null.
 */
function dateText(value: unknown, zone: string): string | null {
  const text = String(plainFrontmatterValue(value));
  if (!DATE_REGEX.test(text)) return null;
  return isWallTime(text) ? toZonedIso(text, zone) : text;
}

/** 원격 행의 제목 조각들 — 제목 타입 속성. */
function titleRunsOf(remote: Readonly<Record<string, unknown>>): RichTextItem[] | null {
  for (const prop of Object.values(remote)) {
    const value = prop as { type?: string; title?: unknown } | null;
    if (value?.type === "title") return Array.isArray(value.title) ? value.title : null;
  }
  return null;
}

/** 원격 행의 글 속성 조각들. 그 속성이 글 속성이 아니거나 없으면 null. */
function richTextRunsOf(
  remote: Readonly<Record<string, unknown>> | undefined,
  key: string,
): RichTextItem[] | null {
  const value = remote?.[key] as { type?: string; rich_text?: unknown } | undefined;
  return value?.type === "rich_text" && Array.isArray(value.rich_text) ? value.rich_text : null;
}

/** 글 속성에 보낼 값 — 원격 조각이 있으면 그 서식 위에 바뀐 글자만 고친다. */
function richTextRequest(text: string, runs: RichTextItem[] | null): NotionPropertyValue | null {
  const patched = runs ? patchRichText(runs, text) : null;
  return patched ? { rich_text: patched } : richTextValue(text);
}

/**
 * 글 속성 값. 긴 글은 rich text 객체 여럿에 나눠 담는다({@link richTextChunks}) — 한 덩어리로 보내면
 * Notion 이 행의 속성 갱신 전체를 거부한다. 나눠도 담을 수 없을 만큼 길면 null(보내지 않음).
 */
function richTextValue(text: string): NotionPropertyValue | null {
  const chunks = richTextChunks(text);
  if (chunks === null) return null;
  return { rich_text: chunks.map((content) => ({ text: { content } })) };
}

/** 비운 속성에 보낼 빈 값. 비울 수 없거나 비우면 안 되는 타입은 null. */
function emptyValueOf(type: string): NotionPropertyValue | null {
  switch (type) {
    case "rich_text":
      return { rich_text: [] };
    case "number":
      return { number: null };
    case "select":
      return { select: null };
    case "multi_select":
      return { multi_select: [] };
    case "date":
      return { date: null };
    case "checkbox":
      return { checkbox: false };
    case "url":
      return { url: null };
    case "email":
      return { email: null };
    case "phone_number":
      return { phone_number: null };
    case "relation":
      return { relation: [] };
    case "people":
      return { people: [] };
    default:
      // files — 올라간 첨부를 지운다(볼트에는 그 파일이 없다) · status — 빈 값이 없다 ·
      // 수식 · 롤업 · 생성일 등 — 읽기 전용.
      return null;
  }
}
