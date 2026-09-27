import { RICH_TEXT_ARRAY_MAX, RICH_TEXT_CONTENT_MAX } from "../constants/notion-limits.js";
import type { RowPropertyChanges } from "../types/sync.js";
import { plainFrontmatterValue } from "../utils/frontmatter.js";
import { isNotionId } from "../utils/id.js";
import { isNotionHostedFileUrl } from "../utils/notion-file-url.js";

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

export class PropertyMapper {
  private schema: Map<string, NotionPropertySchema> = new Map();
  private wikilinkResolver: WikilinkResolver | null = null;

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
    const result: Record<string, NotionPropertyValue> = {
      title: { title: [{ text: { content: title } }] },
    };

    for (const [key, raw] of Object.entries(frontmatter)) {
      if (key === "title") continue;
      const value = plainFrontmatterValue(raw);
      if (value === null || value === undefined) continue;

      const schemaProp = this.schema.get(key);
      if (schemaProp) {
        const converted = this.convertBySchema(schemaProp.type, value);
        if (converted) result[key] = converted;
      } else if (this.schema.size === 0) {
        const inferred = this.inferAndConvert(value);
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
   * @param title 제목이 바뀌었을 때만 새 제목, 아니면 null.
   * @returns `skipped` — 바뀌었지만 보내지 않은 속성 이름. 호출측이 알린다.
   */
  toNotionPropertyChanges(
    changes: RowPropertyChanges,
    title: string | null,
  ): { properties: Record<string, NotionPropertyValue>; skipped: string[] } {
    const properties: Record<string, NotionPropertyValue> = {};
    const skipped: string[] = [];
    if (title !== null) properties.title = { title: [{ text: { content: title } }] };

    for (const [key, value] of Object.entries(changes.changed)) {
      const schemaProp = this.schema.get(key);
      const converted = schemaProp ? this.convertBySchema(schemaProp.type, value) : null;
      if (converted) properties[key] = converted;
      else skipped.push(key);
    }
    for (const key of changes.cleared) {
      const schemaProp = this.schema.get(key);
      const empty = schemaProp ? emptyValueOf(schemaProp.type) : null;
      if (empty) properties[key] = empty;
      else skipped.push(key);
    }

    return { properties, skipped };
  }

  /**
   * 값을 보낼 수 있는 속성만 고른다 — 스키마에 있고, 읽기 전용이 아니고, 제목이 아닌 키.
   * 원격 값과 로컬 값을 견줄 때 쓴다. 수식 · 롤업 같은 값은 달라도 보낼 수 없으니 견주지 않는다.
   */
  pickWritable(values: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const picked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      const type = this.schema.get(key)?.type;
      if (type && type !== "title" && !READ_ONLY_TYPES.has(type)) picked[key] = value;
    }
    return picked;
  }

  fromNotionProperties(notionProps: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, rawProp] of Object.entries(notionProps)) {
      const prop = rawProp as { type: string; [k: string]: unknown };
      if (prop.type === "title") continue;
      const value = this.extractValue(prop);
      if (value !== undefined) {
        result[key] = value;
      }
    }

    return result;
  }

  private convertBySchema(type: string, value: unknown): NotionPropertyValue | null {
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
          const obj = value as { start: string; end?: string | null };
          return { date: { start: obj.start, end: obj.end ?? null } };
        }
        const dateStr = String(value);
        if (DATE_REGEX.test(dateStr)) {
          return { date: { start: dateStr, end: null } };
        }
        return null;
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

  private inferAndConvert(value: unknown): NotionPropertyValue | null {
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
      if (DATE_REGEX.test(value)) {
        return { date: { start: value, end: null } };
      }
      if (value.startsWith("http://") || value.startsWith("https://")) {
        return { url: value };
      }
      return richTextValue(value);
    }
    return null;
  }

  private extractValue(prop: { type: string; [k: string]: unknown }): unknown {
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
      case "date": {
        const dateObj = prop.date as { start: string; end?: string | null } | null;
        if (!dateObj) return null;
        if (dateObj.end) return { start: dateObj.start, end: dateObj.end };
        return dateObj.start;
      }
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
        return prop.created_time;
      case "last_edited_time":
        return prop.last_edited_time;
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
          return arr.map((item) => this.extractValue(item));
        }
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

/**
 * 글 속성 값. rich text 객체 하나는 2,000자까지라 긴 글은 나눠 담는다 — 한 덩어리로 보내면
 * Notion 이 행의 속성 갱신 전체를 거부한다. 나눠도 담을 수 없을 만큼 길면 null(보내지 않음).
 * 서로게이트 쌍(이모지 등)은 가르지 않는다.
 */
function richTextValue(text: string): NotionPropertyValue | null {
  const chunks: string[] = [];
  let chunk = "";
  for (const char of text) {
    if (chunk.length + char.length > RICH_TEXT_CONTENT_MAX) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  if (chunks.length > RICH_TEXT_ARRAY_MAX) return null;
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
